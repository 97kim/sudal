import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent, SessionStatus } from "@shared/chat-events";
import { OrchError, Orchestrator, workerSnapshotFrom, type OrchestratorDeps } from "./orchestration";

interface FakeTab {
  status: SessionStatus;
  events: ChatEvent[];
  prompts: string[];
}

function makeDeps(opts: { maxConcurrent?: number; failCreate?: string } = {}) {
  const tabs = new Map<string, FakeTab>();
  let n = 0;
  const changed: string[] = [];
  const coordTabs: string[] = [];
  const configured: string[] = [];
  const createdFor: (string | undefined)[] = [];
  const deps: OrchestratorDeps = {
    dir: mkdtempSync(join(tmpdir(), "orch-")),
    cliCommand: () => "sudal",
    createWorkerTab: async (o) => {
      if (opts.failCreate) return { ok: false, error: opts.failCreate, stage: "creating_tab" };
      createdFor.push(o.coordinatorTabId);
      const id = `tab${++n}`;
      tabs.set(id, { status: "idle", events: [], prompts: [] });
      return { ok: true, tabId: id, cwd: o.cwd, ...(o.worktree ? { worktree: { repo: o.cwd, path: o.cwd + "/wt", branch: "sudal/w", base: "main" } } : {}) };
    },
    send: async (tabId, text) => {
      const t = tabs.get(tabId)!;
      t.prompts.push(text);
      t.status = "running";
      return { ok: true, queued: false };
    },
    snapshot: (tabId) => {
      const t = tabs.get(tabId);
      return t ? workerSnapshotFrom(t.status, false, 0, t.events) : null;
    },
    abort: (tabId) => {
      const t = tabs.get(tabId);
      if (t) t.status = "idle";
    },
    tabCwd: () => "/repo",
    tabInfo: (tabId) => (tabs.has(tabId) ? { provider: "claude", cwd: "/repo", policy: "auto_edit" } : null),
    configureTab: (tabId, patch) => { configured.push(`${tabId}:${patch.policy}`); },
    tabsUsingCwd: () => [],
    cleanupWorker: async (tabId) => {
      const had = tabs.delete(tabId);
      return { tabClosed: had, worktreeRemoved: false };
    },
    maxConcurrent: () => opts.maxConcurrent ?? 4,
    setCoordinatorTabs: (ids) => { coordTabs.length = 0; coordTabs.push(...ids); },
    onChanged: (_r, _s, e) => changed.push(e.type),
  };
  return { deps, tabs, changed, coordTabs, configured, createdFor };
}

const turnEnd = (t: FakeTab) => {
  t.events.push({ type: "turn_result", ts: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: false });
  t.status = "idle";
};

test("사람 코디네이터: run → worker-start(preamble) → 질문/답 → 보고 → 정산 → release, 재시작 재생", async () => {
  const { deps, tabs } = makeDeps();
  const o = new Orchestrator(deps);
  const { run, coordinatorKey } = o.runCreate({ objective: "로그인 500 고치기" });
  const user = { kind: "user" as const };
  const w = await o.workerStart({ runId: run.id, actor: user, spec: "auth.ts 의 500 을 고치고 테스트 추가", provider: "claude", worktree: true, cwd: "/repo" });
  assert.equal(w.dispatch.status, "live");
  assert.equal(w.dispatch.tabId, "tab1");
  assert.equal(w.dispatch.worktree?.branch, "sudal/w");
  assert.deepEqual(w.receipt.stages, ["creating_workspace", "configured", "started"]);
  const prompt = tabs.get("tab1")!.prompts[0];
  assert.match(prompt, new RegExp(`--run ${run.id} --dispatch ${w.dispatch.id} --capability ${w.dispatch.capability}`));
  assert.ok(prompt.endsWith("auth.ts 의 500 을 고치고 테스트 추가"));
  // 워커가 질문 → 사람이 답 → ask 가 풀린다
  const askP = o.ask({ runId: run.id, dispatchId: w.dispatch.id, capability: w.dispatch.capability, question: "테스트 프레임워크는?", options: ["vitest", "jest"], requestId: "q-1", timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  const inbox = await o.check({ runId: run.id, actor: user, key: coordinatorKey });
  const delivery = inbox.delivery as { id: string; messages: { id: string; type: string }[] };
  assert.equal(delivery.messages[0].type, "question");
  const q = delivery.messages[0].id;
  // 같은 requestId 로 다시 ask 해도 질문은 하나
  const again = o.ask({ runId: run.id, dispatchId: w.dispatch.id, capability: w.dispatch.capability, question: "테스트 프레임워크는?", requestId: "q-1", timeoutMs: 5000 });
  o.reply({ runId: run.id, actor: user, questionId: q, body: "vitest" });
  const a1 = await askP;
  const a2 = await again;
  assert.deepEqual([a1.state, a2.state], ["answered", "answered"]);
  assert.equal(a1.state === "answered" && a1.answer, "vitest");
  assert.equal(o.get(run.id).messages.filter((m) => m.type === "question").length, 1);
  // 다른 답은 conflict, 같은 답은 멱등
  assert.throws(() => o.reply({ runId: run.id, actor: user, questionId: q, body: "jest" }), (e: unknown) => e instanceof OrchError && e.code === "conflict");
  o.reply({ runId: run.id, actor: user, questionId: q, body: "vitest" });
  // ack 없이 다시 check 하면 같은 Delivery 재전달
  const re = await o.check({ runId: run.id, actor: user, key: coordinatorKey });
  assert.equal((re.delivery as { id: string; redelivered: boolean }).id, delivery.id);
  assert.equal((re.delivery as { redelivered: boolean }).redelivered, true);
  // 완료 보고(멱등) → 정산은 실행이 멎은 뒤
  const done = o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, type: "worker_done", outcome: "succeeded", subject: "done", body: "고쳤다. 테스트 추가. 남은 것 없음." });
  assert.equal(done.receipt?.accepted, true);
  const dup = o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, type: "worker_done", outcome: "succeeded", body: "고쳤다. 테스트 추가. 남은 것 없음." });
  assert.equal(dup.receipt?.idempotent, true);
  assert.throws(() => o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, type: "worker_done", outcome: "failed", body: "사실 실패" }), (e: unknown) => e instanceof OrchError && e.code === "already_settled");
  assert.equal(o.get(run.id).tasks[0].status, "succeeded");
  assert.equal(o.get(run.id).dispatches[0].status, "reported");
  assert.throws(() => o.workerAction({ runId: run.id, actor: user, dispatchId: w.dispatch.id, action: "release" }), (e: unknown) => e instanceof OrchError && e.code === "not_settled");
  turnEnd(tabs.get("tab1")!);
  o.tick();
  assert.equal(o.get(run.id).dispatches[0].status, "settled");
  o.workerAction({ runId: run.id, actor: user, dispatchId: w.dispatch.id, action: "release" });
  assert.equal(o.get(run.id).dispatches[0].ownership, "released");
  // ack 뒤 인박스에는 worker_done 이 남아 있다(질문 배치 뒤에 왔으므로)
  const after = await o.check({ runId: run.id, actor: user, key: coordinatorKey, ack: delivery.id });
  assert.deepEqual((after.delivery as { messages: { type: string }[] }).messages.map((m) => m.type), ["worker_done"]);
  // 재시작: 같은 dir 에서 새 인스턴스가 상태를 재생한다
  const o2 = new Orchestrator(deps);
  const s2 = o2.get(run.id);
  assert.equal(s2.tasks[0].status, "succeeded");
  assert.equal(s2.dispatches[0].status, "settled");
  assert.equal(s2.dispatches[0].tabId, "tab1");
  assert.equal(s2.dispatches[0].ownership, "released");
  assert.equal(s2.messages.find((m) => m.type === "question")?.answer?.body, "vitest");
  o.stop();
  o2.stop();
});

test("fencing: 잘못된 capability 는 consumer_fenced, 인수 뒤 옛 코디네이터 키도 fenced, 자기 보고 뒤 후속 지시 불가", async () => {
  const { deps, createdFor } = makeDeps();
  const o = new Orchestrator(deps);
  const { run, coordinatorKey } = o.runCreate({ objective: "x", coordinatorTabId: "coord" });
  const coord = { kind: "tab" as const, tabId: "coord" };
  const w = await o.workerStart({ runId: run.id, actor: coord, key: coordinatorKey, spec: "일", provider: "codex", worktree: false, cwd: "/repo" });
  assert.deepEqual(createdFor, ["coord"], "일꾼 탭은 코디네이터 탭의 워크스페이스에 만들도록 코디네이터를 알려 준다");
  assert.throws(() => o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: "wrong", type: "escalation", body: "x" }), (e: unknown) => e instanceof OrchError && e.code === "consumer_fenced");
  // 후속 지시를 안 읽고 보고하면 followup_pending
  o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: `dispatch:${w.dispatch.id}`, body: "문서도 고쳐" });
  assert.throws(() => o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, type: "worker_done", outcome: "succeeded", body: "끝" }), (e: unknown) => e instanceof OrchError && e.code === "followup_pending");
  const chk = await o.check({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability });
  assert.equal((chk.messages as unknown[]).length, 1);
  const again1 = await o.check({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability });
  assert.equal((again1.messages as unknown[]).length, 1, "명시적 확인 전엔 같은 지시가 계속 온다");
  assert.equal(((await o.check({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability })).messages as unknown[]).length, 1, "두 번 유실돼도 사라지지 않는다");
  const acked = await o.check({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, ackSeq: again1.ackSeq as number });
  assert.equal((acked.messages as unknown[]).length, 0, "--ack 뒤엔 비어 있다");
  o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, type: "worker_done", outcome: "failed", body: "못 끝냈다" });
  assert.equal(o.get(run.id).tasks[0].status, "failed");
  assert.throws(() => o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: `dispatch:${w.dispatch.id}`, body: "더" }), (e: unknown) => e instanceof OrchError && e.code === "already_settled");
  // 사람이 인수 → 옛 키는 fenced, 두 번째 AI 코디네이터 Run 은 limit
  assert.throws(() => o.runCreate({ objective: "y", coordinatorTabId: "coord2" }), (e: unknown) => e instanceof OrchError && e.code === "limit");
  o.takeover(run.id);
  await assert.rejects(o.check({ runId: run.id, actor: coord, key: coordinatorKey }), (e: unknown) => e instanceof OrchError && e.code === "consumer_fenced");
  assert.ok(o.runCreate({ objective: "y", coordinatorTabId: "coord2" }).run.id);
  o.stop();
});

test("보고 없이 턴이 끝나면 앱 통지 한 번, abandon 은 멎은 뒤에만, stop 은 abort 를 부른다; maxConcurrent 1 이면 scheduler_blocked", async () => {
  const { deps, tabs } = makeDeps();
  const o = new Orchestrator(deps);
  const { run, coordinatorKey } = o.runCreate({ objective: "x" });
  const user = { kind: "user" as const };
  const w = await o.workerStart({ runId: run.id, actor: user, key: coordinatorKey, spec: "일", provider: "claude", worktree: false, cwd: "/repo" });
  assert.throws(() => o.workerAction({ runId: run.id, actor: user, dispatchId: w.dispatch.id, action: "abandon" }), (e: unknown) => e instanceof OrchError && e.code === "still_live");
  o.workerAction({ runId: run.id, actor: user, dispatchId: w.dispatch.id, action: "stop" });
  assert.equal(tabs.get("tab1")!.status, "idle");
  turnEnd(tabs.get("tab1")!);
  o.tick();
  o.tick();
  const notes = o.get(run.id).messages.filter((m) => m.type === "note" && m.noteKind === "turn_ended_without_report");
  assert.equal(notes.length, 1);
  const cw = await o.check({ runId: run.id, actor: user, wait: true, types: ["note"], timeoutMs: 1000 });
  assert.ok((cw.delivery as { messages: { noteKind?: string }[] }).messages.some((m) => m.noteKind === "turn_ended_without_report"));
  o.workerAction({ runId: run.id, actor: user, dispatchId: w.dispatch.id, action: "abandon", reason: "보고 없음" });
  assert.equal(o.get(run.id).tasks[0].status, "abandoned");
  // 같은 Task 재시도는 새 Dispatch(attempt 2)
  const w2 = await o.workerStart({ runId: run.id, actor: user, taskId: w.task.id, provider: "claude", worktree: false, cwd: "/repo" });
  assert.equal(w2.dispatch.attempt, 2);
  assert.equal(o.get(run.id).tasks[0].status, "running");
  o.stop();
  const one = makeDeps({ maxConcurrent: 1 });
  const blocked = new Orchestrator(one.deps);
  assert.ok(blocked.runCreate({ objective: "z", coordinatorTabId: "t" }).run.id, "코디네이터 탭은 워커가 있는 동안 동시 작업 수에서 빠지므로 상한 1에서도 가능");
  assert.deepEqual(one.coordTabs, [], "워커가 없으면 예외도 없다");
  blocked.stop();
});

test("워커 시작 실패는 stage failed + start_failed 통지, Task 는 pending 으로 남는다", async () => {
  const { deps } = makeDeps({ failCreate: "worktree 실패" });
  const o = new Orchestrator(deps);
  const { run } = o.runCreate({ objective: "x" });
  await assert.rejects(o.workerStart({ runId: run.id, actor: { kind: "user" }, spec: "일", provider: "claude", worktree: true, cwd: "/repo" }), (e: unknown) => e instanceof OrchError && e.code === "start_failed" && e.data?.failedStage === "creating_tab");
  const s = o.get(run.id);
  assert.equal(s.tasks[0].status, "pending");
  assert.equal(s.dispatches[0].status, "failed_to_start");
  assert.ok(s.messages.some((m) => m.noteKind === "start_failed"));
  o.stop();
});

test("ask 타임아웃은 pending 으로 돌아오고 질문은 남는다; 연결이 끊기면(signal) waiter 만 사라진다", async () => {
  const { deps } = makeDeps();
  const o = new Orchestrator(deps);
  const { run } = o.runCreate({ objective: "x" });
  const w = await o.workerStart({ runId: run.id, actor: { kind: "user" }, spec: "일", provider: "claude", worktree: false, cwd: "/repo" });
  const r = await o.ask({ runId: run.id, dispatchId: w.dispatch.id, capability: w.dispatch.capability, question: "어느 쪽?", timeoutMs: 1000 });
  assert.equal(r.state, "pending");
  const ac = new AbortController();
  const p = o.ask({ runId: run.id, dispatchId: w.dispatch.id, capability: w.dispatch.capability, resume: r.messageId, timeoutMs: 60_000, signal: ac.signal });
  ac.abort();
  assert.equal((await p).state, "pending");
  assert.equal(o.get(run.id).messages.filter((m) => m.type === "question").length, 1);
  o.reply({ runId: run.id, actor: { kind: "user" }, questionId: r.messageId, body: "왼쪽" });
  const r2 = await o.ask({ runId: run.id, dispatchId: w.dispatch.id, capability: w.dispatch.capability, resume: r.messageId, timeoutMs: 1000 });
  assert.equal(r2.state === "answered" && r2.answer, "왼쪽");
  o.stop();
});

test("기다리는 동안 인수되면 옛 키의 check 는 consumer_fenced, 새 코디네이터는 미확인 배치를 다시 받는다; reported 는 close 를 막는다", async () => {
  const { deps, tabs } = makeDeps();
  const o = new Orchestrator(deps);
  const { run, coordinatorKey } = o.runCreate({ objective: "x", coordinatorTabId: "coord" });
  const coord = { kind: "tab" as const, tabId: "coord" };
  const w = await o.workerStart({ runId: run.id, actor: coord, key: coordinatorKey, spec: "일", provider: "claude", worktree: false, cwd: "/repo" });
  o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: w.dispatch.id }, dispatchId: w.dispatch.id, capability: w.dispatch.capability, type: "worker_done", outcome: "succeeded", body: "끝" });
  const first = await o.check({ runId: run.id, actor: coord, key: coordinatorKey });
  assert.equal((first.delivery as { messages: { type: string }[] }).messages[0].type, "worker_done");
  assert.throws(() => o.close(run.id, coord, coordinatorKey), (e: unknown) => e instanceof OrchError && e.code === "still_live", "보고만 받고 실행 정지 확인 전엔 닫을 수 없다");
  const waiting = o.check({ runId: run.id, actor: coord, key: coordinatorKey, ack: (first.delivery as { id: string }).id, wait: true, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  o.takeover(run.id);
  await assert.rejects(waiting, (e: unknown) => e instanceof OrchError && e.code === "consumer_fenced");
  // 새 소비자(사람): ack 되지 않은 배치는 없지만(ack 했음) 이후 note(coordinator_changed)를 받는다
  const mine = await o.check({ runId: run.id, actor: { kind: "user" } });
  assert.ok((mine.delivery as { messages: { noteKind?: string }[] }).messages.some((m) => m.noteKind === "coordinator_changed"));
  turnEnd(tabs.get("tab1")!);
  o.tick();
  assert.equal(o.get(run.id).dispatches[0].status, "settled");
  o.close(run.id, { kind: "user" });
  assert.equal(o.get(run.id).run.status, "closed");
  o.stop();
});

test("requestId 는 정확히 비교하고 capability 에 섞지 않는다; 시작 중 abandon 되면 프롬프트를 보내지 않는다", async () => {
  const { deps, tabs } = makeDeps();
  let release: (() => void) | null = null;
  const slowCreate = deps.createWorkerTab;
  deps.createWorkerTab = async (o) => {
    await new Promise<void>((r) => (release = r));
    return slowCreate(o);
  };
  const o = new Orchestrator(deps);
  const { run } = o.runCreate({ objective: "x" });
  const user = { kind: "user" as const };
  const p = o.workerStart({ runId: run.id, actor: user, spec: "일", provider: "claude", worktree: false, cwd: "/repo", requestId: "b" });
  await new Promise((r) => setTimeout(r, 20));
  const d = o.get(run.id).dispatches[0];
  assert.equal(d.status, "starting");
  assert.equal(d.requestId, "b");
  assert.ok(!d.capability.includes(":"));
  o.workerAction({ runId: run.id, actor: user, dispatchId: d.id, action: "abandon", reason: "취소" });
  release!();
  await assert.rejects(p, (e: unknown) => e instanceof OrchError && e.code === "cancelled");
  assert.equal(tabs.get("tab1")!.prompts.length, 0, "취소된 시도엔 프롬프트를 보내지 않는다");
  assert.equal(o.get(run.id).dispatches[0].status, "abandoned");
  assert.equal(o.get(run.id).dispatches[0].tabId, "tab1", "만들어진 탭은 잔존 자원으로 기록");
  // 같은 requestId 재요청은 기존 시도(abandoned) 를 돌려준다 — 새로 만들지 않는다
  deps.createWorkerTab = slowCreate;
  const again = await o.workerStart({ runId: run.id, actor: user, spec: "일", provider: "claude", worktree: false, cwd: "/repo", requestId: "b" });
  assert.equal(again.dispatch.id, d.id);
  assert.equal(again.receipt.idempotent, true);
  const other = await o.workerStart({ runId: run.id, actor: user, spec: "일2", provider: "claude", worktree: false, cwd: "/repo", requestId: "a:b" });
  assert.notEqual(other.dispatch.id, d.id);
  o.stop();
});

test("JSONL 의 잘린 마지막 줄은 버리고 파일을 정상 경계로 되돌린다; worker_done 만 남은 배치는 report_accepted 를 복원한다", async () => {
  const { deps, tabs } = makeDeps();
  const o = new Orchestrator(deps);
  const { run } = o.runCreate({ objective: "x" });
  const w = await o.workerStart({ runId: run.id, actor: { kind: "user" }, spec: "일", provider: "claude", worktree: false, cwd: "/repo" });
  o.stop();
  const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
  const file = join(deps.dir, run.id + ".jsonl");
  // 배치 중간에서 끊긴 것처럼: worker_done 메시지만 기록되고 report_accepted 없음 + 잘린 조각
  const doneMsg = { type: "message", ts: 99, message: { id: "msg-x", runId: run.id, seq: 1, ts: 99, from: { kind: "dispatch", dispatchId: w.dispatch.id }, to: "run", type: "worker_done", subject: "done", body: "끝", taskId: w.task.id, dispatchId: w.dispatch.id, outcome: "succeeded" } };
  appendFileSync(file, JSON.stringify(doneMsg) + "\n" + '{"type":"dispatch_execu');
  const o2 = new Orchestrator(deps);
  const s = o2.get(run.id);
  assert.equal(s.tasks[0].status, "succeeded", "복원된 report_accepted");
  assert.equal(s.dispatches[0].status, "reported");
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n") && !text.includes("dispatch_execu"), "잘린 조각이 사라졌다");
  assert.ok(text.includes('"type":"report_accepted"'), "복원 이벤트가 파일에도 남는다");
  // 그 뒤 정상 기록도 문제없이 이어진다
  turnEnd(tabs.get("tab1")!);
  o2.tick();
  assert.equal(o2.get(run.id).dispatches[0].status, "settled");
  const o3 = new Orchestrator(deps);
  assert.equal(o3.get(run.id).dispatches[0].status, "settled");
  writeFileSync(file, readFileSync(file, "utf8"));
  o2.stop();
  o3.stop();
});

test("2단계: deps 가 안 끝난 Task 는 deps_unmet, 게이트 미해결은 gate_pending, 해결 뒤 시작; task-list --ready; 정산 워커 탭 재사용·정리", async () => {
  const { deps, tabs } = makeDeps();
  const o = new Orchestrator(deps);
  const { run } = o.runCreate({ objective: "DAG" });
  const user = { kind: "user" as const };
  const a = o.taskCreate({ runId: run.id, actor: user, spec: "A: c.txt 만들기" });
  const b = o.taskCreate({ runId: run.id, actor: user, spec: "B: c.txt 에 줄 추가", deps: [a.id] });
  assert.throws(() => o.taskCreate({ runId: run.id, actor: user, spec: "x", deps: ["task-없음"] }), (e: unknown) => e instanceof OrchError && e.code === "not_found");
  assert.deepEqual(o.taskList(run.id, { ready: true }).map((t) => t.id), [a.id]);
  await assert.rejects(o.workerStart({ runId: run.id, actor: user, taskId: b.id, provider: "claude", worktree: false, cwd: "/repo" }), (e: unknown) => e instanceof OrchError && e.code === "deps_unmet");
  const wa = await o.workerStart({ runId: run.id, actor: user, taskId: a.id, provider: "claude", worktree: false, cwd: "/repo" });
  o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: wa.dispatch.id }, dispatchId: wa.dispatch.id, capability: wa.dispatch.capability, type: "worker_done", outcome: "succeeded", body: "A 끝" });
  turnEnd(tabs.get(wa.dispatch.tabId)!);
  o.tick();
  assert.equal(o.get(run.id).dispatches[0].status, "settled");
  assert.deepEqual(o.taskList(run.id, { ready: true }).map((t) => t.id), [b.id]);
  const g = o.gateCreate({ runId: run.id, actor: user, taskId: b.id, question: "어떤 줄?", options: ["one", "two"] });
  assert.deepEqual(o.taskList(run.id, { ready: true }), []);
  await assert.rejects(o.workerStart({ runId: run.id, actor: user, taskId: b.id, provider: "claude", worktree: false, cwd: "/repo" }), (e: unknown) => e instanceof OrchError && e.code === "gate_pending");
  assert.throws(() => o.gateResolve({ runId: run.id, actor: user, gateId: g.id, resolution: "three" }), (e: unknown) => e instanceof OrchError && e.code === "bad_request");
  o.gateResolve({ runId: run.id, actor: user, gateId: g.id, resolution: "two" });
  assert.throws(() => o.gateResolve({ runId: run.id, actor: user, gateId: g.id, resolution: "one" }), (e: unknown) => e instanceof OrchError && e.code === "conflict");
  // 정산된 A 의 탭을 B 에 재사용
  const wb = await o.workerStart({ runId: run.id, actor: user, taskId: b.id, provider: "claude", worktree: false, terminalTabId: wa.dispatch.tabId });
  assert.equal(wb.dispatch.tabId, wa.dispatch.tabId);
  assert.equal(tabs.get(wa.dispatch.tabId)!.prompts.length, 2);
  assert.match(tabs.get(wa.dispatch.tabId)!.prompts[1], /앞선 Task\(task-/);
  await assert.rejects(o.workerStart({ runId: run.id, actor: user, spec: "C", provider: "claude", worktree: false, terminalTabId: wa.dispatch.tabId }), (e: unknown) => e instanceof OrchError && e.code === "conflict", "감독 중인 탭은 재사용 불가");
  await assert.rejects(o.workerCleanup({ runId: run.id, actor: user, dispatchId: wb.dispatch.id }), (e: unknown) => e instanceof OrchError && e.code === "not_settled");
  o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: wb.dispatch.id }, dispatchId: wb.dispatch.id, capability: wb.dispatch.capability, type: "worker_done", outcome: "succeeded", body: "B 끝" });
  turnEnd(tabs.get(wb.dispatch.tabId)!);
  o.tick();
  const cleaned = await o.workerCleanup({ runId: run.id, actor: user, dispatchId: wb.dispatch.id });
  assert.equal((cleaned.cleaned as { tabClosed: boolean }).tabClosed, true);
  assert.equal(tabs.has(wb.dispatch.tabId), false);
  // 탭이 사라진 다른 시도는 worker_tab_missing 통지
  const { run: r2 } = o.runCreate({ objective: "missing" });
  const w3 = await o.workerStart({ runId: r2.id, actor: user, spec: "일", provider: "claude", worktree: false, cwd: "/repo" });
  tabs.delete(w3.dispatch.tabId);
  o.tick();
  o.tick();
  const notes = o.get(r2.id).messages.filter((m) => m.noteKind === "worker_tab_missing");
  assert.equal(notes.length, 1);
  assert.equal(o.get(r2.id).dispatches[0].execution.state, "unknown");
  o.workerAction({ runId: r2.id, actor: user, dispatchId: w3.dispatch.id, action: "abandon", reason: "탭 없음" });
  assert.equal(o.get(r2.id).tasks[0].status, "abandoned");
  o.stop();
});

test("3단계: 코디네이터 탭 예외 목록 동기화, 그룹 주소 followup, 워커 탭의 중첩 Run 거부", async () => {
  const { deps, tabs, coordTabs } = makeDeps();
  const o = new Orchestrator(deps);
  const { run, coordinatorKey } = o.runCreate({ objective: "x", coordinatorTabId: "coord" });
  const coord = { kind: "tab" as const, tabId: "coord" };
  assert.deepEqual(coordTabs, [], "워커가 없으면 코디네이터도 상한을 따른다");
  const w1 = await o.workerStart({ runId: run.id, actor: coord, key: coordinatorKey, spec: "a", provider: "claude", worktree: false, cwd: "/repo" });
  assert.deepEqual(coordTabs, ["coord"], "워커가 감독 중이면 코디네이터 탭은 예외");
  const w2 = await o.workerStart({ runId: run.id, actor: coord, key: coordinatorKey, spec: "b", provider: "codex", worktree: false, cwd: "/repo" });
  // 워커 탭이 Run 을 만들려 하면 거부
  assert.throws(() => o.runCreate({ objective: "nested", coordinatorTabId: w1.dispatch.tabId }), (e: unknown) => e instanceof OrchError && e.code === "nested_run");
  const r = o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: "@codex", body: "코덱스만" });
  assert.deepEqual((r.receipt as { sentTo: { dispatchId: string }[] }).sentTo.map((x) => x.dispatchId), [w2.dispatch.id]);
  const all = o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: "@all", body: "모두" });
  assert.equal((all.receipt as { sentTo: unknown[] }).sentTo.length, 2);
  const c1 = await o.check({ runId: run.id, actor: { kind: "dispatch", dispatchId: w1.dispatch.id }, dispatchId: w1.dispatch.id, capability: w1.dispatch.capability });
  assert.deepEqual((c1.messages as { body: string }[]).map((m) => m.body), ["모두"]);
  assert.throws(() => o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: "@idle", body: "x" }), (e: unknown) => e instanceof OrchError && e.code === "not_found");
  // 사람이 인수하면 코디네이터 탭 예외가 사라진다
  o.takeover(run.id);
  assert.deepEqual(coordTabs, []);
  void tabs;
  o.stop();
});

test("리뷰 2차: 재사용 탭에 정책 적용, retain 된 시도는 cleanup 거절, 게이트 결정은 인박스 note 로 코디네이터를 깨움, 옛 기록(커서 없음) 재생", async () => {
  const { deps, tabs, configured } = makeDeps();
  const o = new Orchestrator(deps);
  const user = { kind: "user" as const };
  const { run } = o.runCreate({ objective: "x" });
  const a = await o.workerStart({ runId: run.id, actor: user, spec: "A", provider: "claude", worktree: false, cwd: "/repo" });
  o.send({ runId: run.id, actor: { kind: "dispatch", dispatchId: a.dispatch.id }, dispatchId: a.dispatch.id, capability: a.dispatch.capability, type: "worker_done", outcome: "succeeded", body: "A 끝" });
  turnEnd(tabs.get(a.dispatch.tabId)!);
  o.tick();
  const b = o.taskCreate({ runId: run.id, actor: user, spec: "B" });
  const wb = await o.workerStart({ runId: run.id, actor: user, taskId: b.id, provider: "claude", worktree: false, terminalTabId: a.dispatch.tabId, policy: "ask" });
  assert.deepEqual(configured, [`${a.dispatch.tabId}:ask`], "재사용 탭에 이번 시도의 정책을 실제로 적용");
  assert.equal(wb.dispatch.policy, "ask");
  // retain 된 시도는 cleanup 거절
  o.workerAction({ runId: run.id, actor: user, dispatchId: a.dispatch.id, action: "retain" });
  await assert.rejects(o.workerCleanup({ runId: run.id, actor: user, dispatchId: a.dispatch.id }), (e: unknown) => e instanceof OrchError && (e.code === "retained" || e.code === "conflict"));
  // 게이트 결정 → 기다리는 코디네이터가 note 로 깨어난다
  const c = o.taskCreate({ runId: run.id, actor: user, spec: "C" });
  const g = o.gateCreate({ runId: run.id, actor: user, taskId: c.id, question: "갈까?", options: ["yes", "no"] });
  const waiting = o.check({ runId: run.id, actor: user, wait: true, types: ["note"], timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 20));
  o.gateResolve({ runId: run.id, actor: user, gateId: g.id, resolution: "yes" });
  const woke = await waiting;
  assert.ok((woke.delivery as { messages: { noteKind?: string }[] }).messages.some((m) => m.noteKind === "gate_resolved"));
  o.stop();
  // 옛 기록: pendingCheckSeq 없는 dispatch_created 를 재생해도 커서가 NaN 이 되지 않는다
  const { appendFileSync, mkdtempSync: mk } = await import("node:fs");
  const dir = mk(join(tmpdir(), "orch-old-"));
  const oldRun = { id: "run-old", objective: "old", createdAt: 1, createdBy: { kind: "user" }, coordinator: { kind: "user", epoch: 1, key: "k" }, status: "active" };
  const oldTask = { id: "t-old", runId: "run-old", seq: 1, spec: "s", createdAt: 1, status: "pending", activeDispatchId: null, attempts: 0 };
  const oldDisp = { id: "d-old", runId: "run-old", taskId: "t-old", attempt: 1, tabId: "tabX", provider: "claude", policy: "auto_edit", cwd: "/repo", capability: "cap", status: "live", startedAt: 1, startStage: "started", execution: { state: "running", observedAt: 1 }, lastCheckSeq: 0, ownership: "supervised" };
  appendFileSync(join(dir, "run-old.jsonl"), [JSON.stringify({ type: "run_created", ts: 1, run: oldRun }), JSON.stringify({ type: "task_created", ts: 2, task: oldTask }), JSON.stringify({ type: "dispatch_created", ts: 3, dispatch: oldDisp }), JSON.stringify({ type: "dispatch_check", ts: 4, dispatchId: "d-old", seq: 2 })].join("\n") + "\n");
  const o2 = new Orchestrator({ ...deps, dir });
  const d = o2.get("run-old").dispatches[0];
  assert.equal(Number.isNaN(d.lastCheckSeq) || Number.isNaN(d.pendingCheckSeq), false);
  assert.equal(d.pendingCheckSeq, 2);
  assert.deepEqual(o2.get("run-old").tasks[0].deps, []);
  o2.stop();
});

test("후속 지시: 턴이 끝난 워커는 깨워서 읽게 하고, 돌고 있는 워커는 건드리지 않는다", async () => {
  const { deps, tabs } = makeDeps();
  const o = new Orchestrator(deps);
  const coord = { kind: "tab", tabId: "coord" } as const;
  const { run, coordinatorKey } = o.runCreate({ objective: "x", coordinatorTabId: "coord" });
  const w = await o.workerStart({ runId: run.id, actor: coord, key: coordinatorKey, spec: "일", provider: "codex", worktree: false, cwd: "/repo" });
  const tab = tabs.get(w.dispatch.tabId!)!;
  assert.equal(tab.prompts.length, 1, "워커 계약만 받았다");
  // 돌고 있으면(계약대로 스스로 orch check 한다) 새 턴을 보내지 않는다
  o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: `dispatch:${w.dispatch.id}`, body: "문서도 고쳐" });
  assert.equal(tab.prompts.length, 1);
  // 보고 없이 턴이 끝나 멈춘 워커에게는 후속 지시를 읽으라는 턴을 보낸다
  turnEnd(tab);
  tab.status = "idle";
  o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: `dispatch:${w.dispatch.id}`, body: "보고를 다시 보내" });
  assert.equal(tab.prompts.length, 2);
  assert.match(tab.prompts[1], /후속 지시가 도착했어요/);
  // 그룹으로 보내도 같다
  turnEnd(tab);
  tab.status = "idle";
  o.send({ runId: run.id, actor: coord, key: coordinatorKey, type: "followup", to: "@all", body: "모두" });
  assert.equal(tab.prompts.length, 3);
});
