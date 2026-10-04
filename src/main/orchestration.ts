// 오케스트레이션 실행기. Run 별 JSONL(도메인 이벤트)이 원본이고 메모리 상태는 그 재생이다.
// 기록 순서: 검증 → 영속(appendFileSync) → 메모리 반영 → 응답·알림. 대기(ask·check --wait)는 메모리의 waiter 로, 연결이 끊기면 waiter 만 지운다.
// 탭·세션·worktree 는 deps 로 위임해 테스트는 가짜 deps 로 돈다.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatEvent, PermissionPolicy, SessionStatus } from "@shared/chat-events";
import type { ChatSendResult, Provider } from "@shared/ipc";
import type { WorktreeMeta } from "@shared/workspace-model";
import type { MsgKey } from "@shared/i18n/msg";
import { appMsg, mainI18n, mt } from "./i18n";
import {
  ORCH_MAX_AI_COORDINATORS,
  ORCH_MAX_DELIVERY,
  attention,
  buildWorkerPrompt,
  isOpenDispatch,
  pendingDelivery,
  readyTasks,
  resolveGroup,
  taskBlockers,
  reduceRun,
  replayRun,
  undeliveredInbox,
  undeliveredFollowups,
  unreadFollowups,
  validateSpec,
  type OrchActor,
  type OrchDelivery,
  type OrchDispatch,
  type OrchEvent,
  type OrchExecutionState,
  type OrchGate,
  type OrchMessage,
  type OrchRun,
  type OrchRunState,
  type OrchTask,
} from "@shared/orchestration";

export class OrchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface WorkerTabSnapshot {
  status: SessionStatus;
  limitWait: boolean;
  pendingPermissions: number;
  /** 지금까지 기록된 이벤트 수(턴 종료 감지: since 이후 turn_result). */
  eventCount: number;
  turnedSince(since: number): boolean;
}

export interface OrchestratorDeps {
  dir: string;
  /** preamble 에 적을 CLI 이름(설치돼 있으면 "sudal", 아니면 전체 경로). */
  cliCommand(): string;
  now?(): number;
  log?(line: string): void;
  /** 워커 탭을 만든다(워크스페이스는 코디네이터 탭의 것 또는 지정). worktree=true 면 격리. */
  createWorkerTab(o: { title: string; provider: Provider; model?: string; policy: PermissionPolicy; cwd: string; worktree: boolean; workspaceId?: string }): Promise<
    { ok: true; tabId: string; cwd: string; worktree?: WorktreeMeta } | { ok: false; error: string; stage: "creating_workspace" | "creating_tab" }
  >;
  send(tabId: string, text: string): Promise<ChatSendResult>;
  snapshot(tabId: string): WorkerTabSnapshot | null;
  abort(tabId: string): void;
  /** 기존 탭 정보(--terminal 재사용용). 없으면 null. */
  tabInfo(tabId: string): { provider: Provider; cwd: string | null; worktree?: WorktreeMeta; model?: string; policy: PermissionPolicy } | null;
  /** 정산된 워커의 탭을 닫고 worktree 를 지운다(강제). 내부에서 실행 여부를 다시 확인한다. */
  cleanupWorker(tabId: string, worktree?: WorktreeMeta): Promise<{ tabClosed: boolean; worktreeRemoved: boolean; error?: string }>;
  /** 재사용 탭에 이번 시도의 정책·모델을 실제로 적용한다. */
  configureTab(tabId: string, patch: { policy: PermissionPolicy; model?: string }): void;
  /** 이 경로를 작업 경로로 쓰는 다른 탭들(worktree 삭제 전 확인). */
  tabsUsingCwd(path: string, exceptTabId: string): string[];
  tabCwd(tabId: string): string | null;
  maxConcurrent(): number;
  /** 활성 Run 의 코디네이터 탭 목록이 바뀌었다 — 동시 작업 수에서 빼 준다. */
  setCoordinatorTabs?(tabIds: string[]): void;
  /** 상태가 바뀌었다(UI 갱신·카드). */
  onChanged?(runId: string, state: OrchRunState, event: OrchEvent): void;
}

interface Waiter<T> {
  resolve(v: T): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const CARD_SILENT: OrchEvent["type"][] = ["dispatch_check", "delivery_created", "delivery_acked"];

export class Orchestrator {
  private runs = new Map<string, OrchRunState>();
  private askWaiters = new Map<string, Set<Waiter<{ answered: boolean; answer?: OrchMessage["answer"] }>>>();
  private inboxWaiters = new Map<string, Set<Waiter<boolean> & { types: Set<string> | null }>>();
  private permissionNoted = new Set<string>();
  private missingNoted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 부분 기록이 의심되는 Run — 재시작 전까지 쓰기를 막는다(원본과 메모리가 어긋난 채 계속 쓰지 않게). */
  private storageBroken = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {
    fs.mkdirSync(deps.dir, { recursive: true });
    this.load();
    // 복원한 Run 에 감독 중인 시도가 있으면 관측을 바로 시작한다
    if ([...this.runs.values()].some((s) => s.run.status === "active" && s.dispatches.some(isOpenDispatch))) this.ensureMonitor();
    this.syncCoordinatorTabs();
  }

  private syncCoordinatorTabs() {
    // 워커가 실제로 감독 중일 때만 예외 — 워커 없이 코디네이터가 일반 턴을 돌리면 상한을 그대로 따른다
    const ids = [...this.runs.values()].filter((s) => s.run.status === "active" && s.run.coordinator.kind === "tab" && s.run.coordinator.tabId && s.dispatches.some(isOpenDispatch)).map((s) => s.run.coordinator.tabId!);
    try {
      this.deps.setCoordinatorTabs?.(ids);
    } catch {
      /* 무시 */
    }
  }

  /** 어떤 활성 Run 에서든 감독 중인 시도의 탭인가(워커 탭 — 완료 알림 억제·재사용 금지). */
  isSupervisedTab(tabId: string): boolean {
    return [...this.runs.values()].some((s) => s.run.status === "active" && s.dispatches.some((d) => d.tabId === tabId && isOpenDispatch(d)));
  }

  isCoordinatorTab(tabId: string): boolean {
    return [...this.runs.values()].some((s) => s.run.status === "active" && s.run.coordinator.kind === "tab" && s.run.coordinator.tabId === tabId);
  }

  private cleaning = new Set<string>();

  hasActiveAiRun(): boolean {
    return [...this.runs.values()].some((s) => s.run.status === "active" && s.run.coordinator.kind === "tab");
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ===== 영속 =====
  private file(runId: string): string {
    return path.join(this.deps.dir, `${runId}.jsonl`);
  }

  private load() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.deps.dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const f of names) {
      try {
        const file = path.join(this.deps.dir, f);
        const raw = fs.readFileSync(file, "utf8");
        // 마지막 줄이 잘려 있으면(개행 없음 또는 JSON 아님) 그 조각을 잘라내고 파일을 정상 경계까지로 되돌린다 — 다음 append 가 조각에 붙지 않게
        const events: OrchEvent[] = [];
        let good = 0;
        const parts = raw.split("\n");
        for (let i = 0; i < parts.length; i++) {
          const l = parts[i];
          if (!l) {
            if (i < parts.length - 1) good += 1;
            continue;
          }
          const complete = i < parts.length - 1;
          try {
            const e = JSON.parse(l) as OrchEvent;
            if (!complete) throw new Error("no newline");
            events.push(e);
            good += l.length + 1;
          } catch {
            this.deps.log?.(`[orch] ${f}: 잘린 마지막 줄 ${l.length}자를 버립니다`);
            break;
          }
        }
        if (good < raw.length) fs.writeFileSync(file, raw.slice(0, good), "utf8");
        const repaired = repairBatches(events);
        const s = replayRun(repaired.events);
        if (s) {
          // 복구 이벤트를 먼저 영속한다 — 실패하면 상태는 보이되 쓰기는 봉인(재시작 때 다시 시도)
          if (repaired.added.length) {
            try {
              fs.appendFileSync(file, repaired.added.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
            } catch (err) {
              this.storageBroken.add(s.run.id);
              this.deps.log?.(`[orch] ${f}: 복구 기록 실패, 쓰기 봉인: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          this.runs.set(s.run.id, s);
        }
      } catch (e) {
        this.deps.log?.(`[orch] ${f} 읽기 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 검증이 끝난 이벤트를 영속하고 메모리에 반영한다. 저장 실패면 상태를 바꾸지 않고 던진다. */
  private commit(runId: string, ...events: OrchEvent[]): OrchRunState {
    let s = this.runs.get(runId);
    if (!s && events[0]?.type !== "run_created") throw new OrchError(mt("cli.orch.error.runNotFound"), "not_found");
    if (this.storageBroken.has(runId)) throw new OrchError(mt("cli.orch.error.storageBroken"), "storage_failed");
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const file = this.file(runId);
    let before = 0;
    try {
      before = fs.existsSync(file) ? fs.statSync(file).size : 0;
      fs.appendFileSync(file, lines, "utf8");
    } catch (e) {
      // 일부만 써졌을 수 있다 — 경계가 깨졌으면 이 Run 은 재시작 전까지 봉인
      try {
        if (fs.existsSync(file) && fs.statSync(file).size !== before) this.storageBroken.add(runId);
      } catch {
        this.storageBroken.add(runId);
      }
      throw new OrchError(mt("cli.orch.error.writeFailed", { detail: e instanceof Error ? e.message : String(e) }), "storage_failed");
    }
    for (const e of events) {
      if (e.type === "run_created") s = { run: e.run, tasks: [], dispatches: [], messages: [], deliveries: [], gates: [], deliveredSeq: 0, revision: 0 };
      else s = reduceRun(s!, e);
    }
    this.runs.set(runId, s!);
    // 영속·반영이 끝났으니 먼저 waiter 를 깨우고, UI 알림은 실패해도 상태에 영향이 없게 격리한다
    for (const e of events) {
      if (e.type === "message" && e.message.to === "run") this.wakeInbox(runId, e.message.type);
      if (e.type === "question_answered") this.wakeAsk(e.questionId, e.answer);
      if (e.type === "coordinator_changed") this.wakeInbox(runId, "*");
    }
    if (events.some((e) => e.type === "run_created" || e.type === "coordinator_changed" || e.type === "run_closed" || e.type === "dispatch_created" || e.type === "dispatch_stage" || e.type === "dispatch_settled" || e.type === "dispatch_abandoned" || e.type === "dispatch_start_cancelled")) this.syncCoordinatorTabs();
    for (const e of events) {
      try {
        this.deps.onChanged?.(runId, s!, e);
      } catch (err) {
        this.deps.log?.(`[orch] onChanged 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return s!;
  }

  // ===== 조회 =====
  list(): OrchRunState[] {
    return [...this.runs.values()].sort((a, b) => b.run.createdAt - a.run.createdAt);
  }

  get(runId: string): OrchRunState {
    const s = this.runs.get(runId);
    if (!s) throw new OrchError(mt("cli.orch.error.runRecordNotFound", { id: runId }), "not_found");
    return s;
  }

  static isCardEvent(e: OrchEvent): boolean {
    return !CARD_SILENT.includes(e.type);
  }

  // ===== 권한 =====
  private requireCoordinator(s: OrchRunState, key: string | undefined, actor: OrchActor): void {
    if (actor.kind === "user") return; // UI(사람)는 항상 코디네이터로 인정 — 인수는 takeover 로 명시
    if (!key) throw new OrchError(mt("cli.orch.error.keyRequired"), "unauthorized");
    if (key !== s.run.coordinator.key) throw new OrchError(mt("cli.orch.error.keyFenced"), "consumer_fenced", { epoch: s.run.coordinator.epoch });
  }

  private requireDispatch(s: OrchRunState, dispatchId: string | undefined, capability: string | undefined): OrchDispatch {
    if (!dispatchId) throw new OrchError(mt("cli.orch.error.dispatchRequired"), "bad_request");
    const d = s.dispatches.find((x) => x.id === dispatchId);
    if (!d) throw new OrchError(mt("cli.orch.error.dispatchNotFound", { id: dispatchId }), "not_found");
    if (!capability || capability !== d.capability) throw new OrchError(mt("cli.orch.error.capabilityMismatch"), "consumer_fenced", { dispatchId });
    return d;
  }

  // ===== Run / Task =====
  runCreate(o: { objective: string; coordinatorTabId?: string | null; createdBy?: OrchActor }): { run: OrchRun; coordinatorKey: string } {
    const objective = o.objective.trim();
    if (!objective) throw new OrchError(mt("cli.orch.error.objectiveEmpty"), "bad_request");
    if (o.coordinatorTabId) {
      // 워커 탭이 자기 Run 을 만드는 것(중첩)은 지원하지 않는다 — 상한 검사보다 먼저, 이유가 정확히 전달되게
      const nestedFirst = this.list().some((r) => r.run.status === "active" && r.dispatches.some((d) => d.tabId === o.coordinatorTabId && isOpenDispatch(d)));
      if (nestedFirst) throw new OrchError(mt("cli.orch.error.nestedRun"), "nested_run");
      if (this.isCoordinatorTab(o.coordinatorTabId)) throw new OrchError(mt("cli.orch.error.alreadyCoordinator"), "limit");
      const aiRuns = this.list().filter((r) => r.run.status === "active" && r.run.coordinator.kind === "tab");
      if (aiRuns.length >= ORCH_MAX_AI_COORDINATORS)
        throw new OrchError(mt("cli.orch.error.aiRunLimit", { count: ORCH_MAX_AI_COORDINATORS, running: aiRuns.map((r) => r.run.id).join(", ") }), "limit");
    }
    const key = randomUUID();
    const run: OrchRun = {
      id: `run-${randomUUID().slice(0, 8)}`,
      objective,
      createdAt: this.now(),
      createdBy: o.createdBy ?? (o.coordinatorTabId ? { kind: "tab", tabId: o.coordinatorTabId } : { kind: "user" }),
      coordinator: o.coordinatorTabId ? { kind: "tab", tabId: o.coordinatorTabId, epoch: 1, key } : { kind: "user", epoch: 1, key },
      status: "active",
    };
    this.commit(run.id, { type: "run_created", ts: run.createdAt, run });
    this.ensureMonitor();
    return { run, coordinatorKey: key };
  }

  taskCreate(o: { runId: string; spec: unknown; key?: string; actor: OrchActor; deps?: string[] }): OrchTask {
    const s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    if (s.run.status !== "active") throw new OrchError(mt("cli.orch.error.runClosed"), "closed");
    const v = validateSpec(mt, o.spec);
    if (!v.ok) throw new OrchError(v.error, "bad_request");
    const deps = [...new Set(o.deps ?? [])];
    for (const id of deps) if (!s.tasks.some((t) => t.id === id)) throw new OrchError(mt("cli.orch.error.depNotFound", { id }), "not_found");
    const task: OrchTask = { id: `task-${randomUUID().slice(0, 8)}`, runId: s.run.id, seq: s.tasks.length + 1, spec: v.spec, createdAt: this.now(), status: "pending", activeDispatchId: null, attempts: 0, deps };
    this.commit(s.run.id, { type: "task_created", ts: task.createdAt, task });
    return task;
  }

  // ===== 게이트(코디네이터 소유 DAG 결정) =====
  gateCreate(o: { runId: string; actor: OrchActor; key?: string; taskId: string; question: string; options: string[] }): OrchGate {
    const s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    const task = s.tasks.find((t) => t.id === o.taskId);
    if (!task) throw new OrchError(mt("cli.orch.error.taskNotFound", { id: o.taskId }), "not_found");
    if (task.status !== "pending") throw new OrchError(mt("cli.orch.error.gateTaskStarted"), "conflict");
    const question = o.question.trim();
    if (!question) throw new OrchError(mt("cli.orch.error.questionEmpty"), "bad_request");
    const options = o.options.map((x) => x.trim()).filter(Boolean).slice(0, 8);
    if (options.length < 2) throw new OrchError(mt("cli.orch.error.optionsMin"), "bad_request");
    const gate: OrchGate = { id: `gate-${randomUUID().slice(0, 8)}`, runId: s.run.id, taskId: task.id, question, options, createdAt: this.now() };
    this.commit(s.run.id, { type: "gate_created", ts: gate.createdAt, gate });
    return gate;
  }

  gateResolve(o: { runId: string; actor: OrchActor; key?: string; gateId: string; resolution: string }): OrchGate {
    const s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    const g = s.gates.find((x) => x.id === o.gateId);
    if (!g) throw new OrchError(mt("cli.orch.error.gateNotFound", { id: o.gateId }), "not_found");
    const choice = o.resolution.trim();
    if (g.resolution) {
      if (g.resolution.choice === choice) return g;
      throw new OrchError(mt("cli.orch.error.gateAlreadyResolved", { choice: g.resolution.choice }), "conflict");
    }
    if (!g.options.includes(choice)) throw new OrchError(mt("cli.orch.error.choiceInvalid", { choice, options: g.options.join(", ") }), "bad_request");
    this.commit(s.run.id, { type: "gate_resolved", ts: this.now(), gateId: g.id, resolution: { choice, by: o.actor, at: this.now() } }, this.appNote(s.run.id, "gate_resolved", "cli.msg.gateResolved", { question: g.question, choice, taskId: g.taskId }, g.taskId));
    return this.get(o.runId).gates.find((x) => x.id === g.id)!;
  }

  taskList(runId: string, opts: { ready?: boolean } = {}): (OrchTask & { blockers: { unmetDeps: string[]; pendingGates: string[] } })[] {
    const s = this.get(runId);
    const list = opts.ready ? readyTasks(s) : s.tasks;
    return list.map((t) => {
      const b = taskBlockers(s, t);
      return { ...t, blockers: { unmetDeps: b.unmetDeps, pendingGates: b.pendingGates.map((g) => g.id) } };
    });
  }

  /** 정산·포기·시작 실패한 워커의 탭을 닫고 worktree 를 지운다. 감독 해제(release)와 별개의 명시적 정리. */
  async workerCleanup(o: { runId: string; actor: OrchActor; key?: string; dispatchId: string }): Promise<Record<string, unknown>> {
    const s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    const d = s.dispatches.find((x) => x.id === o.dispatchId);
    if (!d) throw new OrchError(mt("cli.orch.error.dispatchNotFound", { id: o.dispatchId }), "not_found");
    if (isOpenDispatch(d)) throw new OrchError(mt("cli.orch.error.cleanupOpen"), "not_settled");
    if (d.ownership === "retained") throw new OrchError(mt("cli.orch.error.cleanupRetained"), "retained");
    if (d.cleaned) return this.workerShow(o.runId, o.dispatchId);
    if (!d.tabId) throw new OrchError(mt("cli.orch.error.cleanupNoTab"), "nothing_to_clean");
    if (this.isSupervisedTab(d.tabId)) throw new OrchError(mt("cli.orch.error.cleanupTabInUse"), "conflict");
    if (d.worktree) {
      const others = this.deps.tabsUsingCwd(d.worktree.path, d.tabId);
      if (others.length) throw new OrchError(mt("cli.orch.error.cleanupWorktreeInUse", { count: others.length }), "worktree_in_use", { tabs: others });
    }
    if (this.cleaning.has(d.tabId)) throw new OrchError(mt("cli.orch.error.cleanupBusy"), "conflict");
    this.cleaning.add(d.tabId);
    try {
      const snap = this.deps.snapshot(d.tabId);
      if (snap && (snap.status === "running" || snap.status === "queued" || snap.status === "waiting_permission")) throw new OrchError(mt("cli.orch.error.cleanupStillRunning"), "still_live");
      const r = await this.deps.cleanupWorker(d.tabId, d.worktree);
      if (r.error) throw new OrchError(r.error, "cleanup_failed");
      this.commit(s.run.id, { type: "dispatch_cleaned", ts: this.now(), dispatchId: d.id, tabClosed: r.tabClosed, worktreeRemoved: r.worktreeRemoved });
    } finally {
      this.cleaning.delete(d.tabId);
    }
    return this.workerShow(o.runId, o.dispatchId);
  }

  // ===== 워커 시작 =====
  async workerStart(o: {
    runId: string;
    key?: string;
    actor: OrchActor;
    taskId?: string;
    spec?: unknown;
    provider: Provider;
    model?: string;
    policy?: PermissionPolicy;
    cwd?: string;
    worktree: boolean;
    requestId?: string;
    /** 정산된 워커의 탭을 다시 쓴다(같은 provider·경로). 새 탭을 만들지 않는다. */
    terminalTabId?: string;
    deps?: string[];
  }): Promise<{ task: OrchTask; dispatch: OrchDispatch; receipt: { stages: string[]; failedStage?: string; residualResources?: Record<string, unknown>; idempotent?: boolean } }> {
    let s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    if (s.run.status !== "active") throw new OrchError(mt("cli.orch.error.runClosed"), "closed");
    // 멱등: 같은 requestId 로 이미 만든 Dispatch 가 있으면 그것을 돌려준다
    if (o.requestId) {
      const prev = s.dispatches.find((d) => d.requestId === o.requestId);
      if (prev) return { task: s.tasks.find((t) => t.id === prev.taskId)!, dispatch: prev, receipt: { stages: [prev.startStage], idempotent: true } };
    }
    let task: OrchTask;
    if (o.taskId) {
      const t = s.tasks.find((x) => x.id === o.taskId);
      if (!t) throw new OrchError(mt("cli.orch.error.taskNotFound", { id: o.taskId }), "not_found");
      if (t.activeDispatchId) throw new OrchError(mt("cli.orch.error.taskHasActiveDispatch", { id: t.activeDispatchId }), "conflict");
      if (t.status === "succeeded") throw new OrchError(mt("cli.orch.error.taskSucceeded"), "conflict");
      task = t;
    } else {
      task = this.taskCreate({ runId: o.runId, spec: o.spec, key: o.key, actor: o.actor, deps: o.deps });
      s = this.get(o.runId);
    }
    const blockers = taskBlockers(s, task);
    if (blockers.unmetDeps.length) throw new OrchError(mt("cli.orch.error.depsUnmet", { deps: blockers.unmetDeps.join(", ") }), "deps_unmet", { unmetDeps: blockers.unmetDeps });
    if (blockers.pendingGates.length) throw new OrchError(mt("cli.orch.error.gatesPending", { gates: blockers.pendingGates.map((g) => `${g.id}(${g.question})`).join("; ") }), "gate_pending", { gates: blockers.pendingGates.map((g) => g.id) });
    let reuse: { provider: Provider; cwd: string; worktree?: WorktreeMeta; model?: string; policy: PermissionPolicy } | null = null;
    if (o.terminalTabId) {
      const info = this.deps.tabInfo(o.terminalTabId);
      if (!info || !info.cwd) throw new OrchError(mt("cli.orch.error.reuseTabNotFound", { id: o.terminalTabId }), "not_found");
      if (this.isSupervisedTab(o.terminalTabId)) throw new OrchError(mt("cli.orch.error.reuseTabSupervised"), "conflict");
      if (this.isCoordinatorTab(o.terminalTabId)) throw new OrchError(mt("cli.orch.error.selfDispatch"), "self_dispatch");
      if (this.cleaning.has(o.terminalTabId)) throw new OrchError(mt("cli.orch.error.reuseTabCleaning"), "conflict");
      const snap = this.deps.snapshot(o.terminalTabId);
      if (!snap || snap.status === "running" || snap.status === "queued" || snap.status === "waiting_permission" || snap.limitWait) throw new OrchError(mt("cli.orch.error.reuseTabBusy"), "still_live");
      if (info.provider !== o.provider) throw new OrchError(mt("cli.orch.error.providerMismatch", { tab: info.provider, agent: o.provider }), "conflict");
      reuse = { provider: info.provider, cwd: info.cwd, worktree: info.worktree, model: o.model ?? info.model, policy: o.policy ?? info.policy };
    }
    const coordinatorCwd = s.run.coordinator.kind === "tab" && s.run.coordinator.tabId ? this.deps.tabCwd(s.run.coordinator.tabId) : null;
    const cwd = reuse?.cwd ?? o.cwd ?? coordinatorCwd;
    if (!cwd) throw new OrchError(mt("cli.orch.error.cwdRequired"), "bad_request");
    const policy = reuse?.policy ?? o.policy ?? "auto_edit";
    const dispatch: OrchDispatch = {
      id: `disp-${randomUUID().slice(0, 8)}`,
      runId: s.run.id,
      taskId: task.id,
      attempt: task.attempts + 1,
      tabId: "",
      provider: o.provider,
      model: reuse?.model ?? o.model,
      policy,
      cwd,
      capability: `cap-${randomUUID().slice(0, 12)}`,
      ...(o.requestId ? { requestId: o.requestId } : {}),
      status: "starting",
      startedAt: this.now(),
      startStage: reuse ? "configured" : o.worktree ? "creating_workspace" : "creating_tab",
      execution: { state: "unknown", observedAt: this.now() },
      lastCheckSeq: 0,
      pendingCheckSeq: 0,
      ownership: "supervised",
    };
    this.commit(s.run.id, { type: "dispatch_created", ts: dispatch.startedAt, dispatch });
    const stages: string[] = [dispatch.startStage];
    const title = mt("cli.orch.workerTitle", { seq: task.seq, provider: o.provider === "claude" ? "Claude Code" : "Codex", spec: task.spec.split("\n")[0].slice(0, 24) });
    if (reuse) this.deps.configureTab(o.terminalTabId!, { policy, model: reuse.model });
    const made = reuse
      ? ({ ok: true, tabId: o.terminalTabId!, cwd: reuse.cwd, worktree: reuse.worktree } as const)
      : await this.deps.createWorkerTab({ title, provider: o.provider, model: o.model, policy, cwd, worktree: o.worktree });
    // await 사이에 abandon·Run 종료·인수가 있었을 수 있다 — 시작 중이 아니면 되살리지 않는다
    const stillStarting = () => {
      const cur = this.get(s.run.id);
      const d = cur.dispatches.find((x) => x.id === dispatch.id);
      return cur.run.status === "active" && d?.status === "starting" ? d : null;
    };
    if (!stillStarting()) {
      if (made.ok) this.commit(s.run.id, { type: "dispatch_placed", ts: this.now(), dispatchId: dispatch.id, tabId: made.tabId, cwd: made.cwd, worktree: made.worktree });
      throw new OrchError(mt("cli.orch.error.startCancelled"), "cancelled", { dispatchId: dispatch.id, residualResources: made.ok ? { tabId: made.tabId, worktree: made.worktree?.path } : undefined });
    }
    if (!made.ok) {
      this.commit(s.run.id, { type: "dispatch_stage", ts: this.now(), dispatchId: dispatch.id, stage: "failed", error: made.error }, this.appNote(s.run.id, "start_failed", "cli.msg.startFailedStage", { stage: made.stage, detail: made.error }, task.id, dispatch.id));
      throw new OrchError(made.error, "start_failed", { failedStage: made.stage, dispatchId: dispatch.id, stages });
    }
    stages.push("configured");
    // 탭 id·실제 경로를 기록(리듀서는 dispatch 를 통째로 들고 있으므로 다시 만든다)
    const withTab: OrchDispatch = { ...dispatch, tabId: made.tabId, cwd: made.cwd, worktree: made.worktree };
    const run = s.run;
    const prompt = buildWorkerPrompt(mainI18n().t, { cli: this.deps.cliCommand(), run, task, dispatch: withTab });
    this.commit(s.run.id, { type: "dispatch_placed", ts: this.now(), dispatchId: withTab.id, tabId: made.tabId, cwd: made.cwd, worktree: made.worktree, startEventCount: this.deps.snapshot(made.tabId)?.eventCount ?? 0 });
    const sent = await this.deps.send(made.tabId, prompt);
    if (!stillStarting()) throw new OrchError(mt("cli.orch.error.startCancelledPrompted"), "cancelled", { dispatchId: withTab.id, residualResources: { tabId: made.tabId, worktree: made.worktree?.path } });
    if (!sent.ok) {
      this.commit(s.run.id, { type: "dispatch_stage", ts: this.now(), dispatchId: withTab.id, stage: "failed", error: sent.error }, this.appNote(s.run.id, "start_failed", "cli.msg.sendFailed", { detail: sent.error }, task.id, withTab.id));
      throw new OrchError(sent.error, "start_failed", { failedStage: "queued", dispatchId: withTab.id, stages, residualResources: { tabId: made.tabId, worktree: made.worktree?.path } });
    }
    stages.push(sent.queued || sent.pending ? "queued" : "started");
    const final = this.commit(s.run.id, { type: "dispatch_stage", ts: this.now(), dispatchId: withTab.id, stage: "started" });
    this.ensureMonitor();
    return { task: final.tasks.find((t) => t.id === task.id)!, dispatch: final.dispatches.find((d) => d.id === withTab.id)!, receipt: { stages } };
  }

  // ===== 메시지 =====
  private nextSeq(s: OrchRunState): number {
    return (s.messages[s.messages.length - 1]?.seq ?? 0) + 1;
  }

  /** 앱이 만든 메모. 본문은 만든 시점의 언어로 채우고, 사전 키(bodyMsg)를 함께 저장해 패널이 지금 언어로 다시 그린다. */
  private appNote(runId: string, kind: NonNullable<OrchMessage["noteKind"]>, key: MsgKey, params?: Record<string, string | number>, taskId?: string, dispatchId?: string): OrchEvent {
    const s = this.get(runId);
    const { message: body, msg } = appMsg(key, params);
    const m: OrchMessage = { id: `msg-${randomUUID().slice(0, 8)}`, runId, seq: this.nextSeq(s), ts: this.now(), from: { kind: "app" }, to: "run", type: "note", subject: kind, body, bodyMsg: msg, taskId, dispatchId, noteKind: kind };
    return { type: "message", ts: m.ts, message: m };
  }

  /** 워커 → 코디네이터: escalation · worker_done. 코디네이터/사람 → 워커: followup. */
  send(o: { runId: string; actor: OrchActor; key?: string; dispatchId?: string; capability?: string; to?: string; type: string; subject?: string; body?: string; outcome?: string; filesModified?: string[] }): { message: OrchMessage; receipt?: Record<string, unknown> } {
    const s = this.get(o.runId);
    if (o.type === "worker_done" || o.type === "escalation") {
      const d = this.requireDispatch(s, o.dispatchId, o.capability);
      if (o.type === "worker_done") return this.workerDone(s, d, o);
      if (d.status !== "live") throw new OrchError(mt("cli.orch.error.escalationSettled"), "already_settled");
      const m = this.mk(s, { kind: "dispatch", dispatchId: d.id }, "run", "escalation", o.subject ?? "Blocked", o.body ?? "", d.taskId, d.id);
      this.commit(s.run.id, { type: "message", ts: m.ts, message: m });
      return { message: m };
    }
    if (o.type === "followup") {
      this.requireCoordinator(s, o.key, o.actor);
      const group = resolveGroup(s, o.to ?? "");
      if (group) {
        if (group.length === 0) throw new OrchError(mt("cli.orch.error.noLiveWorkers", { to: o.to }), "not_found");
        let cur = s;
        const sent: OrchMessage[] = [];
        for (const d of group) {
          const msg = this.mk(cur, o.actor, `dispatch:${d.id}`, "followup", o.subject ?? "Follow-up", o.body ?? "", d.taskId, d.id);
          sent.push(msg);
          cur = { ...cur, messages: [...cur.messages, msg] };
        }
        // 한 이벤트(한 줄)로 기록 — 일부 워커에게만 남는 일이 없게
        this.commit(s.run.id, { type: "messages", ts: this.now(), messages: sent });
        for (const d of group) this.wakeIdleWorker(d);
        return { message: sent[0], receipt: { group: o.to, sentTo: sent.map((x) => ({ dispatchId: x.dispatchId, messageId: x.id })) } };
      }
      const target = (o.to ?? "").replace(/^dispatch:/, "") || o.dispatchId;
      const d = s.dispatches.find((x) => x.id === target);
      if (!d) throw new OrchError(mt("cli.orch.error.toRequired"), "bad_request");
      if (d.status !== "live") throw new OrchError(mt("cli.orch.error.followupNotAllowed"), "already_settled");
      const m = this.mk(s, o.actor, `dispatch:${d.id}`, "followup", o.subject ?? "Follow-up", o.body ?? "", d.taskId, d.id);
      this.commit(s.run.id, { type: "message", ts: m.ts, message: m });
      this.wakeIdleWorker(d);
      return { message: m };
    }
    throw new OrchError(mt("cli.orch.error.typeInvalid", { type: o.type }), "bad_request");
  }

  private mk(s: OrchRunState, from: OrchActor, to: OrchMessage["to"], type: OrchMessage["type"], subject: string, body: string, taskId?: string, dispatchId?: string): OrchMessage {
    return { id: `msg-${randomUUID().slice(0, 8)}`, runId: s.run.id, seq: this.nextSeq(s), ts: this.now(), from, to, type, subject: subject.slice(0, 200), body: body.slice(0, 20_000), taskId, dispatchId };
  }

  private workerDone(s: OrchRunState, d: OrchDispatch, o: { subject?: string; body?: string; outcome?: string; filesModified?: string[] }): { message: OrchMessage; receipt: Record<string, unknown> } {
    if (o.outcome !== "succeeded" && o.outcome !== "failed") throw new OrchError(mt("cli.orch.error.outcomeRequired"), "bad_request");
    const body = (o.body ?? "").trim();
    if (!body) throw new OrchError(mt("cli.orch.error.bodyRequired"), "bad_request");
    if (d.report) {
      // 같은 결과의 재전송은 멱등 성공, 다른 결과는 거절(첫 결과 보존)
      if (d.report.outcome === o.outcome && d.report.summary === body) {
        const existing = s.messages.find((m) => m.type === "worker_done" && m.dispatchId === d.id)!;
        return { message: existing, receipt: { idempotent: true, taskStatus: s.tasks.find((t) => t.id === d.taskId)?.status } };
      }
      throw new OrchError(mt("cli.orch.error.reportConflict"), "already_settled", { dispatchId: d.id, outcome: d.report.outcome });
    }
    if (d.status !== "live") throw new OrchError(mt("cli.orch.error.reportNotAccepted", { status: d.status }), "already_settled");
    const unread = undeliveredFollowups(s, d.id);
    if (unread.length > 0)
      throw new OrchError(mt("cli.orch.error.followupPending", { count: unread.length }), "followup_pending", { messages: unread.map((m) => ({ id: m.id, body: m.body })) });
    const m: OrchMessage = { ...this.mk(s, { kind: "dispatch", dispatchId: d.id }, "run", "worker_done", o.subject ?? o.outcome, body, d.taskId, d.id), outcome: o.outcome, filesModified: o.filesModified };
    this.commit(s.run.id, { type: "message", ts: m.ts, message: m }, { type: "report_accepted", ts: m.ts, dispatchId: d.id, outcome: o.outcome, summary: body, filesModified: o.filesModified });
    return { message: m, receipt: { accepted: true, taskId: d.taskId, outcome: o.outcome, note: mt("prompt.orch.reportAccepted") } };
  }

  /** 워커의 블로킹 질문. 타임아웃이면 pending 으로 돌려주고 질문은 남는다. */
  async ask(o: { runId: string; dispatchId?: string; capability?: string; question?: string; options?: string[]; requestId?: string; resume?: string; timeoutMs: number; signal?: AbortSignal; wait?: boolean }): Promise<
    { messageId: string; state: "answered"; answer: string; by: OrchActor } | { messageId: string; state: "pending"; timedOut: boolean }
  > {
    const s = this.get(o.runId);
    const d = this.requireDispatch(s, o.dispatchId, o.capability);
    let q: OrchMessage | undefined;
    if (o.resume) {
      q = s.messages.find((m) => m.id === o.resume && m.type === "question" && m.dispatchId === d.id);
      if (!q) throw new OrchError(mt("cli.orch.error.resumeNotFound", { id: o.resume }), "not_found");
    } else {
      if (o.requestId) q = s.messages.find((m) => m.type === "question" && m.dispatchId === d.id && m.requestId === o.requestId);
      if (!q) {
        if (d.status !== "live") throw new OrchError(mt("cli.orch.error.askSettled"), "already_settled");
        const text = (o.question ?? "").trim();
        if (!text) throw new OrchError(mt("cli.orch.error.questionEmpty"), "bad_request");
        q = { ...this.mk(s, { kind: "dispatch", dispatchId: d.id }, "run", "question", text.split("\n")[0].slice(0, 120), text, d.taskId, d.id), options: o.options?.filter(Boolean).slice(0, 8), requestId: o.requestId };
        this.commit(s.run.id, { type: "message", ts: q.ts, message: q });
      }
    }
    const cur = this.get(o.runId).messages.find((m) => m.id === q!.id)!;
    if (cur.answer) return { messageId: cur.id, state: "answered", answer: cur.answer.body, by: cur.answer.by };
    if (o.wait === false) return { messageId: cur.id, state: "pending", timedOut: false };
    const r = await this.waitAsk(cur.id, Math.max(1000, Math.min(o.timeoutMs, 3 * 60 * 60_000)), o.signal);
    if (r.answered && r.answer) return { messageId: cur.id, state: "answered", answer: r.answer.body, by: r.answer.by };
    return { messageId: cur.id, state: "pending", timedOut: true };
  }

  private waitAsk(questionId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ answered: boolean; answer?: OrchMessage["answer"] }> {
    return new Promise((resolve) => {
      const set = this.askWaiters.get(questionId) ?? new Set();
      this.askWaiters.set(questionId, set);
      const w: Waiter<{ answered: boolean; answer?: OrchMessage["answer"] }> = { resolve, timer: setTimeout(() => done({ answered: false }), timeoutMs), signal };
      const done = (v: { answered: boolean; answer?: OrchMessage["answer"] }) => {
        clearTimeout(w.timer);
        set.delete(w);
        if (w.onAbort) signal?.removeEventListener("abort", w.onAbort);
        resolve(v);
      };
      w.resolve = done;
      if (signal) {
        w.onAbort = () => done({ answered: false });
        if (signal.aborted) w.onAbort();
        else signal.addEventListener("abort", w.onAbort);
      }
      set.add(w);
    });
  }

  private wakeAsk(questionId: string, answer: OrchMessage["answer"]) {
    const set = this.askWaiters.get(questionId);
    if (!set) return;
    for (const w of [...set]) w.resolve({ answered: true, answer });
    this.askWaiters.delete(questionId);
  }

  /** 코디네이터(탭 또는 사람)의 답. 먼저 저장된 답이 이긴다. */
  reply(o: { runId: string; actor: OrchActor; key?: string; questionId: string; body: string }): { message: OrchMessage; conflict?: OrchMessage["answer"] } {
    const s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    const q = s.messages.find((m) => m.id === o.questionId && m.type === "question");
    if (!q) throw new OrchError(mt("cli.orch.error.questionNotFound", { id: o.questionId }), "not_found");
    const body = o.body.trim();
    if (!body) throw new OrchError(mt("cli.orch.error.answerEmpty"), "bad_request");
    if (q.answer) {
      const prev = s.messages.find((m) => m.id === q.answer!.messageId)!;
      if (q.answer.body === body) return { message: prev };
      throw new OrchError(mt("cli.orch.error.answerExists"), "conflict", { answer: q.answer });
    }
    const m: OrchMessage = { ...this.mk(s, o.actor, `dispatch:${q.dispatchId}`, "reply", `Re: ${q.subject}`, body, q.taskId, q.dispatchId), inReplyTo: q.id };
    this.commit(s.run.id, { type: "message", ts: m.ts, message: m }, { type: "question_answered", ts: m.ts, questionId: q.id, answer: { body, by: o.actor, at: m.ts, messageId: m.id } });
    return { message: m };
  }

  /** 워커의 후속 지시 읽기(cursor 갱신) 또는 코디네이터 인박스 소비(Delivery). */
  async check(o: { runId: string; actor: OrchActor; key?: string; dispatchId?: string; capability?: string; wait?: boolean; types?: string[]; ack?: string; peek?: boolean; timeoutMs?: number; signal?: AbortSignal; ackSeq?: number }): Promise<Record<string, unknown>> {
    const s0 = this.get(o.runId);
    if (o.dispatchId) {
      const d = this.requireDispatch(s0, o.dispatchId, o.capability);
      if (d.status !== "live" && d.status !== "reported") throw new OrchError(mt("cli.orch.error.dispatchSettled"), "consumer_fenced");
      // 명시적 확인(--ack <seq>)이 올 때까지 같은 지시를 계속 돌려준다 — 응답이 몇 번 유실돼도 사라지지 않게
      if (o.ackSeq !== undefined) this.commit(s0.run.id, { type: "dispatch_check", ts: this.now(), dispatchId: d.id, seq: d.pendingCheckSeq, ack: o.ackSeq });
      const s1 = this.get(o.runId);
      const d1 = s1.dispatches.find((x) => x.id === d.id)!;
      const unread = unreadFollowups(s1, d1.id);
      const maxSeq = unread.length > 0 ? unread[unread.length - 1].seq : d1.pendingCheckSeq;
      if (unread.length > 0 && maxSeq > d1.pendingCheckSeq) this.commit(s1.run.id, { type: "dispatch_check", ts: this.now(), dispatchId: d1.id, seq: maxSeq });
      return { dispatchId: d1.id, messages: unread.map(compactMessage), ackSeq: unread.length > 0 ? maxSeq : undefined, stopRequested: !!d1.stopRequestedAt, note: unread.length > 0 ? ackNote(maxSeq) : undefined };
    }
    this.requireCoordinator(s0, o.key, o.actor);
    if (o.peek) return { runId: o.runId, inbox: s0.messages.filter((m) => m.to === "run").map(compactMessage), pendingDelivery: pendingDelivery(s0)?.id ?? null };
    if (o.ack) {
      const s = this.get(o.runId);
      const dl = s.deliveries.find((d) => d.id === o.ack);
      if (!dl) throw new OrchError(mt("cli.orch.error.deliveryNotFound", { id: o.ack }), "not_found");
      if (dl.consumerEpoch !== s.run.coordinator.epoch) throw new OrchError(mt("cli.orch.error.deliveryFenced"), "consumer_fenced");
      if (!dl.ackedAt) this.commit(s.run.id, { type: "delivery_acked", ts: this.now(), deliveryId: dl.id });
    }
    const types = o.types && o.types.length ? new Set(o.types) : null;
    const deliver = (): Record<string, unknown> | null => {
      const s = this.get(o.runId);
      const pending = pendingDelivery(s);
      if (pending) return this.deliveryView(s, pending, true);
      const inbox = undeliveredInbox(s);
      if (inbox.length === 0) return null;
      if (types && !inbox.some((m) => types.has(m.type))) return null;
      const batch = inbox.slice(0, ORCH_MAX_DELIVERY);
      const dl: OrchDelivery = { id: `dl-${randomUUID().slice(0, 8)}`, runId: s.run.id, consumerEpoch: s.run.coordinator.epoch, messageIds: batch.map((m) => m.id), deliveredAt: this.now() };
      const next = this.commit(s.run.id, { type: "delivery_created", ts: dl.deliveredAt, delivery: dl });
      return this.deliveryView(next, dl, false);
    };
    const first = deliver();
    if (first || !o.wait) return first ?? { runId: o.runId, delivery: null, satisfied: false, settled: this.settledView(o.runId) };
    const epochAtWait = s0.run.coordinator.epoch;
    const woke = await this.waitInbox(o.runId, types, Math.max(1000, Math.min(o.timeoutMs ?? 900_000, 3 * 60 * 60_000)), o.signal);
    // 기다리는 동안 인수됐으면 이 호출자는 더 이상 소비자가 아니다
    const now = this.get(o.runId);
    if (now.run.coordinator.epoch !== epochAtWait) this.requireCoordinator(now, o.key, o.actor);
    const second = woke ? deliver() : null;
    return second ?? { runId: o.runId, delivery: null, satisfied: false, timedOut: true, settled: this.settledView(o.runId) };
  }

  private deliveryView(s: OrchRunState, dl: OrchDelivery, redelivered: boolean) {
    return { runId: s.run.id, delivery: { id: dl.id, redelivered, messages: dl.messageIds.map((id) => s.messages.find((m) => m.id === id)).filter((m): m is OrchMessage => !!m).map(compactMessage) }, satisfied: true, settled: this.settledView(s.run.id) };
  }

  private settledView(runId: string) {
    const s = this.get(runId);
    return { tasks: s.tasks.map((t) => ({ id: t.id, status: t.status })), openDispatches: s.dispatches.filter(isOpenDispatch).length };
  }

  private waitInbox(runId: string, types: Set<string> | null, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.inboxWaiters.get(runId) ?? new Set();
      this.inboxWaiters.set(runId, set);
      const w: Waiter<boolean> & { types: Set<string> | null } = { resolve, timer: setTimeout(() => done(false), timeoutMs), signal, types };
      const done = (v: boolean) => {
        clearTimeout(w.timer);
        set.delete(w);
        if (w.onAbort) signal?.removeEventListener("abort", w.onAbort);
        resolve(v);
      };
      w.resolve = done;
      if (signal) {
        w.onAbort = () => done(false);
        if (signal.aborted) w.onAbort();
        else signal.addEventListener("abort", w.onAbort);
      }
      set.add(w);
    });
  }

  private wakeInbox(runId: string, type: string) {
    const set = this.inboxWaiters.get(runId);
    if (!set) return;
    for (const w of [...set]) if (type === "*" || !w.types || w.types.has(type)) w.resolve(true);
  }

  // ===== 워커 관리 =====
  workerList(runId: string): Record<string, unknown>[] {
    const s = this.get(runId);
    return s.dispatches.map((d) => this.workerView(s, d));
  }

  workerShow(runId: string, dispatchId: string): Record<string, unknown> {
    const s = this.get(runId);
    const d = s.dispatches.find((x) => x.id === dispatchId);
    if (!d) throw new OrchError(mt("cli.orch.error.dispatchNotFound", { id: dispatchId }), "not_found");
    return this.workerView(s, d);
  }

  private workerView(s: OrchRunState, d: OrchDispatch) {
    const task = s.tasks.find((t) => t.id === d.taskId);
    const openQuestion = s.messages.find((m) => m.type === "question" && m.dispatchId === d.id && !m.answer);
    return {
      dispatchId: d.id,
      taskId: d.taskId,
      taskStatus: task?.status,
      tabId: d.tabId,
      provider: d.provider,
      cwd: d.cwd,
      worktree: d.worktree?.path ?? null,
      status: d.status,
      startStage: d.startStage,
      execution: d.execution,
      ownership: d.ownership,
      report: d.report ?? null,
      openQuestion: openQuestion ? { id: openQuestion.id, body: openQuestion.body } : null,
      stopRequested: !!d.stopRequestedAt,
      cleaned: d.cleaned ?? null,
      /** 사람이 결정할 것 */
      needsDecision: d.status === "reported" ? mt("cli.orch.needsDecision.settling") : d.status === "settled" && d.ownership === "supervised" ? mt("cli.orch.needsDecision.retainOrRelease") : d.execution.state === "idle" && d.status === "live" && d.reportMissingNotified ? mt("cli.orch.needsDecision.reportMissing") : null,
    };
  }

  workerAction(o: { runId: string; actor: OrchActor; key?: string; dispatchId: string; action: "retain" | "release" | "stop" | "abandon"; reason?: string }): Record<string, unknown> {
    const s = this.get(o.runId);
    this.requireCoordinator(s, o.key, o.actor);
    const d = s.dispatches.find((x) => x.id === o.dispatchId);
    if (!d) throw new OrchError(mt("cli.orch.error.dispatchNotFound", { id: o.dispatchId }), "not_found");
    const settled = d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start";
    switch (o.action) {
      case "retain":
        if (!settled) throw new OrchError(mt("cli.orch.error.retainNotSettled"), "not_settled");
        this.commit(s.run.id, { type: "dispatch_ownership", ts: this.now(), dispatchId: d.id, ownership: "retained" });
        break;
      case "release":
        if (!settled) throw new OrchError(mt("cli.orch.error.releaseNotSettled"), "not_settled");
        this.commit(s.run.id, { type: "dispatch_ownership", ts: this.now(), dispatchId: d.id, ownership: "released" });
        break;
      case "stop":
        if (d.status !== "live" && d.status !== "reported") throw new OrchError(mt("cli.orch.error.stopNotLive"), "not_live");
        this.commit(s.run.id, { type: "dispatch_stop_requested", ts: this.now(), dispatchId: d.id }, this.appNote(s.run.id, "stop_requested", "cli.msg.stopRequested", undefined, d.taskId, d.id));
        if (d.tabId) this.deps.abort(d.tabId);
        break;
      case "abandon": {
        if (settled) throw new OrchError(mt("cli.orch.error.alreadyEnded"), "already_settled");
        const snap = d.tabId ? this.deps.snapshot(d.tabId) : null;
        const busy = snap && (snap.status === "running" || snap.status === "queued" || snap.status === "waiting_permission" || snap.limitWait);
        if (busy) throw new OrchError(mt("cli.orch.error.abandonStillRunning"), "still_live");
        if (d.report) throw new OrchError(mt("cli.orch.error.abandonReported"), "conflict");
        this.commit(s.run.id, { type: "dispatch_abandoned", ts: this.now(), dispatchId: d.id, reason: o.reason ?? mt("cli.orch.abandonedByCoordinator") }, this.appNote(s.run.id, "abandoned", o.reason ? "cli.msg.abandonedWithReason" : "cli.msg.abandoned", o.reason ? { id: d.id, reason: o.reason } : { id: d.id }, d.taskId, d.id));
        break;
      }
    }
    return this.workerShow(o.runId, o.dispatchId);
  }

  /** 사람이 코디네이터를 인수한다(탭 코디네이터의 키는 fenced). */
  takeover(runId: string): OrchRun {
    const s = this.get(runId);
    const coordinator: OrchRun["coordinator"] = { kind: "user", epoch: s.run.coordinator.epoch + 1, key: randomUUID() };
    this.commit(runId, { type: "coordinator_changed", ts: this.now(), coordinator }, this.appNote(runId, "coordinator_changed", "cli.msg.coordinatorChanged"));
    return this.get(runId).run;
  }

  close(runId: string, actor: OrchActor, key?: string): OrchRun {
    const s = this.get(runId);
    this.requireCoordinator(s, key, actor);
    if (s.dispatches.some(isOpenDispatch)) throw new OrchError(mt("cli.orch.error.closeStillLive"), "still_live");
    if (s.run.status === "active") this.commit(runId, { type: "run_closed", ts: this.now() });
    return this.get(runId).run;
  }

  // ===== 감시(1초): 실행 상태 관측, 보고 누락 통지, 정산 =====
  private ensureMonitor() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    for (const s of this.runs.values()) {
      if (s.run.status !== "active") continue;
      for (const d of s.dispatches) {
        if (d.status !== "live" && d.status !== "reported") continue;
        if (!d.tabId) continue;
        const snap = this.deps.snapshot(d.tabId);
        if (!snap) {
          // 탭이 사라졌다(사용자가 지움·재시작 뒤 없음) — 실행은 알 수 없음. 한 번 알리고 코디네이터가 abandon 하게 둔다
          const cur0 = this.get(s.run.id).dispatches.find((x) => x.id === d.id)!;
          if (cur0.status === "reported") {
            // 보고는 받았고 탭은 사라졌다 — 실행이 계속될 수 없으니 정산한다(보고는 보존)
            this.commit(s.run.id, { type: "dispatch_settled", ts: this.now(), dispatchId: d.id });
            continue;
          }
          if (!this.missingNoted.has(d.id)) {
            this.missingNoted.add(d.id);
            this.commit(s.run.id, ...(cur0.execution.state !== "unknown" ? [{ type: "dispatch_execution", ts: this.now(), dispatchId: d.id, state: "unknown" } as OrchEvent] : []), this.appNote(s.run.id, "worker_tab_missing", "cli.msg.workerTabMissing", undefined, d.taskId, d.id));
          }
          continue;
        }
        const state = execState(snap);
        const cur = this.get(s.run.id).dispatches.find((x) => x.id === d.id)!;
        if (state !== cur.execution.state && !(cur.execution.state === "waiting_reply" && state === "running" && this.hasOpenQuestion(s, d.id)))
          this.commit(s.run.id, { type: "dispatch_execution", ts: this.now(), dispatchId: d.id, state });
        // 권한 대기: 사람이 봐야 한다(한 번만)
        if (state === "waiting_permission" && !this.permissionNoted.has(d.id)) {
          this.permissionNoted.add(d.id);
          this.commit(s.run.id, this.appNote(s.run.id, "permission_pending", "cli.msg.permissionPending", undefined, d.taskId, d.id));
        } else if (state !== "waiting_permission") this.permissionNoted.delete(d.id);
        const busy = state === "running" || state === "queued" || state === "waiting_permission" || state === "limit_wait" || state === "waiting_reply";
        if (busy) continue;
        // 보고 수락 + 실행 정지 → 정산
        if (cur.status === "reported") {
          this.commit(s.run.id, { type: "dispatch_settled", ts: this.now(), dispatchId: d.id });
          continue;
        }
        // 보고 없이 턴이 끝남(시작 이후 turn_result 가 있어야 "끝난" 것) → 한 번 통지
        const since = cur.startEventCount;
        // 시작 시점의 이벤트 수를 모르면(옛 기록) 턴 종료를 단정하지 않는다 — 통지 대신 그대로 관측만
        const turned = since !== undefined ? snap.turnedSince(since) : false;
        if (turned && !cur.reportMissingNotified)
          this.commit(s.run.id, { type: "dispatch_report_missing", ts: this.now(), dispatchId: d.id }, this.appNote(s.run.id, "turn_ended_without_report", "cli.msg.turnEndedWithoutReport", undefined, d.taskId, d.id));
      }
    }
  }

  /**
   * 후속 지시는 워커가 `orch check` 로 읽어 가는 것이라, 턴이 이미 끝난 워커에게는 닿지 않는다.
   * 워커 탭이 멈춰 있으면 새 턴으로 깨워 읽게 한다(돌고 있으면 계약대로 스스로 읽는다).
   */
  private wakeIdleWorker(d: OrchDispatch): void {
    if (!d.tabId) return;
    const snap = this.deps.snapshot(d.tabId);
    if (!snap) return;
    const state = execState(snap);
    if (state !== "idle" && state !== "error") return;
    void this.deps.send(d.tabId, mt("prompt.orch.followupWake")).catch(() => {});
  }

  private hasOpenQuestion(s: OrchRunState, dispatchId: string): boolean {
    return this.get(s.run.id).messages.some((m) => m.type === "question" && m.dispatchId === dispatchId && !m.answer);
  }

  /** 카드용 요약(코디네이터 탭에 남기는 orchestration 이벤트의 본문). */
  cardView(runId: string) {
    const s = this.get(runId);
    const a = attention(s);
    return {
      runId: s.run.id,
      objective: s.run.objective,
      status: s.run.status,
      coordinator: s.run.coordinator.kind,
      revision: s.revision,
      tasks: s.tasks.map((t) => {
        const d = s.dispatches.find((x) => x.id === (t.activeDispatchId ?? t.outcome?.dispatchId));
        const b = taskBlockers(s, t);
        const depSeqs = b.unmetDeps.map((id) => s.tasks.find((x) => x.id === id)?.seq ?? "?");
        // 대화 기록에 저장되는 카드 — blocked 는 예전 기록·알 수 없는 코드용 문장이고, 그릴 때는 blockedBy 를 지금 언어로 번역한다
        const blockedBy: { kind: "deps"; seqs: (number | "?")[] } | { kind: "gates" } | null = t.status !== "pending" ? null : b.unmetDeps.length ? { kind: "deps", seqs: depSeqs } : b.pendingGates.length ? { kind: "gates" } : null;
        const blocked = blockedBy ? (blockedBy.kind === "deps" ? mt("cli.blocked.deps", { seqs: depSeqs.join(",") }) : mt("cli.blocked.gates")) : null;
        return { id: t.id, seq: t.seq, spec: t.spec.split("\n")[0].slice(0, 80), status: t.status, tabId: d?.tabId ?? null, provider: d?.provider ?? null, execution: d?.execution.state ?? null, summary: t.outcome?.summary?.slice(0, 200) ?? null, blocked, blockedBy };
      }),
      gates: s.gates.filter((g) => !g.resolution).length,
      questions: a.questions.length,
      escalations: a.escalations.length,
      notes: a.notes.length,
      openDispatches: s.dispatches.filter(isOpenDispatch).length,
    };
  }
}

/** 배치 중간에서 끊긴 기록을 메워 준다: worker_done 메시지는 있는데 report_accepted 가 없거나, reply 는 있는데 question_answered 가 없는 경우. */
export function repairBatches(events: OrchEvent[]): { events: OrchEvent[]; added: OrchEvent[] } {
  const out: OrchEvent[] = [];
  const added: OrchEvent[] = [];
  const reported = new Set<string>();
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type === "report_accepted") reported.add(e.dispatchId);
    if (e.type === "question_answered") answered.add(e.questionId);
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    out.push(e);
    if (e.type !== "message") continue;
    const m = e.message;
    const next = events[i + 1];
    if (m.type === "worker_done" && m.dispatchId && m.outcome && !reported.has(m.dispatchId) && !(next?.type === "report_accepted" && next.dispatchId === m.dispatchId)) {
      const fix: OrchEvent = { type: "report_accepted", ts: m.ts, dispatchId: m.dispatchId, outcome: m.outcome, summary: m.body, filesModified: m.filesModified };
      out.push(fix);
      added.push(fix);
      reported.add(m.dispatchId);
    }
    if (m.type === "reply" && m.inReplyTo && !answered.has(m.inReplyTo) && !(next?.type === "question_answered" && next.questionId === m.inReplyTo)) {
      const fix: OrchEvent = { type: "question_answered", ts: m.ts, questionId: m.inReplyTo, answer: { body: m.body, by: m.from, at: m.ts, messageId: m.id } };
      out.push(fix);
      added.push(fix);
      answered.add(m.inReplyTo);
    }
  }
  return { events: out, added };
}

const ackNote = (seq: number) => mt("prompt.orch.ack", { seq });

function execState(snap: WorkerTabSnapshot): OrchExecutionState {
  if (snap.limitWait) return "limit_wait";
  if (snap.status === "waiting_permission" || snap.pendingPermissions > 0) return "waiting_permission";
  if (snap.status === "running") return "running";
  if (snap.status === "queued") return "queued";
  if (snap.status === "error") return "error";
  return "idle";
}

export function compactMessage(m: OrchMessage): Record<string, unknown> {
  return {
    id: m.id,
    seq: m.seq,
    type: m.type,
    from: m.from,
    subject: m.subject,
    body: m.body,
    ...(m.taskId ? { taskId: m.taskId } : {}),
    ...(m.dispatchId ? { dispatchId: m.dispatchId } : {}),
    ...(m.options ? { options: m.options } : {}),
    ...(m.answer ? { answer: m.answer } : {}),
    ...(m.outcome ? { outcome: m.outcome } : {}),
    ...(m.filesModified ? { filesModified: m.filesModified } : {}),
    ...(m.noteKind ? { noteKind: m.noteKind } : {}),
    ts: m.ts,
  };
}

/** 세션 스냅샷·이벤트에서 워커 관측치를 만든다(index.ts 가 deps.snapshot 에 쓴다). */
export function workerSnapshotFrom(status: SessionStatus, limitWait: boolean, pendingPermissions: number, events: ChatEvent[]): WorkerTabSnapshot {
  return {
    status,
    limitWait,
    pendingPermissions,
    eventCount: events.length,
    turnedSince: (since) => events.slice(since).some((e) => e.type === "turn_result"),
  };
}
