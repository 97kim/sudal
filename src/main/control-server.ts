// `sudal` CLI(cli/sudal.cjs)가 붙는 제어 서버. userData 의 유닉스 소켓(0600, 이 사용자만)으로 줄 단위 JSON 을 주고받는다.
//   요청  {"id":1,"method":"tab.list","params":{...}}
//   응답  {"id":1,"result":{...}}  또는  {"id":1,"error":{"code":"...","message":"..."}}
// 앱 상태를 건드리는 일은 전부 deps 로 위임한다 — 이 파일은 프로토콜·선택자·대기 로직만 알고, 테스트는 가짜 deps 로 돈다.
// 신뢰 모델: 소켓에 붙을 수 있는 건 같은 사용자(UID)뿐이고, 그 사용자는 앱을 직접 조작할 수 있는 사람이다. 그래서 CLI 는
// 앱 UI 와 같은 권한을 가진다(경로 승인·full 정책 포함). 다른 사용자·원격은 파일 권한이 막는다.
// Windows 는 유닉스 소켓 파일 대신 named pipe(\\.\pipe\sudal-<userData 해시>)를 쓴다 — chmod 가 없어 파이프 기본 보안 설명자에 맡긴다.
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { samePath } from "@shared/any-path";
import { isPermissionPolicy, type ChatEvent, type PermissionPolicy, type SessionStatus } from "@shared/chat-events";
import { parseCron } from "@shared/cron";
import type { Run, Schedule } from "@shared/schedules";
import type { ChatSendResult, FanoutStartDto, FanoutStartResult, Provider, WorkspaceStateDto } from "@shared/ipc";
import { OrchError, type Orchestrator } from "./orchestration";
import { replaySession, type Block } from "@shared/session-state";
import { clickScript, fillScript, focusScript, keyInputEvents, pickConsole, readScript, rectScript, scrollScript, waitProbeScript, type BrowserRect, type KeyInput, type ScrollTarget } from "@shared/browser-control";
import type { ConsoleLine, NetFailure } from "@shared/browser-diagnostics";
import { tabTitle as sharedTabTitle, type TabMeta } from "@shared/workspace-model";
import { mainI18n, mt } from "./i18n";
import { verifyOutputText } from "@shared/verify";

/** 이름 없는 탭의 표시 제목은 지금 언어로. */
const tabTitle = (t: TabMeta): string => sharedTabTitle(t, mt("shared.untitledTab"));

export interface ControlSnapshot {
  status: SessionStatus;
  provider: Provider;
  cwd: string | null;
  sessionId: string | null;
  controller: string;
  /** 큐에서 차례를 기다리는 프롬프트 수(턴이 끝나면 자동 전송되는 것들). */
  pending: number;
  /** 사용량 한도로 재시도를 기다리는 중이면 true. */
  limitWait: boolean;
}

export interface ControlDeps {
  version: string;
  /** 새 세션의 기본 CLI 탐색이 끝날 때까지 기다린다. 조회 요청은 막지 않는다. */
  readyForNewSession?(): Promise<void>;
  state(): WorkspaceStateDto;
  addWorkspace(path: string): { workspaceId: string; tabId: string };
  createTab(workspaceId?: string): string | null;
  /** cwd 는 승인된 루트 안이어야 한다 — 호출자가 approveRoot 로 먼저 허용한다. */
  configure(tabId: string, patch: { cwd?: string; provider?: Provider; policy?: PermissionPolicy; model?: string }): void;
  renameTab(tabId: string, title: string): void;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
  snapshot(tabId: string): ControlSnapshot;
  events(tabId: string): ChatEvent[];
  send(tabId: string, text: string): Promise<ChatSendResult>;
  abort(tabId: string): void;
  /** 검증 실행(저장한 명령 또는 commands). 결과는 탭 기록의 verify 블록으로 남는다. */
  verify(tabId: string, commands?: string[]): Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  verifyAbort(tabId: string): boolean;
  /** 팬아웃: 지시 하나를 격리 세션 N개에. 결과는 탭 기록의 fanout 블록으로. */
  fanout(tabId: string, req: FanoutStartDto): Promise<FanoutStartResult>;
  /** 오케스트레이션(orch.*). 없으면 그 메서드들은 unsupported. */
  orchestrator?: () => Orchestrator;
  approveRoot(path: string): void;
  /** 렌더러에 "이 탭에서 파일/브라우저를 열어라" 를 밀어 넣는다. 창이 없으면 만들어서라도 전달한다. */
  openFile(tabId: string, path: string, line?: number): void;
  openBrowser(tabId: string, url: string): void;
  /** 그 탭의 브라우저에서 스크립트를 돌린다(에이전트 조작). 브라우저가 없으면 던진다. */
  runInBrowser(tabId: string, script: string): Promise<Record<string, unknown>>;
  /** 그 탭의 브라우저 화면(rect 는 CSS px, 없으면 보이는 영역 전체)을 PNG 로. 비었으면 던진다. */
  captureBrowser(tabId: string, rect?: BrowserRect): Promise<{ png: Buffer; width: number; height: number }>;
  /** 진짜 키 이벤트를 차례로 보낸다(포커스된 요소로 간다). */
  pressInBrowser(tabId: string, events: KeyInput[]): Promise<void>;
  /** main 이 모아 둔 그 브라우저의 콘솔·실패한 요청. 읽기만 한다(비우지 않는다). */
  browserConsole(tabId: string): ConsoleLine[];
  browserNet(tabId: string): NetFailure[];
  guide(name: string): string | null;
  /** 예약 실행. 없으면 schedule.* 는 unsupported. */
  schedules?: () => {
    list(): { schedules: (Schedule & { nextRunAt: number | null })[]; runs: Run[] };
    save(input: Partial<Schedule> & { id?: string }): Schedule;
    remove(id: string): boolean;
    runNow(id: string): Promise<Run | null>;
    runs(id: string): Run[];
  };
}

type Params = Record<string, unknown>;
type Json = unknown;

const BUSY: SessionStatus[] = ["running", "queued", "waiting_permission"];
/** 한 줄(요청 하나)의 최대 바이트. 넘으면 연결을 끊는다 — 개행 없는 입력이 메모리에 쌓이지 않게. */
const MAX_LINE_BYTES = 1024 * 1024;
/** 연결 하나가 동시에 걸어 둘 수 있는 요청 수(wait 를 무한정 쌓지 못하게). */
const MAX_INFLIGHT = 8;

export class ControlError extends Error {
  constructor(
    message: string,
    readonly code = "bad_request",
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

/** 툴 블록의 한 줄 요약(명령·경로·패턴 등 첫 문자열 필드). */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["description", "command", "file_path", "pattern", "query", "url", "skill", "prompt"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 160);
  }
  const first = Object.values(o).find((v) => typeof v === "string") as string | undefined;
  return first ? first.split("\n")[0].slice(0, 160) : "";
}

function compactBlock(b: Block): Json {
  switch (b.kind) {
    case "user":
      return { kind: "user", text: b.text, ts: b.ts };
    case "text":
      return { kind: "assistant", text: b.text, streaming: b.streaming };
    case "tool":
      return { kind: "tool", name: b.name, summary: toolSummary(b.input), done: !!b.result, isError: b.result?.isError ?? false, ...(b.subagent ? { subagentToolCalls: b.subagent.toolCalls } : {}) };
    case "turn":
      return { kind: "turn", durationMs: b.durationMs, isError: b.isError, ...(b.errorText ? { errorText: b.errorText } : {}) };
    case "error":
      return { kind: "error", message: b.message };
    case "notice":
      return { kind: "notice", level: b.level, message: b.message };
    case "compacted":
      return { kind: "compacted", trigger: b.trigger, preTokens: b.preTokens, ...(b.postTokens !== undefined ? { postTokens: b.postTokens } : {}) };
    case "review":
      return { kind: "review", reviewer: b.reviewer, status: b.status, text: b.text, ...(b.scope ? { scope: b.scope } : {}) };
    case "fanout":
      return {
        kind: "fanout",
        fanoutId: b.id,
        status: b.status,
        prompt: b.prompt,
        ...(b.adoptedTabId ? { adoptedTabId: b.adoptedTabId } : {}),
        variants: b.variants.map((v) => ({ tabId: v.tabId, label: v.label, provider: v.provider, status: v.status, ...(v.files !== undefined ? { files: v.files, added: v.added, deleted: v.deleted } : {}), ...(v.summary ? { summary: v.summary } : {}), ...(v.error ? { error: v.error } : {}) })),
      };
    case "orchestration":
      return { kind: "orchestration", runId: b.id, objective: b.objective, status: b.status, tasks: b.tasks, questions: b.questions, escalations: b.escalations };
    case "verify":
      return {
        kind: "verify",
        runId: b.id,
        status: b.status,
        head: b.head,
        commands: b.commands.map((c) => ({ cmd: c.cmd, status: c.status, ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}), ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}), ...(verifyOutputText(mainI18n(), c) ? { output: verifyOutputText(mainI18n(), c) } : {}) })),
      };
    default: {
      // 블록 종류가 늘면 여기서 컴파일 오류가 난다 — 빠뜨리면 tab read 에 null 이 섞인다
      const never: never = b;
      return never;
    }
  }
}

/**
 * Windows 제어 파이프 이름. userData 마다 달라서 개발·검증 인스턴스가 사용자 앱과 섞이지 않는다.
 * cli/sudal.cjs 의 controlPipeName 과 글자 하나까지 같아야 한다(control-server.test.ts 가 비교한다).
 */
export function controlPipeName(userData: string): string {
  const key = userData.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return `\\\\.\\pipe\\sudal-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** \\.\pipe\... 는 파일이 아니다 — 지우거나 chmod 하지 않는다. */
export function isPipePath(p: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(p);
}

export class ControlServer {
  private server: Server | null = null;
  /** 실제로 연 소켓 경로(긴 userData 경로면 tmp 의 짧은 경로로 대체된다). start 뒤에 유효. */
  socketPath: string;
  constructor(
    private readonly deps: ControlDeps,
    preferredPath: string,
    private readonly fallbackPath?: string,
  ) {
    this.socketPath = preferredPath;
  }

  async start(): Promise<void> {
    try {
      await this.listen(this.socketPath);
    } catch (e) {
      // 유닉스 소켓 경로는 macOS 104·Linux 108바이트 제한 — 넘으면 EINVAL/ENAMETOOLONG. 짧은 경로로 다시 연다.
      const code = (e as { code?: string }).code;
      if (!this.fallbackPath || (code !== "EINVAL" && code !== "ENAMETOOLONG")) throw e;
      this.socketPath = this.fallbackPath;
      await this.listen(this.socketPath);
    }
  }

  private listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 지난 실행이 남긴 소켓 파일은 지우고 새로 연다(단일 인스턴스라 다른 앱이 쓰고 있을 일은 없다)
      try {
        if (!isPipePath(socketPath) && existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* 무시 */
      }
      const server = createServer((sock) => this.onConnection(sock));
      server.on("error", reject);
      server.listen(socketPath, () => {
        if (isPipePath(socketPath)) {
          this.server = server;
          resolve();
          return;
        }
        try {
          // 같은 사용자만 붙을 수 있게. 못 좁히면 여는 것 자체를 포기한다(다른 사용자에게 열린 채 돌지 않게).
          chmodSync(socketPath, 0o600);
        } catch (e) {
          server.close();
          reject(e);
          return;
        }
        this.server = server;
        resolve();
      });
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
    if (isPipePath(this.socketPath)) return;
    try {
      unlinkSync(this.socketPath);
    } catch {
      /* 없음 */
    }
  }

  private onConnection(sock: Socket) {
    let buf = "";
    let inflight = 0;
    // 연결이 끊기면 그 연결이 걸어 둔 대기(ask·check --wait)를 풀어 준다 — 질문·메시지는 남고 waiter 만 사라진다
    const ac = new AbortController();
    sock.on("close", () => ac.abort());
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES) {
        sock.write(JSON.stringify({ id: null, error: { code: "too_large", message: mt("cli.control.tooLarge", { max: MAX_LINE_BYTES }) } }) + "\n");
        sock.destroy();
        return;
      }
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (inflight >= MAX_INFLIGHT) {
          sock.write(JSON.stringify({ id: null, error: { code: "too_many", message: mt("cli.control.tooMany", { max: MAX_INFLIGHT }) } }) + "\n");
          continue;
        }
        inflight++;
        void this.handleLine(line, ac.signal).then((out) => {
          inflight--;
          if (sock.destroyed) return;
          try {
            sock.write(JSON.stringify(out) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id: null, error: { code: "error", message: mt("cli.control.responseFailed", { detail: e instanceof Error ? e.message : String(e) }) } }) + "\n");
          }
        });
      }
    });
    sock.on("error", () => {
      /* 클라이언트가 먼저 끊음 */
    });
  }

  private async handleLine(line: string, signal?: AbortSignal): Promise<Json> {
    let id: unknown = null;
    try {
      const req = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
      // id 는 그대로 돌려주므로 문자열·유한 숫자·null 만 받는다(중첩 객체를 되돌려 주다 직렬화가 터지지 않게)
      id = typeof req.id === "string" || (typeof req.id === "number" && Number.isFinite(req.id)) ? req.id : null;
      if (typeof req.method !== "string") throw new ControlError(mt("cli.control.methodMissing"));
      const params = (req.params && typeof req.params === "object" && !Array.isArray(req.params) ? req.params : {}) as Params;
      const result = await this.dispatch(req.method, params, signal);
      return { id, result };
    } catch (e) {
      const code = e instanceof ControlError || e instanceof OrchError ? e.code : "error";
      const data = e instanceof ControlError || e instanceof OrchError ? e.data : undefined;
      return { id, error: { code, message: e instanceof Error ? e.message : String(e), ...(data ? { data } : {}) } };
    }
  }

  /** 명령 하나를 처리한다(테스트에서 직접 부른다). */
  async dispatch(method: string, params: Params, signal?: AbortSignal): Promise<Json> {
    if (method.startsWith("orch.")) return this.dispatchOrch(method.slice(5), params, signal);
    switch (method) {
      case "status": {
        const st = this.deps.state();
        return { version: this.deps.version, pid: process.pid, workspaces: st.model.workspaces.length, openTabs: st.model.openTabIds.length, activeTabId: st.model.activeTabId };
      }
      case "ws.list": {
        const st = this.deps.state();
        return {
          workspaces: st.model.workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path || null,
            openTabs: st.model.tabs.filter((t) => t.workspaceId === w.id && t.open).length,
          })),
        };
      }
      case "ws.add": {
        const path = this.requireString(params, "path");
        if (!isAbsolute(path)) throw new ControlError(mt("cli.control.pathAbsolute"));
        await this.deps.readyForNewSession?.();
        this.deps.approveRoot(path);
        const r = this.deps.addWorkspace(path);
        return { workspaceId: r.workspaceId, tabId: r.tabId };
      }
      case "schedule.list": {
        const api = this.requireSchedules();
        const { schedules, runs } = api.list();
        return {
          schedules: schedules.map((s) => ({
            id: s.id,
            name: s.name,
            cron: s.cron,
            timezone: s.timezone,
            enabled: s.enabled,
            provider: s.provider,
            policy: s.policy,
            target: s.target,
            // 이 예약이 회차를 쌓는 탭. 어디를 열어 보면 되는지는 사용자도 알아야 한다.
            pinnedTabId: s.pinnedTabId ?? null,
            nextRunAt: s.nextRunAt,
            lastRun: runs.find((r) => r.scheduleId === s.id) ?? null,
          })),
        };
      }
      case "schedule.add": {
        const api = this.requireSchedules();
        const cron = this.requireString(params, "cron");
        if (!parseCron(cron)) throw new ControlError(mt("cli.control.cronInvalidFormat"));
        // --policy 를 안 주면 비워 두고 저장하는 쪽이 설정의 "새 탭 기본 권한" 으로 채운다(화면과 같게).
        const policy = params.policy !== undefined ? this.requireString(params, "policy") : undefined;
        if (policy !== undefined && !isPermissionPolicy(policy)) throw new ControlError(mt("cli.control.policyInvalid"));
        const provider = params.provider !== undefined ? this.requireString(params, "provider") : "claude";
        if (provider !== "claude" && provider !== "codex") throw new ControlError(mt("cli.control.providerInvalid"));
        // --cwd 를 안 주면 워크스페이스 기본 경로로 돈다. 이름만으로 만든 워크스페이스에는 그 값이 없어
        // 저장이 막히므로, 그때는 --cwd 로 직접 준다(화면의 "폴더 고르기" 와 같은 값이다).
        const cwd = params.cwd !== undefined ? this.requireString(params, "cwd") : undefined;
        if (cwd !== undefined && !isAbsolute(cwd)) throw new ControlError(mt("cli.control.cwdAbsolute"));
        const target = {
          kind: "fresh",
          cwd,
          worktree: params.worktree === true || params.worktree === "true",
        } as const;
        const saved = api.save({
          name: this.requireString(params, "name"),
          cron,
          timezone: params.timezone !== undefined ? this.requireTimezone(params) : Intl.DateTimeFormat().resolvedOptions().timeZone,
          prompt: this.requireString(params, "prompt"),
          provider,
          ...(policy !== undefined ? { policy: policy as PermissionPolicy } : {}),
          target,
          ...(params.precheck !== undefined
            ? { precheck: { command: this.requireString(params, "precheck"), timeoutMs: Number(params.precheckTimeout ?? 60000) } }
            : {}),
          ...(params.grace !== undefined ? { missedRunGraceMinutes: this.requireGrace(params) } : {}),
        });
        return { schedule: { id: saved.id, name: saved.name, cron: saved.cron, timezone: saved.timezone, enabled: saved.enabled } };
      }
      case "schedule.set": {
        const api = this.requireSchedules();
        const id = this.requireString(params, "id");
        const patch: Partial<Schedule> & { id: string } = { id };
        if (params.enabled !== undefined) patch.enabled = params.enabled === true || params.enabled === "true";
        if (params.cron !== undefined) {
          const cron = this.requireString(params, "cron");
          if (!parseCron(cron)) throw new ControlError(mt("cli.control.cronInvalid"));
          patch.cron = cron;
        }
        if (params.prompt !== undefined) patch.prompt = this.requireString(params, "prompt");
        if (params.name !== undefined) patch.name = this.requireString(params, "name");
        const saved = api.save(patch);
        return { schedule: { id: saved.id, name: saved.name, cron: saved.cron, enabled: saved.enabled } };
      }
      case "schedule.rm": {
        const api = this.requireSchedules();
        return { removed: api.remove(this.requireString(params, "id")) };
      }
      case "schedule.run": {
        const api = this.requireSchedules();
        const run = await api.runNow(this.requireString(params, "id"));
        if (!run) throw new ControlError(mt("cli.control.scheduleNotFound"));
        return { run: { id: run.id, status: run.status, tabId: run.tabId, reason: run.reason } };
      }
      case "schedule.runs": {
        const api = this.requireSchedules();
        return {
          runs: api.runs(this.requireString(params, "id")).map((r) => ({
            id: r.id,
            scheduledFor: r.scheduledFor,
            status: r.status,
            trigger: r.trigger,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
            tabId: r.tabId,
            reason: r.reason,
          })),
        };
      }
      case "tab.list": {
        const st = this.deps.state();
        const ws = params.workspace !== undefined ? this.resolveWorkspace(this.requireString(params, "workspace")) : null;
        const all = params.all === true;
        return {
          activeTabId: st.model.activeTabId,
          tabs: st.model.tabs
            .filter((t) => (all || t.open) && (!ws || t.workspaceId === ws.id))
            .map((t) => this.tabInfo(t)),
        };
      }
      case "tab.new": {
        await this.deps.readyForNewSession?.();
        const st = this.deps.state();
        // --ws 가 없으면 부른 탭(caller)의 워크스페이스, 탭 밖에서 불렀으면 화면에 보이는 탭의 워크스페이스
        const wsOf = (tabId: unknown) => st.model.workspaces.find((w) => w.id === st.model.tabs.find((t) => t.id === tabId)?.workspaceId);
        const ws = params.workspace !== undefined ? this.resolveWorkspace(this.requireString(params, "workspace")) : (wsOf(params.caller) ?? wsOf(st.model.activeTabId) ?? st.model.workspaces[0]);
        if (!ws) throw new ControlError(mt("cli.control.noWorkspace"));
        // 탭을 만들기 전에 인자를 전부 검증한다 — 잘못된 호출이 빈 탭을 남기지 않게
        const cwd = params.cwd !== undefined ? this.requireString(params, "cwd") : undefined;
        if (cwd && !isAbsolute(cwd)) throw new ControlError(mt("cli.control.cwdAbsolute"));
        const patch: Parameters<ControlDeps["configure"]>[1] = {};
        if (cwd) patch.cwd = cwd;
        const provider = params.provider !== undefined ? this.requireString(params, "provider") : undefined;
        if (provider) {
          if (provider !== "claude" && provider !== "codex") throw new ControlError(mt("cli.control.providerInvalid"));
          patch.provider = provider;
        }
        const policy = params.policy !== undefined ? this.requireString(params, "policy") : undefined;
        if (policy) {
          if (!isPermissionPolicy(policy)) throw new ControlError(mt("cli.control.policyInvalid"));
          patch.policy = policy as PermissionPolicy;
        }
        const model = params.model !== undefined ? this.requireString(params, "model") : undefined;
        if (model) patch.model = model;
        const title = params.title !== undefined ? this.requireString(params, "title") : undefined;
        const prompt = params.prompt !== undefined ? this.requireString(params, "prompt") : undefined;
        // 프롬프트를 보내려면 작업 경로가 있어야 한다: --cwd 나 워크스페이스 기본 경로. 없으면 만들기 전에 거절.
        if (prompt && !cwd && !ws.path) throw new ControlError(mt("cli.control.promptNeedsCwd"));
        if (cwd) this.deps.approveRoot(cwd);
        // createTab 은 새 탭을 활성화한다 — --activate 가 아니면 보고 있던 탭으로 되돌린다(사람의 화면을 빼앗지 않게)
        const prevActive = st.model.activeTabId;
        const tabId = this.deps.createTab(ws.id);
        if (!tabId) throw new ControlError(mt("cli.control.tabCreateFailed"));
        if (Object.keys(patch).length > 0) this.deps.configure(tabId, patch);
        if (title) this.deps.renameTab(tabId, title);
        if (params.activate === true) this.deps.activateTab(tabId);
        else if (prevActive && prevActive !== tabId) this.deps.activateTab(prevActive);
        let sent: ChatSendResult | null = null;
        if (prompt) {
          sent = await this.deps.send(tabId, prompt);
          if (!sent.ok) throw new ControlError(mt("cli.control.tabCreatedSendFailed", { detail: sent.error }), "send_failed", { tabId });
        }
        const tab = this.deps.state().model.tabs.find((t) => t.id === tabId)!;
        return { tab: this.tabInfo(tab), ...(sent ? { send: sent } : {}) };
      }
      case "tab.status": {
        const tab = this.resolveTab(params.tab);
        return { tab: this.tabInfo(tab) };
      }
      case "tab.send": {
        const tab = this.resolveTab(params.tab);
        if (params.wait === true) this.rejectSelfWait(tab, params);
        const text = this.requireString(params, "text");
        const since = this.deps.events(tab.id).length;
        const r = await this.deps.send(tab.id, text);
        if (!r.ok) throw new ControlError(r.error, "send_failed");
        if (params.wait === true) {
          const w = await this.waitTurn(tab.id, since, num(params.timeoutMs) ?? 600_000);
          return { send: r, wait: w, ...(w.satisfied ? { reply: this.lastReply(tab.id) } : {}) };
        }
        return { send: r, tab: this.tabInfo(tab) };
      }
      case "tab.wait": {
        const tab = this.resolveTab(params.tab);
        this.rejectSelfWait(tab, params);
        const w = await this.waitIdle(tab.id, num(params.timeoutMs) ?? 600_000);
        return { wait: w, ...(w.satisfied ? { reply: this.lastReply(tab.id) } : {}), tab: this.tabInfo(tab) };
      }
      case "tab.read": {
        const tab = this.resolveTab(params.tab);
        const last = Math.max(1, Math.min(200, num(params.last) ?? 10));
        const blocks = replaySession(this.deps.events(tab.id)).blocks;
        return { tab: this.tabInfo(tab), total: blocks.length, blocks: blocks.slice(-last).map(compactBlock) };
      }
      case "tab.activate": {
        const tab = this.resolveTab(params.tab);
        this.deps.activateTab(tab.id);
        return { tab: this.tabInfo(tab) };
      }
      case "tab.close": {
        const tab = this.resolveTab(params.tab);
        this.deps.closeTab(tab.id);
        return { closed: tab.id };
      }
      case "tab.abort": {
        const tab = this.resolveTab(params.tab);
        this.deps.abort(tab.id);
        return { aborted: tab.id };
      }
      case "tab.verify": {
        const tab = this.resolveTab(params.tab);
        let commands: string[] | undefined;
        if (params.commands !== undefined) {
          // 명시했는데 모양이 틀리면 저장된 명령으로 대체하지 않고 거절
          if (!Array.isArray(params.commands) || params.commands.length === 0 || !params.commands.every((c) => typeof c === "string" && c.trim().length > 0))
            throw new ControlError(mt("cli.control.commandsInvalid"));
          commands = params.commands as string[];
        }
        const since = this.deps.events(tab.id).length;
        const r = await this.deps.verify(tab.id, commands);
        if (!r.ok) throw new ControlError(r.error, "verify_failed");
        if (params.wait === true) {
          const w = await this.waitVerify(tab.id, r.runId, since, num(params.timeoutMs) ?? 1_800_000);
          return { runId: r.runId, wait: w, ...(w.result ? { result: w.result } : {}) };
        }
        return { runId: r.runId, tab: this.tabInfo(tab) };
      }
      case "tab.fanout": {
        const tab = this.resolveTab(params.tab);
        const prompt = this.requireString(params, "prompt");
        const providers = Array.isArray(params.providers) ? params.providers : Array.isArray(params.variants) ? params.variants : undefined;
        if (!providers) throw new ControlError(mt("cli.control.providersRequired"));
        const since = this.deps.events(tab.id).length;
        const r = await this.deps.fanout(tab.id, { prompt, variants: providers.map((p) => (typeof p === "string" ? { provider: p as Provider } : (p as { provider: Provider; model?: string }))), ...(params.policy !== undefined ? { policy: params.policy as PermissionPolicy } : {}) });
        if (!r.ok) throw new ControlError(r.error, "fanout_failed");
        if (params.wait === true) {
          const w = await this.waitFanout(tab.id, r.fanoutId, since, num(params.timeoutMs) ?? 1_800_000);
          return { fanoutId: r.fanoutId, tabIds: r.tabIds, wait: w, ...(w.result ? { result: w.result } : {}) };
        }
        return { fanoutId: r.fanoutId, tabIds: r.tabIds, tab: this.tabInfo(tab) };
      }
      case "tab.verify.abort": {
        const tab = this.resolveTab(params.tab);
        return { aborted: this.deps.verifyAbort(tab.id) };
      }
      case "file.open": {
        const tab = this.resolveTab(params.tab);
        const path = this.requireString(params, "path");
        if (!isAbsolute(path)) throw new ControlError(mt("cli.control.pathAbsolute"));
        this.deps.openFile(tab.id, path, num(params.line));
        return { tab: tab.id, path };
      }
      case "browser.open": {
        const tab = this.resolveTab(params.tab);
        const url = this.requireString(params, "url");
        if (!/^https?:\/\//i.test(url)) throw new ControlError(mt("cli.control.urlInvalid"));
        this.deps.openBrowser(tab.id, url);
        return { tab: tab.id, url };
      }
      case "browser.read": {
        const tab = this.resolveTab(params.tab);
        const r = await this.deps.runInBrowser(tab.id, readScript());
        return { tab: tab.id, ...r };
      }
      case "browser.click": {
        const tab = this.resolveTab(params.tab);
        const selector = params.selector !== undefined ? this.requireString(params, "selector") : undefined;
        const text = params.text !== undefined ? this.requireString(params, "text") : undefined;
        if (!selector && !text) throw new ControlError(mt("cli.control.selectorOrText"));
        const r = await this.deps.runInBrowser(tab.id, clickScript(mt, { selector, text }));
        return { tab: tab.id, ...r };
      }
      case "browser.fill": {
        const tab = this.resolveTab(params.tab);
        const selector = this.requireString(params, "selector");
        // 빈 문자열은 "지우기" 라는 뜻이므로 requireString 을 쓰지 않는다(str 은 공백을 undefined 로 만든다).
        const value = typeof params.value === "string" ? params.value : "";
        const r = await this.deps.runInBrowser(tab.id, fillScript(mt, selector, value));
        return { tab: tab.id, ...r };
      }
      case "browser.screenshot": {
        const tab = this.resolveTab(params.tab);
        const selector = params.selector !== undefined ? this.requireString(params, "selector") : undefined;
        const out = params.out !== undefined ? this.requireString(params, "out") : join(tmpdir(), `sudal-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
        if (!isAbsolute(out)) throw new ControlError(mt("cli.control.outAbsolute"));
        const r = selector ? await this.deps.runInBrowser(tab.id, rectScript(mt, selector)) : undefined;
        const shot = await this.deps.captureBrowser(tab.id, r?.rect as BrowserRect | undefined);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, shot.png);
        return { tab: tab.id, ok: true, path: out, width: shot.width, height: shot.height, ...(r ? { selector: r.selector, clipped: r.clipped } : {}) };
      }
      case "browser.scroll": {
        const tab = this.resolveTab(params.tab);
        if ([params.selector, params.by, params.to].filter((v) => v !== undefined).length !== 1) throw new ControlError(mt("cli.control.scrollTarget"));
        let target: ScrollTarget;
        if (params.selector !== undefined) target = { selector: this.requireString(params, "selector") };
        else if (params.to !== undefined) {
          if (params.to !== "top" && params.to !== "bottom") throw new ControlError(mt("cli.control.scrollToInvalid"));
          target = { to: params.to };
        } else {
          // num 은 음수 문자열을 받지 않는다 — 위로 스크롤(--by -300)도 받아야 한다
          const by = typeof params.by === "number" ? params.by : typeof params.by === "string" && /^-?\d+$/.test(params.by.trim()) ? Number(params.by) : NaN;
          if (!Number.isInteger(by)) throw new ControlError(mt("cli.control.scrollByInvalid"));
          target = { by };
        }
        const r = await this.deps.runInBrowser(tab.id, scrollScript(mt, target));
        return { tab: tab.id, ...r };
      }
      case "browser.press": {
        const tab = this.resolveTab(params.tab);
        // trim 하지 않는다 — 키 이름에 공백이 섞이면 모르는 키로 거절하는 편이 낫다
        if (typeof params.key !== "string" || params.key === "") throw new ControlError(mt("cli.control.keyRequired"));
        const key = params.key;
        const events = keyInputEvents(key);
        if (!events) throw new ControlError(mt("cli.control.keyInvalid", { key }));
        const selector = params.selector !== undefined ? this.requireString(params, "selector") : undefined;
        const f = selector ? await this.deps.runInBrowser(tab.id, focusScript(mt, selector)) : undefined;
        await this.deps.pressInBrowser(tab.id, events);
        return { tab: tab.id, ok: true, key, ...(f ? { focused: f.focused } : {}) };
      }
      case "browser.wait": {
        const tab = this.resolveTab(params.tab);
        const selector = params.selector !== undefined ? this.requireString(params, "selector") : undefined;
        const text = params.text !== undefined ? this.requireString(params, "text") : undefined;
        if (!selector && !text) throw new ControlError(mt("cli.control.selectorOrText"));
        const rawTimeout = params.timeout ?? params.timeoutMs;
        const timeoutMs = rawTimeout === undefined ? 10_000 : num(rawTimeout);
        if (timeoutMs === undefined) throw new ControlError(mt("cli.control.timeoutInvalid"));
        return { tab: tab.id, ...(await this.waitInBrowser(tab.id, { selector, text }, timeoutMs)) };
      }
      case "browser.console": {
        const tab = this.resolveTab(params.tab);
        const level = params.level;
        if (level !== undefined && level !== "warn" && level !== "error") throw new ControlError(mt("cli.control.levelInvalid"));
        const limit = params.limit !== undefined ? num(params.limit) : undefined;
        if (params.limit !== undefined && (limit === undefined || limit < 1)) throw new ControlError(mt("cli.control.limitInvalid"));
        return { tab: tab.id, lines: pickConsole(this.deps.browserConsole(tab.id), { level, limit }) };
      }
      case "browser.network": {
        const tab = this.resolveTab(params.tab);
        return { tab: tab.id, failures: this.deps.browserNet(tab.id) };
      }
      case "skills.get": {
        const name = params.name !== undefined ? this.requireString(params, "name") : "sudal-cli";
        const text = this.deps.guide(name);
        if (!text) throw new ControlError(mt("cli.control.unknownGuide", { name }), "not_found");
        return { name, text };
      }
      default:
        throw new ControlError(mt("cli.control.unknownMethod", { method }), "unknown_method");
    }
  }

  /** 값이 있는 문자열 인자. 플래그만 있고 값이 없으면(true) 뚜렷하게 거절한다 — `--tab` 만 쓰고 활성 탭을 닫는 사고를 막는다. */
  private requireString(params: Params, key: string): string {
    const s = str(params[key]);
    if (!s) throw new ControlError(mt("cli.control.valueRequired", { key }));
    return s;
  }

  /** orch.* — 오케스트레이션. 코디네이터 명령은 --run/--key, 워커 명령은 --run/--dispatch/--capability(preamble 값). */
  private async dispatchOrch(cmd: string, p: Params, signal?: AbortSignal): Promise<Json> {
    const orch = this.deps.orchestrator?.();
    if (!orch) throw new ControlError(mt("cli.control.orchUnsupported"), "unsupported");
    const runId = str(p.run);
    const key = str(p.key);
    const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
    // 호출자: 워커 명령(--dispatch + --capability)은 그 Dispatch, 그 밖은 코디네이터 — 소켓에서는 --key 가 있어야만 코디네이터다.
    // "사람" 권한은 앱 UI(IPC)에서만 생긴다. 키 없는 소켓 호출이 사람 행세를 할 수 없게.
    const dispatchId = str(p.dispatch);
    const actor = dispatchId ? ({ kind: "dispatch", dispatchId } as const) : ({ kind: "tab", tabId: str(p.coordinatorTab) ?? "cli" } as const);
    const coordActor = { kind: "tab", tabId: str(p.coordinatorTab) ?? "cli" } as const;
    const needRun = () => {
      if (!runId) throw new ControlError(mt("cli.control.runRequired"));
      return runId;
    };
    switch (cmd) {
      case "run-create": {
        const objective = this.requireString(p, "objective");
        let coordinatorTabId: string | null = null;
        const c = str(p.coordinator);
        if (c) coordinatorTabId = c === "active" ? this.deps.state().model.activeTabId : this.resolveTab(c).id;
        const r = orch.runCreate({ objective, coordinatorTabId });
        return { run: r.run, coordinatorKey: r.coordinatorKey, note: coordinatorTabId ? mt("prompt.orch.coordinatorTab") : mt("cli.orch.runNoteHuman") };
      }
      case "run-list":
        return { runs: orch.list().map((s) => ({ id: s.run.id, objective: s.run.objective, status: s.run.status, coordinator: s.run.coordinator.kind, createdAt: s.run.createdAt, summary: orch.cardView(s.run.id) })) };
      case "run-show":
        return { ...orch.cardView(needRun()), workers: orch.workerList(runId!) };
      case "run-close":
        return { run: orch.close(needRun(), coordActor, key) };
      case "task-create":
        return { task: orch.taskCreate({ runId: needRun(), spec: p.spec, key, actor: coordActor, deps: strList(p.deps) }) };
      case "task-list":
        return { tasks: orch.taskList(needRun(), { ready: p.ready === true }) };
      case "gate-create":
        return { gate: orch.gateCreate({ runId: needRun(), actor: coordActor, key, taskId: this.requireString(p, "task"), question: this.requireString(p, "question"), options: strList(p.options) ?? [] }) };
      case "gate-resolve":
        return { gate: orch.gateResolve({ runId: needRun(), actor: coordActor, key, gateId: this.requireString(p, "id"), resolution: this.requireString(p, "resolution") }) };
      case "gate-list":
        return { gates: orch.get(needRun()).gates.filter((g) => !str(p.task) || g.taskId === str(p.task)) };
      case "worker-cleanup":
        return { worker: await orch.workerCleanup({ runId: needRun(), actor: coordActor, key, dispatchId: this.requireString(p, "dispatch") }) };
      case "worker-start": {
        const provider = str(p.agent) ?? str(p.provider) ?? "claude";
        if (provider !== "claude" && provider !== "codex") throw new ControlError(mt("cli.control.agentInvalid"));
        const policy = str(p.policy);
        if (policy !== undefined && !isPermissionPolicy(policy)) throw new ControlError(mt("cli.control.agentPolicyInvalid"));
        const wt = p.worktree;
        const worktree = wt === true || wt === "true" || wt === "new";
        const terminal = str(p.terminal);
        const terminalTabId = terminal ? this.resolveTab(terminal).id : undefined;
        const r = await orch.workerStart({ runId: needRun(), key, actor: coordActor, taskId: str(p.task), spec: p.spec, provider, model: str(p.model), policy: policy as "ask" | "auto_edit" | "full" | undefined, cwd: str(p.cwd), worktree, requestId: str(p.requestId), terminalTabId, deps: strList(p.deps) });
        return { task: r.task, dispatch: { id: r.dispatch.id, taskId: r.dispatch.taskId, tabId: r.dispatch.tabId, cwd: r.dispatch.cwd, worktree: r.dispatch.worktree?.path ?? null, capability: r.dispatch.capability, status: r.dispatch.status }, receipt: r.receipt };
      }
      case "worker-list":
        return { workers: orch.workerList(needRun()) };
      case "worker-show":
        return { worker: orch.workerShow(needRun(), this.requireString(p, "dispatch")) };
      case "worker-retain":
      case "worker-release":
      case "worker-stop":
      case "worker-abandon":
        return { worker: orch.workerAction({ runId: needRun(), actor: coordActor, key, dispatchId: this.requireString(p, "dispatch"), action: cmd.slice(7) as "retain" | "release" | "stop" | "abandon", reason: str(p.reason) }) };
      case "send": {
        const type = this.requireString(p, "type");
        return orch.send({ runId: needRun(), actor, key, dispatchId, capability: str(p.capability), to: str(p.to), type, subject: str(p.subject), body: str(p.body), outcome: str(p.outcome), filesModified: strList(p.filesModified) });
      }
      case "ask":
        return orch.ask({ runId: needRun(), dispatchId, capability: str(p.capability), question: str(p.question), options: strList(p.options), requestId: str(p.requestId), resume: str(p.resume), timeoutMs: num(p.timeoutMs) ?? 600_000, signal, wait: p.wait !== false });
      case "reply":
        return orch.reply({ runId: needRun(), actor: coordActor, key, questionId: this.requireString(p, "id"), body: this.requireString(p, "body") });
      case "check":
        // 워커의 --ack 는 seq 숫자, 코디네이터의 --ack 는 Delivery id
        return orch.check({ runId: needRun(), actor, key, dispatchId, capability: str(p.capability), wait: p.wait === true, types: strList(p.types), ack: dispatchId ? undefined : str(p.ack), ackSeq: dispatchId ? num(p.ack) : undefined, peek: p.peek === true, timeoutMs: num(p.timeoutMs), signal });
      default:
        throw new ControlError(mt("cli.control.unknownOrch", { cmd }), "unknown_command");
    }
  }

  /** runId 의 verify 이벤트가 running 을 벗어날 때까지 기다린다. */
  private async waitVerify(tabId: string, runId: string, since: number, timeoutMs: number): Promise<{ satisfied: boolean; result?: Json }> {
    const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, 3 * 60 * 60_000));
    for (;;) {
      const done = this.deps
        .events(tabId)
        .slice(since)
        .find((e) => e.type === "verify" && e.runId === runId && e.status !== "running");
      if (done && done.type === "verify") {
        const block = replaySession(this.deps.events(tabId)).blocks.find((b) => b.kind === "verify" && b.id === runId);
        return { satisfied: true, result: block ? compactBlock(block) : { status: done.status } };
      }
      if (Date.now() >= deadline) return { satisfied: false };
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** fanoutId 의 fanout 이벤트가 running 을 벗어날 때까지 기다린다. */
  private async waitFanout(tabId: string, fanoutId: string, since: number, timeoutMs: number): Promise<{ satisfied: boolean; result?: Json }> {
    const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, 3 * 60 * 60_000));
    for (;;) {
      const done = this.deps
        .events(tabId)
        .slice(since)
        .find((e) => e.type === "fanout" && e.fanoutId === fanoutId && e.status !== "running");
      if (done) {
        const block = replaySession(this.deps.events(tabId)).blocks.find((b) => b.kind === "fanout" && b.id === fanoutId);
        return { satisfied: true, result: block ? compactBlock(block) : null };
      }
      if (Date.now() >= deadline) return { satisfied: false };
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /**
   * 브라우저에 보이는 요소·글이 나타날 때까지 들여다본다. 페이지 이동 중에는 실행 자체가 실패하거나 응답이 늦으므로
   * 실패는 삼키고 다시 보고, 한 번 들여다보기도 남은 시간 안에서만 기다린다. 끝내 없으면 마지막 실패를 붙여 던진다.
   */
  private async waitInBrowser(tabId: string, target: { selector?: string; text?: string }, timeoutMs: number): Promise<Record<string, unknown>> {
    const started = Date.now();
    const deadline = started + Math.min(timeoutMs, 10 * 60_000);
    const script = waitProbeScript(target);
    let lastError = "";
    for (;;) {
      const left = Math.max(1, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const probe = this.deps.runInBrowser(tabId, script);
        probe.catch(() => {}); // 시간에 져서 버려진 뒤 실패해도 처리 안 된 거절로 남지 않게
        const r = await Promise.race([
          probe,
          new Promise<null>((res) => (timer = setTimeout(() => res(null), left))),
        ]);
        if (r?.bad) throw new ControlError(mt("cli.browser.badSelector", { selector: target.selector ?? "" }));
        if (r?.found) {
          const { ok: _ok, found: _found, ...rest } = r;
          return { ok: true, found: true, waitedMs: Date.now() - started, ...rest };
        }
      } catch (e) {
        if (e instanceof ControlError) throw e;
        lastError = e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() >= deadline) {
        const msg = mt("cli.control.waitTimeout", { ms: timeoutMs, target: target.selector ?? target.text ?? "" });
        throw new ControlError(lastError ? `${msg} (${lastError})` : msg, "timeout");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private tabInfo(t: TabMeta) {
    const s = this.deps.snapshot(t.id);
    const st = this.deps.state();
    return {
      id: t.id,
      title: tabTitle(t),
      workspaceId: t.workspaceId,
      workspace: st.model.workspaces.find((w) => w.id === t.workspaceId)?.name ?? null,
      provider: s.provider,
      status: s.status,
      pending: s.pending,
      limitWait: s.limitWait,
      cwd: s.cwd,
      sessionId: s.sessionId,
      controller: s.controller,
      open: t.open,
      active: st.model.activeTabId === t.id,
    };
  }

  /** 부른 에이전트가 자기 탭을 기다리면 그 턴이 끝나지 않아 영영 기다린다. CLI 가 부른 탭(caller)을 알려 주면 막는다. */
  private rejectSelfWait(tab: TabMeta, params: Record<string, unknown>): void {
    if (str(params.caller) === tab.id) throw new ControlError(mt("cli.control.selfWait"), "self_wait");
  }

  /** 선택자: 생략하면 활성 탭. "active" · 탭 id · 정확한 제목 · 유일한 제목 접두(대소문자 무시). 열린 탭만 본다. 값 없는 플래그는 거절. */
  private resolveTab(sel: unknown): TabMeta {
    const st = this.deps.state();
    if (sel !== undefined && typeof sel !== "string") throw new ControlError(mt("cli.control.tabValueRequired"));
    const key = str(sel) ?? "active";
    const open = st.model.tabs.filter((t) => t.open);
    if (key === "active") {
      const t = open.find((x) => x.id === st.model.activeTabId);
      if (!t) throw new ControlError(mt("cli.control.noActiveTab"), "not_found");
      return t;
    }
    const byId = open.find((t) => t.id === key);
    if (byId) return byId;
    const lower = key.toLowerCase();
    const exact = open.filter((t) => tabTitle(t).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const pool = exact.length > 1 ? exact : open.filter((t) => tabTitle(t).toLowerCase().startsWith(lower));
    if (pool.length === 1) return pool[0];
    if (pool.length > 1) throw new ControlError(mt("cli.control.tabAmbiguous", { candidates: pool.map((t) => `${tabTitle(t)} (${t.id})`).join(", ") }), "ambiguous", { candidates: pool.map((t) => ({ id: t.id, title: tabTitle(t) })) });
    throw new ControlError(mt("cli.control.tabNotFound", { key }), "not_found");
  }

  /** 워크스페이스 선택자: id → 정확한 경로 → 이름(대소문자 무시). 같은 이름이 여럿이면 후보를 돌려주며 거절. */
  /** 시간대는 저장하기 전에 확인한다. 오타 하나가 들어가면 그 뒤로 목록 조회와 틱이 통째로 죽는다. */
  private requireTimezone(params: Params): string {
    const tz = this.requireString(params, "timezone");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      throw new ControlError(mt("cli.control.timezoneUnknown", { tz }));
    }
  }

  /** 유예 상한. 훑는 창이 12시간이라 그보다 큰 값을 받으면 지킬 수 없는 약속이 된다. */
  private requireGrace(params: Params): number {
    const n = Number(params.grace);
    if (!Number.isFinite(n) || n < 0) throw new ControlError(mt("cli.control.graceMin"));
    if (n > 720) throw new ControlError(mt("cli.control.graceMax"));
    return Math.round(n);
  }

  private requireSchedules() {
    const api = this.deps.schedules?.();
    if (!api) throw new ControlError(mt("cli.control.noSchedules"));
    return api;
  }

  private resolveWorkspace(sel: string) {
    const st = this.deps.state();
    const byId = st.model.workspaces.find((x) => x.id === sel);
    if (byId) return byId;
    // Windows 경로는 끝의 \ 나 대소문자가 달라도 같은 폴더다
    const byPath = st.model.workspaces.find((x) => x.path && (process.platform === "win32" ? samePath(x.path, sel) : x.path === sel.replace(/\/+$/, "")));
    if (byPath) return byPath;
    const byName = st.model.workspaces.filter((x) => x.name.toLowerCase() === sel.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new ControlError(mt("cli.control.workspaceAmbiguous", { candidates: byName.map((w) => `${w.id} (${w.path || mt("cli.control.noPath")})`).join(", ") }), "ambiguous", { candidates: byName.map((w) => ({ id: w.id, name: w.name, path: w.path || null })) });
    throw new ControlError(mt("cli.control.workspaceNotFound", { sel }), "not_found");
  }

  private settled(tabId: string): { done: boolean; status: SessionStatus } {
    const s = this.deps.snapshot(tabId);
    // 턴이 안 돌고, 큐에 남은 프롬프트도 없고, 한도 재시도도 안 기다려야 "끝"
    return { done: !BUSY.includes(s.status) && s.pending === 0 && !s.limitWait, status: s.status };
  }

  /** 지금 걸려 있는 일이 다 끝날 때까지. 이미 끝나 있으면 바로 satisfied. 시간 초과는 오류가 아니라 satisfied:false. */
  private async waitIdle(tabId: string, timeoutMs: number): Promise<{ satisfied: boolean; status: SessionStatus; waitedMs: number }> {
    const started = Date.now();
    const limit = Math.max(0, Math.min(timeoutMs, 3_600_000));
    for (;;) {
      const { done, status } = this.settled(tabId);
      if (done) return { satisfied: true, status, waitedMs: Date.now() - started };
      if (Date.now() - started >= limit) return { satisfied: false, status, waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * 방금 보낸 메시지의 턴이 끝날 때까지: 보내기 전 이벤트 수(since) 뒤로 turn_result 가 기록되고 탭이 한가해져야 한다.
   * 큐에 들어갔거나(다른 턴 진행 중) 한도 대기에 걸린 프롬프트도 이 기준이면 실제로 실행된 뒤에야 satisfied 다.
   */
  private async waitTurn(tabId: string, since: number, timeoutMs: number): Promise<{ satisfied: boolean; status: SessionStatus; waitedMs: number }> {
    const started = Date.now();
    const limit = Math.max(0, Math.min(timeoutMs, 3_600_000));
    for (;;) {
      const { done, status } = this.settled(tabId);
      const turned = this.deps.events(tabId).slice(since).some((e) => e.type === "turn_result");
      if (done && turned) return { satisfied: true, status, waitedMs: Date.now() - started };
      if (Date.now() - started >= limit) return { satisfied: false, status, waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** 마지막 사용자 메시지 뒤의 어시스턴트 텍스트를 이어 붙인 것. */
  private lastReply(tabId: string): string {
    const blocks = replaySession(this.deps.events(tabId)).blocks;
    let i = blocks.length - 1;
    while (i >= 0 && blocks[i].kind !== "user") i--;
    return blocks
      .slice(i + 1)
      .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
  }
}
