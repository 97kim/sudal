// Codex 실행 어댑터. 기본 경로는 `codex app-server`(codex-app-server.ts): 탭마다 프로세스 하나를 살려 두고 스레드를 이어 가며
// 턴마다 `turn/start` 만 보낸다. 승인(명령 실행·파일 변경)은 서버 요청으로 받아 앱의 권한 카드로 잇는다.
// app-server 를 못 띄우는 옛 CLI 는 SDK exec 경로(턴마다 `codex exec`)로 폴백한다 — 그 경로엔 승인 콜백이 없어 정책을 샌드박스로만 매핑한다.

import { homedir } from "node:os";
import { CODEX_PERMISSION_TOOL } from "@shared/tool-state";
import type { ChatEvent, PermissionAnswer, PermissionPolicy, PermissionRequestEvent } from "@shared/chat-events";
import { buildCodexInput, type StoredChatImage } from "./chat-attachments";
import { mapCodexEvent } from "./codex-events";
import { AppServerError, CodexAppServer, classifyResumeFailure, mapAppServerNotification, normalizeFileChanges, resumeConflictMessage, type AppServerTurnContext, type FileChangeDto } from "./codex-app-server";
import { Codex } from "@openai/codex-sdk";
import { codexHasDeveloperInstructions } from "./cli-defaults";
import { launchSpec } from "./cli-launch";
import { appMsg, mainI18n, MsgError, mt } from "./i18n";
import type { Msg } from "@shared/i18n/msg";
import { clearCodexLangReminder, codexLangHookArgs, queueCodexLangReminder, trustCodexLangHooks } from "./codex-lang-hooks";
import { isOffLanguage } from "@shared/language-drift";
import type { Locale } from "@shared/i18n";


type ThreadOptions = import("@openai/codex-sdk").ThreadOptions;

export interface CodexRuntime {
  codexPath: string;
  env: Record<string, string>;
}

export interface CodexTurnRequest {
  /** 살려 둘 프로세스의 키(탭 id). */
  sessionKey: string;
  cwd: string;
  prompt: string;
  images: StoredChatImage[];
  sessionId: string | null;
  policy: PermissionPolicy;
  /** 지금 탭의 권한. 프로세스·스레드를 여는 동안 바꾼 권한이 첫 턴에도 먹게, 턴을 시작하는 순간에 다시 읽는다. */
  currentPolicy?(): PermissionPolicy;
  model?: string;
  abort: AbortController;
  onEvent(event: ChatEvent): void;
  /** app-server 경로에서 승인 요청이 오면 renderer 가 답할 때까지 기다린다. */
  requestPermission?(req: PermissionRequestEvent): Promise<PermissionAnswer>;
  log?(line: string): void;
}

/**
 * app-server 의 정책 매핑: ask 는 신뢰되지 않은 명령·쓰기마다 묻고, auto_edit 은 작업 디렉토리 밖의 쓰기처럼 추가 권한이 필요할 때만 묻고(네트워크는 허용), full 은 묻지 않는다.
 * auto_review 는 auto_edit 과 같은 샌드박스에서, 묻는 대신 Codex 의 검토 에이전트가 판단한다. 나머지는 approvalsReviewer 를 user 로 못박는다 —
 * 스레드·턴에 준 값이 다음 턴까지 이어지므로, 안 넘기면 auto_review 에서 돌아왔을 때 검토 에이전트가 남는다.
 */
const POLICY_TO_APPSERVER: Record<PermissionPolicy, { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown>; approvalsReviewer: "user" | "auto_review" }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" },
  auto_edit: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, approvalsReviewer: "user" },
  auto_review: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, approvalsReviewer: "auto_review" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" },
};

/** exec 폴백의 정책 매핑(승인을 물을 수 없다). */
const POLICY_TO_THREAD: Record<PermissionPolicy, Pick<ThreadOptions, "sandboxMode" | "networkAccessEnabled">> = {
  ask: { sandboxMode: "read-only" },
  auto_edit: { sandboxMode: "workspace-write", networkAccessEnabled: true },
  auto_review: { sandboxMode: "workspace-write", networkAccessEnabled: true },
  full: { sandboxMode: "danger-full-access", networkAccessEnabled: true },
};

export const CODEX_SESSION_IDLE_MS = 10 * 60 * 1000;
let sessionIdleMs = CODEX_SESSION_IDLE_MS;
/** 유휴 시간을 바꾼다. 지금 놀고 있는 프로세스의 타이머도 새 값으로 다시 건다. */
export function setCodexSessionIdleMs(ms: number): void {
  sessionIdleMs = ms;
  for (const s of live.values()) if (!s.turn && s.idleTimer) armIdle(s);
}
const INTERRUPT_GRACE_MS = 8000;

interface TurnCtx {
  req: CodexTurnRequest;
  turnId: string | null;
  ctx: AppServerTurnContext;
  resolve(): void;
  reject(e: unknown): void;
  permissionSeq: number;
}

interface LiveCodex {
  key: string;
  cwd: string;
  server: CodexAppServer;
  /** 스레드 start/resume 까지 끝나면 resolve. 예열 중 들어온 첫 턴이 이걸 기다린다. */
  ready: Promise<void>;
  threadId: string | null;
  /** app-server 가 thread/start·resume 응답으로 알려 준 실제 모델. 고른 모델이 없을 때(기본값) 헤더·사용량에 쓴다. */
  model: string | null;
  /** 화면에 마지막으로 알린 모델. 바뀌면 세션 이벤트를 다시 보낸다(다시 연 탭도 헤더가 채워지게). */
  announcedModel?: string;
  turn: TurnCtx | null;
  /**
   * 지금 권한. 턴을 시작할 때 app-server 에 넘긴 값으로 정하고, 턴 도중 사용자가 바꾸면 applyCodexPolicy 가 갱신한다.
   * app-server 는 턴 중에 정책을 바꿀 수 없어서, 풀어 주는 변경(묻기 → 편집 자동·전부 자동)은 승인 요청에 우리가 대신 답하는 것으로 적용한다.
   */
  policy: PermissionPolicy;
  /** 진행 중인 fileChange 아이템의 변경 내용(itemId → changes). 승인 요청엔 diff 가 없어 item/started 에서 받아 둔 것을 카드에 보여 준다. */
  fileChanges: Map<string, FileChangeDto[]>;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 이번 턴의 진행 설명이 앱 언어를 벗어났다. 다음 도구 결과 뒤에 언어 리마인더를 넣는다(codex-lang-hooks). */
  langDrift: boolean;
  /** 마지막 언어 리마인더 뒤로 끝난 도구 수. */
  toolsSinceReminder: number;
  log?(line: string): void;
}

/** 언어가 새지 않아도 도구가 이만큼 끝나면 리마인더를 다시 넣는다(Claude 와 같은 값). */
const REMIND_EVERY_TOOLS = 6;
const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);

const live = new Map<string, LiveCodex>();
const opening = new Map<string, Promise<LiveCodex>>();
/** app-server 를 한 번 못 띄웠으면(옛 CLI) 이 실행 동안은 exec 로만 간다. */
let appServerUnavailable: string | null = null;

export function closeCodexSession(key: string): void {
  const s = live.get(key);
  if (!s) return;
  live.delete(key);
  s.dead = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.server.close();
  s.turn?.reject(new MsgError("session.msg.sessionEnded"));
  s.turn = null;
}

export function closeAllCodexSessions(): void {
  for (const key of [...live.keys()]) closeCodexSession(key);
}

function armIdle(s: LiveCodex) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (live.get(s.key) === s && !s.turn) {
      s.log?.(`[codex ${s.key}] idle ${sessionIdleMs}ms — 프로세스 종료`);
      closeCodexSession(s.key);
    }
  }, sessionIdleMs);
  s.idleTimer.unref?.();
}

function openSession(runtime: CodexRuntime, key: string, cwd: string, log?: (line: string) => void): Promise<LiveCodex> {
  const inflight = opening.get(key);
  if (inflight) return inflight;
  const p = openSessionNow(runtime, key, cwd, log).finally(() => {
    if (opening.get(key) === p) opening.delete(key);
  });
  opening.set(key, p);
  return p;
}

async function openSessionNow(runtime: CodexRuntime, key: string, cwd: string, log?: (line: string) => void): Promise<LiveCodex> {
  const s: LiveCodex = { key, cwd, server: null as unknown as CodexAppServer, ready: Promise.resolve(), threadId: null, model: null, policy: "ask", turn: null, fileChanges: new Map(), dead: false, idleTimer: null, langDrift: false, toolsSinceReminder: 0, log };
  const server = new CodexAppServer({
    log,
    onNotification: (method, params) => handleNotification(s, method, params),
    onServerRequest: (method, params) => handleServerRequest(s, method, params),
    onExit: (code, error) => {
      if (live.get(key) === s) live.delete(key);
      s.dead = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.turn?.reject(error ? new Error(error) : new MsgError("session.msg.codexExited", { code: code ?? "?" }));
      s.turn = null;
    },
  });
  s.server = server;
  await server.start(runtime.codexPath, runtime.env, cwd, codexLangHookArgs());
  await trustCodexLangHooks(server, cwd, log);
  live.set(key, s);
  return s;
}

function handleNotification(s: LiveCodex, method: string, params: Record<string, unknown>) {
  const t = s.turn;
  if (method === "thread/started") {
    const th = params.thread as { id?: string } | undefined;
    if (th?.id) s.threadId = th.id;
    return;
  }
  if (!t) return;
  // 이 스레드·이 턴의 알림만. turnId 가 아직 없으면(turn/start 응답 전) 스레드 기준으로 받는다.
  if (params.threadId && s.threadId && params.threadId !== s.threadId) return;
  if (t.turnId && params.turnId && params.turnId !== t.turnId) return;
  trackFileChanges(s, method, params);
  trackLanguage(s, method, params);
  for (const e of mapAppServerNotification(method, params, Date.now(), t.ctx)) t.req.onEvent(e);
  if (method === "turn/completed") {
    s.turn = null;
    t.resolve();
  }
}

/**
 * 한 턴에 도구를 여러 번 부르면 영어 도구 출력이 쌓여 답이 영어로 넘어간다. 넘어간 것이 보이거나 도구가 몇 번 끝나면
 * 다음 도구 결과 뒤에 언어 리마인더를 넣게 한다(Claude 어댑터의 PostToolBatch 와 같은 규칙).
 */
function trackLanguage(s: LiveCodex, method: string, params: Record<string, unknown>) {
  if (method !== "item/completed" || !s.threadId) return;
  const item = params.item as { type?: string; text?: unknown } | undefined;
  if (item?.type === "agentMessage" && typeof item.text === "string" && isOffLanguage(item.text, mainI18n().language as Locale)) s.langDrift = true;
  else if (item?.type && TOOL_ITEMS.has(item.type)) s.toolsSinceReminder++;
  else return;
  if (!s.langDrift && s.toolsSinceReminder < REMIND_EVERY_TOOLS) return;
  s.langDrift = false;
  s.toolsSinceReminder = 0;
  queueCodexLangReminder(s.threadId);
}

/** fileChange 아이템의 변경 내용을 아이템이 사는 동안 기억한다(item/started → patchUpdated → item/completed). */
function trackFileChanges(s: LiveCodex, method: string, params: Record<string, unknown>) {
  if (method === "item/fileChange/patchUpdated") {
    if (typeof params.itemId === "string") s.fileChanges.set(params.itemId, normalizeFileChanges(params.changes));
    return;
  }
  if (method !== "item/started" && method !== "item/completed") return;
  const item = params.item as { type?: string; id?: string; changes?: unknown } | undefined;
  if (item?.type !== "fileChange" || typeof item.id !== "string") return;
  if (method === "item/started") s.fileChanges.set(item.id, normalizeFileChanges(item.changes));
  else s.fileChanges.delete(item.id);
}

/** 승인 요청 → 앱의 권한 카드. 답이 allow 면 accept(always 면 acceptForSession), 아니면 decline. 진행 중인 턴이 없으면 거부. */
async function handleServerRequest(s: LiveCodex, method: string, params: Record<string, unknown>): Promise<unknown> {
  const t = s.turn;
  if (!t || !t.req.requestPermission) throw new Error(mt("prompt.codex.noTurnApprove"));
  const itemId = typeof params.itemId === "string" ? params.itemId : `req-${Date.now()}`;
  const ask = async (tool: string, title: { message: string; msg: Msg }, input: Record<string, unknown>, description?: string) => {
    // 턴 도중 권한을 풀었으면 사람에게 묻지 않고 허용한다(전부 자동은 모두, 편집 자동은 파일 변경만 — Claude 의 acceptEdits 와 같은 뜻).
    if (s.policy === "full" || (s.policy === "auto_edit" && tool === "ApplyPatch")) return { behavior: "allow" as const };
    const requestId = `${itemId}#${++t.permissionSeq}`;
    const event: PermissionRequestEvent = {
      type: "permission_request",
      ts: Date.now(),
      requestId,
      toolUseId: itemId,
      tool,
      input,
      title: title.message,
      titleMsg: title.msg,
      description,
      canAlwaysAllow: true,
    };
    t.req.onEvent(event);
    t.req.onEvent({ type: "status", ts: Date.now(), status: "waiting_permission" });
    const answer = await t.req.requestPermission!(event);
    t.req.onEvent({ type: "permission_resolved", ts: Date.now(), requestId, behavior: answer.behavior });
    t.req.onEvent({ type: "status", ts: Date.now(), status: "running" });
    return answer;
  };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const a = await ask("Bash", appMsg("session.msg.approval.runCommand"), { command: params.command ?? "", cwd: params.cwd ?? "" }, typeof params.reason === "string" ? params.reason : undefined);
      if (t.req.abort.signal.aborted) return { decision: "cancel" };
      return { decision: a.behavior === "allow" ? (a.always ? "acceptForSession" : "accept") : "decline" };
    }
    case "item/fileChange/requestApproval": {
      // 요청 자체엔 변경 내용이 없다 — 같은 itemId 의 item/started 에서 받아 둔 changes(경로·종류·diff)를 붙인다.
      const changes = s.fileChanges.get(itemId) ?? [];
      const title = changes.length > 0 ? appMsg("session.msg.approval.fileChanges", { count: changes.length }) : appMsg("session.msg.approval.fileChange");
      const a = await ask("ApplyPatch", title, { changes, grantRoot: params.grantRoot ?? "" }, typeof params.reason === "string" ? params.reason : undefined);
      if (t.req.abort.signal.aborted) return { decision: "cancel" };
      return { decision: a.behavior === "allow" ? (a.always ? "acceptForSession" : "accept") : "decline" };
    }
    case "item/permissions/requestApproval": {
      const a = await ask(CODEX_PERMISSION_TOOL, appMsg("session.msg.approval.permissions"), { permissions: params.permissions ?? {} }, typeof params.reason === "string" ? params.reason : undefined);
      if (a.behavior !== "allow") throw new Error(mt("prompt.codex.denied"));
      return { permissions: params.permissions ?? {}, scope: "turn" };
    }
    default:
      // 사용자 입력 요청·MCP elicitation 등은 아직 UI 가 없다 — 거부로 답해 턴이 멈추지 않게 한다.
      throw new Error(mt("prompt.codex.unsupported", { method }));
  }
}

/** 스레드가 맞지 않으면(cwd·세션 id 다름) 내리고 새로 연다. 스레드는 첫 턴 전에 start/resume 해 둔다. */
async function sessionFor(runtime: CodexRuntime, req: Pick<CodexTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log">): Promise<LiveCodex> {
  const inflight = opening.get(req.sessionKey);
  if (inflight) await inflight.catch(() => {});
  const cur = live.get(req.sessionKey);
  if (cur && !cur.dead) {
    await cur.ready.catch(() => {}); // 예열이 스레드를 여는 중이면 끝날 때까지
    const sameThread = req.sessionId === null || cur.threadId === null || req.sessionId === cur.threadId;
    if (cur.cwd === req.cwd && sameThread && cur.threadId) return cur;
    if (cur.turn) return cur;
    closeCodexSession(req.sessionKey);
  }
  const s = await openSession(runtime, req.sessionKey, req.cwd, req.log);
  if (s.threadId) return s;
  // 스레드 열기를 ready 로 묶는다 — 같은 키의 다른 호출은 위에서 이걸 기다린다.
  s.ready = openThread(s, req).catch((e) => {
    closeCodexSession(s.key);
    throw e;
  });
  await s.ready;
  return s;
}

async function openThread(s: LiveCodex, req: Pick<CodexTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log"> & { onEvent?: CodexTurnRequest["onEvent"] }): Promise<void> {
  const map = POLICY_TO_APPSERVER[req.policy];
  // developerInstructions 는 설정의 developer_instructions 를 대신한다(덧붙지 않는다) — 사용자가 정해 둔 것이 있으면 싣지 않는다.
  const ownInstructions = codexHasDeveloperInstructions(process.env, homedir(), req.cwd);
  const base = { cwd: req.cwd, model: req.model ?? null, approvalPolicy: map.approvalPolicy, approvalsReviewer: map.approvalsReviewer, sandbox: map.sandbox, ...(ownInstructions ? {} : { developerInstructions: mt("prompt.codex.instructions") }) };
  if (req.sessionId) {
    try {
      // 기록은 앱이 갖고 있으니 지난 턴 내용은 받지 않는다(전체 히스토리 하이드레이션은 deprecated).
      const r = await s.server.request<{ thread?: { id?: string }; model?: string }>("thread/resume", { ...base, threadId: req.sessionId, excludeTurns: true });
      s.threadId = r.thread?.id ?? req.sessionId;
      s.model = r.model || null;
      return;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (classifyResumeFailure(detail) === "conflict") {
        // 다른 Codex 가 스레드를 잡고 있다: 새 스레드로 갈아타면 대화 맥락을 잃으니 턴을 실패시키고 세션 id 는 지킨다.
        req.log?.(`[codex ${req.sessionKey}] resume 충돌(다른 writer): ${detail}`);
        throw new Error(resumeConflictMessage(req.sessionId, detail));
      }
      // 스레드가 정말 없으면 새로 시작한다(기록은 앱 쪽에 남아 있다). 사용자에게는 한 줄 알린다.
      req.log?.(`[codex ${req.sessionKey}] resume 실패 → 새 스레드: ${detail}`);
      req.onEvent?.({ type: "error", ts: Date.now(), fatal: false, ...appMsg("session.msg.codexThreadMissing", { id: req.sessionId.slice(0, 8), detail }) });
    }
  }
  const r = await s.server.request<{ thread?: { id?: string }; model?: string }>("thread/start", base);
  s.threadId = r.thread?.id ?? null;
  s.model = r.model || null;
  if (!s.threadId) throw new MsgError("session.msg.codexThreadOpen");
}

export type CodexWarmRequest = Pick<CodexTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log">;

/** 예열: 프로세스와 스레드를 미리 열어 둔다. app-server 를 못 쓰면 아무것도 안 한다. */
export async function warmCodexSession(runtime: CodexRuntime, req: CodexWarmRequest): Promise<"reused" | "opened" | "unavailable"> {
  if (appServerUnavailable) return "unavailable";
  if (opening.has(req.sessionKey)) return "reused";
  const cur = live.get(req.sessionKey);
  if (cur && !cur.dead && cur.cwd === req.cwd) return "reused";
  try {
    const s = await sessionFor(runtime, req);
    armIdle(s);
    return "opened";
  } catch (e) {
    markUnavailableIfStartupFailure(e, req.log);
    return "unavailable";
  }
}

function markUnavailableIfStartupFailure(e: unknown, log?: (line: string) => void) {
  const msg = e instanceof Error ? e.message : String(e);
  // 서브커맨드가 없거나(옛 CLI) 프로세스를 못 띄운 경우만 폴백으로 고정. 스레드/턴 오류는 그때그때.
  // 우리 쪽 실패는 code 로, CLI·OS 가 낸 원문은 문구로 판독한다.
  const startup = e instanceof AppServerError && (e.code === "exited" || (e.code === "no_response" && e.method === "initialize"));
  if (startup || /unrecognized subcommand|unexpected argument|ENOENT|spawn/i.test(msg)) {
    appServerUnavailable = msg;
    log?.(`[codex] app-server 를 쓸 수 없어 exec 로 폴백합니다: ${msg}`);
  }
}

export async function runCodexTurn(runtime: CodexRuntime, req: CodexTurnRequest): Promise<void> {
  if (req.abort.signal.aborted) throw new MsgError("session.msg.interrupted");
  if (appServerUnavailable) return runCodexTurnExec(runtime, req);
  let s: LiveCodex;
  try {
    s = await sessionFor(runtime, req);
  } catch (e) {
    markUnavailableIfStartupFailure(e, req.log);
    if (appServerUnavailable) return runCodexTurnExec(runtime, req);
    throw e;
  }
  if (!s.threadId) throw new MsgError("session.msg.codexThreadOpen");
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  // 스레드 id 를 세션 id 로 알린다(새 스레드면 이때 처음 알게 된다).
  // 고른 모델이 없으면(CLI 기본값) app-server 가 알려 준 실제 모델을 쓴다 — 헤더에 모델이 안 보이고 사용량이 모델 없이 쌓이지 않게.
  const model = req.model || s.model || undefined;
  if (s.threadId !== req.sessionId || (model && model !== s.announcedModel)) {
    req.onEvent({ type: "session", ts: Date.now(), sessionId: s.threadId, provider: "codex", model });
    s.announcedModel = model;
  }

  // 여는 동안에는 살아 있는 세션이 없어 applyCodexPolicy 가 바꾼 권한을 받을 곳이 없다 — 여기서 다시 읽는다
  const policy = req.currentPolicy?.() ?? req.policy;
  s.policy = policy;
  // 사용자 메시지마다 UserPromptSubmit 훅이 리마인더를 넣으므로 여기서 다시 센다.
  s.langDrift = false;
  s.toolsSinceReminder = 0;
  clearCodexLangReminder(s.threadId);
  const done = new Promise<void>((resolve, reject) => {
    s.turn = { req, turnId: null, ctx: { model, startedAt: Date.now(), lastUsage: null }, resolve, reject, permissionSeq: 0 };
  });
  const turn = s.turn!;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    if (turn.turnId) void s.server.request("turn/interrupt", { threadId: s.threadId, turnId: turn.turnId }, 10_000).catch(() => {});
    graceTimer = setTimeout(() => {
      if (s.turn === turn) closeCodexSession(s.key);
    }, INTERRUPT_GRACE_MS);
  };
  req.abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const map = POLICY_TO_APPSERVER[policy];
    const input: Record<string, unknown>[] = [
      ...req.images.map((i) => ({ type: "localImage", path: i.filePath })),
      { type: "text", text: req.prompt },
    ];
    const r = await s.server.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: s.threadId,
      input,
      cwd: req.cwd,
      model: req.model ?? null,
      approvalPolicy: map.approvalPolicy,
      approvalsReviewer: map.approvalsReviewer,
      sandboxPolicy: map.sandboxPolicy,
    });
    turn.turnId = r.turn?.id ?? null;
    if (req.abort.signal.aborted) onAbort();
    await done;
  } finally {
    req.abort.signal.removeEventListener("abort", onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    if (s.turn === turn) s.turn = null;
    if (live.get(s.key) === s && !s.dead) armIdle(s);
  }
}

/**
 * 스레드를 lastTurnId 턴까지(포함) 복사해 새 스레드를 만들고 그 id 를 돌려준다(app-server thread/fork).
 * 원래 탭의 app-server 에서 하면 fork 가 내는 thread/started 가 그 탭의 threadId 를 덮어쓴다 — 잠깐 쓰는 프로세스를 따로 띄운다.
 * 새 스레드는 디스크에 남으므로, 새 탭은 첫 턴에 평소처럼 thread/resume 으로 이어 간다.
 */
export async function forkCodexThread(
  runtime: CodexRuntime,
  req: { threadId: string; lastTurnId: string; cwd: string; model?: string; policy: PermissionPolicy; log?: (line: string) => void },
): Promise<string> {
  const server = new CodexAppServer({
    log: req.log,
    onNotification: () => {},
    onServerRequest: async () => {
      throw new Error(mt("prompt.codex.forkNoRequests"));
    },
    onExit: () => {},
  });
  try {
    await server.start(runtime.codexPath, runtime.env, req.cwd);
    const map = POLICY_TO_APPSERVER[req.policy];
    const r = await server.request<{ thread?: { id?: string } }>(
      "thread/fork",
      { threadId: req.threadId, lastTurnId: req.lastTurnId, cwd: req.cwd, model: req.model ?? null, approvalPolicy: map.approvalPolicy, approvalsReviewer: map.approvalsReviewer, sandbox: map.sandbox, excludeTurns: true },
      30_000,
    );
    const id = r.thread?.id;
    if (!id) throw new Error(mt("session.error.codexForkNoId"));
    return id;
  } finally {
    server.close();
  }
}

/**
 * 돌고 있는 턴에 지시를 끼워 넣는다(app-server turn/steer). 턴이 끝나기를 기다리지 않고 모델이 다음 걸음부터 반영한다.
 * expectedTurnId 로 "지금 그 턴" 인지 서버가 확인한다 — 그 사이 턴이 끝났으면 실패하고, 호출자는 대기열에 남긴다.
 * 리뷰·압축 턴은 끼워 넣을 수 없다(activeTurnNotSteerable).
 */
export async function steerCodexTurn(sessionKey: string, text: string, images: { filePath: string }[]): Promise<void> {
  const s = live.get(sessionKey);
  const t = s?.turn;
  if (!s || s.dead || !t?.turnId || !s.threadId) throw new Error(mt("session.error.codexNothingToSteer"));
  const input: Record<string, unknown>[] = [...images.map((i) => ({ type: "localImage", path: i.filePath })), { type: "text", text }];
  await s.server.request("turn/steer", { threadId: s.threadId, input, expectedTurnId: t.turnId }, 15_000);
}

/** 폴백: SDK exec 경로. 한 턴 = runStreamed 한 번, thread.started 의 id 로 다음 턴 resumeThread. */
export async function runCodexTurnExec(runtime: CodexRuntime, req: CodexTurnRequest): Promise<void> {
  // SDK 는 실행 파일을 shell 없이 띄운다 — Windows 의 codex.cmd 가 .exe 를 가리키면 그것을 준다.
  // node <js> 나 cmd.exe 를 거쳐야 하는 경우는 SDK 로 띄울 수 없다(.cmd 를 넘기면 EINVAL) — 무엇을 하면 되는지 알려 준다.
  const spec = launchSpec(runtime.codexPath, []);
  if (spec.shell || spec.args.length > 0) throw new Error(mt("main.error.codexCmdUnsupported", { path: runtime.codexPath }));
  const codex = new Codex({ codexPathOverride: spec.command, env: runtime.env });
  const threadOptions: ThreadOptions = {
    workingDirectory: req.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    model: req.model,
    ...POLICY_TO_THREAD[req.policy],
  };
  const thread = req.sessionId ? codex.resumeThread(req.sessionId, threadOptions) : codex.startThread(threadOptions);
  const input = req.images.length > 0 ? buildCodexInput(req.images.map((i) => i.filePath), req.prompt) : req.prompt;
  const ctx = { model: req.model, startedAt: Date.now() };
  let streamed = false;
  try {
    const { events } = await thread.runStreamed(input, { signal: req.abort.signal });
    for await (const event of events) {
      streamed = true;
      for (const e of mapCodexEvent(event, Date.now(), ctx)) req.onEvent(e);
    }
  } catch (e) {
    if (req.abort.signal.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!streamed && /experimental-json|unexpected argument|unrecognized|invalid.*argument/i.test(msg)) {
      throw new MsgError("session.msg.codexOutdated");
    }
    throw e;
  }
  if (typeof thread.id === "string" && thread.id && thread.id !== req.sessionId) {
    req.onEvent({ type: "session", ts: Date.now(), sessionId: thread.id, provider: "codex", model: req.model });
  }
}

/**
 * 진행 중인 턴에 권한 변경을 반영한다. app-server 는 턴 도중 승인 정책·샌드박스를 바꿀 수 없다 —
 * 풀어 주는 변경은 이후 승인 요청에 대신 답하는 것으로 바로 적용하고(샌드박스는 다음 턴부터), 조이는 변경은 다음 턴부터다
 * (턴을 "묻지 않음" 으로 시작했으면 요청이 아예 오지 않는다).
 */
export function applyCodexPolicy(sessionKey: string, policy: PermissionPolicy): "applied" | "next-turn" | "none" {
  const s = live.get(sessionKey);
  if (!s || s.dead) return "none";
  const rank: Record<PermissionPolicy, number> = { ask: 0, auto_edit: 1, auto_review: 2, full: 3 };
  // 검토 에이전트는 턴 도중에 붙일 수 없다 — auto_review 로 바꾸면 이번 턴은 지금처럼 사람이 답하고 다음 턴부터 바뀐다.
  const loosening = policy !== "auto_review" && rank[policy] >= rank[s.policy];
  s.policy = policy;
  return loosening ? "applied" : "next-turn";
}
