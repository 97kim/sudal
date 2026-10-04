// Claude Agent SDK 실행 어댑터. 탭(세션 키)마다 CLI 프로세스를 하나 살려 두고(streaming input), 턴마다 사용자 메시지를 흘려보낸다.
// 예전에는 턴마다 query() 를 새로 열어 프로세스 기동·MCP 연결·세션 복원 비용(3~5초)을 매번 냈다.
// SDK 메시지 → ChatEvent 변환은 claude-events.ts 가, 권한 응답 대기는 SessionManager 가 맡는다.

import type {
  ChatEvent,
  PermissionAnswer,
  PermissionPolicy,
  PermissionRequestEvent,
} from "@shared/chat-events";
import type { SlashCommandDto } from "@shared/slash-commands";
import type { ProviderRateLimitDto } from "@shared/ipc";
import { parseLiveTasks, parseTaskFinished, type LiveBackgroundTask, type TaskFinishedNote } from "@shared/bg-tasks";
import { buildClaudeUserMessage, type StoredChatImage } from "./chat-attachments";
import { ClaudeEventMapper, parseClaudeRateLimit } from "./claude-events";
import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import { claudeProgressNotes } from "./cli-defaults";
import { homedir } from "node:os";
import { MsgError, mt } from "./i18n";

type SdkOptions = import("@anthropic-ai/claude-agent-sdk").Options;
type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
type SDKMessage = import("@anthropic-ai/claude-agent-sdk").SDKMessage;
type PermissionMode = import("@anthropic-ai/claude-agent-sdk").PermissionMode;
type PermissionResult = import("@anthropic-ai/claude-agent-sdk").PermissionResult;
type PermissionUpdate = import("@anthropic-ai/claude-agent-sdk").PermissionUpdate;
type Query = import("@anthropic-ai/claude-agent-sdk").Query;

export interface ClaudeRuntime {
  pathToClaudeCodeExecutable: string;
  env: Record<string, string>;
}

export interface ClaudeTurnRequest {
  /** 살려 둘 프로세스의 키(탭 id). 같은 키의 다음 턴은 같은 프로세스로 간다. */
  sessionKey: string;
  cwd: string;
  prompt: string;
  images: StoredChatImage[];
  sessionId: string | null;
  policy: PermissionPolicy;
  model?: string;
  abort: AbortController;
  onEvent(event: ChatEvent): void;
  /** renderer 가 답할 때까지 resolve 되지 않는다. abort 되면 deny 로 resolve. */
  requestPermission(req: PermissionRequestEvent): Promise<PermissionAnswer>;
  log?(line: string): void;
  /** 턴 도중 알게 된 슬래시 커맨드 정보 (init 의 터미널 전용 목록, commands_changed 의 전체 목록). */
  onCommands?(patch: { commands?: SlashCommandDto[]; terminal?: string[] }): void;
  /** 구독 한도(5시간/주간 창) 관측값. 턴 중 rate_limit_event 가 올 때마다. */
  onRateLimit?(limit: ProviderRateLimitDto): void;
  /**
   * 백그라운드 작업 집합이 바뀌었다. 진행 중인 턴이 없어도 오고, 늘 "살아 있는 전체" 라 갈아 끼우면 된다.
   * 프로세스가 내려갈 때는 빈 배열로 한 번 부른다 — 그 집합은 그 프로세스의 것이라 남겨 두면 안 된다.
   */
  onBackgroundTasks?(sessionId: string, tasks: LiveBackgroundTask[], source: BackgroundTasksSource): void;
  /** 백그라운드 작업 하나가 끝났다(completed·failed·stopped). */
  onTaskFinished?(note: TaskFinishedNote): void;
  /**
   * 이 세션의 스트림이 끝났다. expected = 우리가 의도적으로 닫았다(탭 닫기·유휴 종료·설정 변경).
   * 예약 회차의 "끝을 못 봤다" 를 판정하려면 이게 있어야 한다 — 없으면 영영 진행 중으로 남는다.
   */
  onStreamEnded?(reason: string, expected: boolean): void;
  /**
   * 우리가 시작하지 않은 턴의 이벤트. 백그라운드 작업이 끝나면 CLI 가 스스로 이어서 일하는데,
   * 그 턴을 버리면 그 사이의 일이 통째로 사라진다(릴리즈가 끝났는데 화면엔 아무 말도 없는 것처럼).
   */
  onAmbientEvent?(event: ChatEvent): void;
  /** 그 턴에서 온 권한 요청. 턴이 없다고 거부하면 하던 일이 거기서 멈춘다. */
  requestAmbientPermission?(req: PermissionRequestEvent): Promise<PermissionAnswer>;
}

/**
 * 백그라운드 작업 목록이 어디서 왔나. "회차가 끝났나" 를 판정할 때 이 둘을 섞으면 안 된다 —
 * 프로세스가 죽어서 우리가 비운 목록(cleanup)을 근거로 삼으면 크래시가 성공이 된다.
 */
export type BackgroundTasksSource = "sdk" | "cleanup";

const POLICY_TO_MODE: Record<PermissionPolicy, PermissionMode> = {
  ask: "default",
  auto_edit: "acceptEdits",
  full: "bypassPermissions",
};

/**
 * 사용자의 답을 SDK canUseTool 결과로 바꾼다.
 * AskUserQuestion 은 권한이 아니라 질문이라 bypassPermissions 에서도 여기로 온다 — 허용이면 답을 `updatedInput.answers` 에 실어 돌려준다
 * (SDK 계약: 질문 문장 → 답 문자열). 답 없이 허용하면 CLI 가 빈 답으로 처리하므로 거부와 같게 다룬다.
 */
export function permissionResultFor(
  toolName: string,
  toolInput: Record<string, unknown>,
  answer: PermissionAnswer,
  suggestions?: PermissionUpdate[],
): PermissionResult {
  if (toolName === "AskUserQuestion") {
    if (answer.behavior === "allow" && answer.answers && Object.keys(answer.answers).length > 0) {
      return { behavior: "allow", updatedInput: { ...toolInput, answers: answer.answers } };
    }
    return { behavior: "deny", message: mt("prompt.claude.questionUnanswered"), interrupt: false };
  }
  if (answer.behavior === "allow") {
    return { behavior: "allow", updatedInput: toolInput, updatedPermissions: answer.always ? suggestions : undefined };
  }
  return { behavior: "deny", message: mt("prompt.claude.denied"), interrupt: false };
}

/** 턴이 없는 채로 이만큼 지나면 프로세스를 내린다(메모리·MCP 연결 점유). 다음 턴에 다시 뜬다. 설정에서 바꿀 수 있다. */
export const CLAUDE_SESSION_IDLE_MS = 10 * 60 * 1000;
let sessionIdleMs = CLAUDE_SESSION_IDLE_MS;
/** 유휴 시간을 바꾼다. 지금 놀고 있는 프로세스의 타이머도 새 값으로 다시 건다. */
export function setClaudeSessionIdleMs(ms: number): void {
  sessionIdleMs = ms;
  for (const s of live.values()) if (!s.turn && s.idleTimer) armIdle(s);
}
/** interrupt 뒤 result 가 이만큼 안 오면 프로세스를 끊는다. */
const INTERRUPT_GRACE_MS = 8000;

/** streaming input 용 푸시 큐. 닫으면 iterable 이 끝나고 CLI 는 정리 후 종료한다. */
export class InputQueue {
  private readonly items: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) {
    if (this.closed) return;
    this.items.push(m);
    this.waiter?.();
  }
  close() {
    this.closed = true;
    this.waiter?.();
  }
  async *iterate(): AsyncGenerator<SDKUserMessage, void, void> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.waiter = r));
      this.waiter = null;
    }
  }
}

interface TurnCtx {
  req: ClaudeTurnRequest;
  mapper: ClaudeEventMapper;
  resolve(): void;
  reject(e: unknown): void;
  permissionSeq: number;
}

interface LiveSession {
  key: string;
  cwd: string;
  /** thinking 블록의 진행 설명을 채팅 텍스트로 남길지. 세션을 열 때 CLI 에 넘기는 환경·설정으로 한 번 정한다(CLI 도 시작할 때 읽는다). */
  progressNotes: boolean;
  /** CLI 가 알려 준 세션 id(init/result). 새 탭이면 첫 init 때 채워진다. */
  sessionId: string | null;
  mode: PermissionMode;
  model: string | undefined;
  q: Query;
  input: InputQueue;
  turn: TurnCtx | null;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 턴 도중에 "전부 자동" 으로 바뀌었다. 프로세스 시작 플래그는 못 바꾸지만 승인 게이트가 우리 것이라
   * 여기서 허용해 주면 같은 결과가 된다. 반대 방향(조이기)은 프로세스가 아예 묻지 않으므로 할 수 없다.
   */
  autoApprove: boolean;
  /** 우리가 시작하지 않은 턴을 그리기 위한 통로와 매퍼. 매퍼는 그 턴이 끝나면 버린다. */
  onAmbientEvent?(event: ChatEvent): void;
  requestAmbientPermission?(req: PermissionRequestEvent): Promise<PermissionAnswer>;
  ambientMapper: ClaudeEventMapper | null;
  ambientSeq: number;
  /** SDK 가 알려 준 살아 있는 백그라운드 작업 수. 유휴 종료 판단에 쓴다. */
  liveTaskCount: number;
  /** 우리가 닫는 중이다(탭 닫기·유휴 종료 등). 스트림이 끝난 이유를 구분하려고 둔다. */
  closing: string | null;
  /** 후속 턴 때문에 유휴 종료를 한 번 미뤘다. 두 번은 미루지 않는다. */
  idleDeferred: boolean;
  log?(line: string): void;
  /** 턴과 무관하게 오는 신호를 보낼 곳. 턴이 새로 시작하면 그 턴의 것으로 갱신한다. */
  onBackgroundTasks?(sessionId: string, tasks: LiveBackgroundTask[], source: BackgroundTasksSource): void;
  onTaskFinished?(note: TaskFinishedNote): void;
  onStreamEnded?(reason: string, expected: boolean): void;
}

const live = new Map<string, LiveSession>();
/** 여는 중인 세션 — 예열과 첫 턴이 거의 동시에 오면 프로세스를 하나만 띄운다. */
const opening = new Map<string, Promise<LiveSession>>();

/** 테스트·진단용: 살아 있는 세션 키. */
export function liveClaudeSessions(): string[] {
  return [...live.keys()];
}

/** 프로세스를 내린다(탭 해제·대화 비우기·provider 전환·cwd 변경·앱 종료). 진행 중인 턴이 있으면 중단으로 끝난다. */
export function closeClaudeSession(key: string, reason = mt("session.msg.closed")): void {
  const s = live.get(key);
  if (!s) return;
  s.closing = reason;
  live.delete(key);
  s.dead = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.input.close();
  try {
    s.q.close();
  } catch {
    /* 이미 끝남 */
  }
  s.turn?.reject(new MsgError("session.msg.sessionEnded"));
  s.turn = null;
  // 살아 있던 백그라운드 작업 집합은 이 프로세스의 것이다 — 남겨 두면 끝나지 않는 표시가 된다.
  // 출처를 cleanup 으로 밝힌다: 이건 "일이 끝났다" 가 아니라 "더는 모른다" 는 뜻이다.
  s.onBackgroundTasks?.(s.sessionId ?? "", [], "cleanup");
}

export function closeAllClaudeSessions(): void {
  for (const key of [...live.keys()]) closeClaudeSession(key);
}

/**
 * 지금 도는 것을 끊는다. 프로세스는 살려 둔다.
 * 우리가 시작한 턴에는 abort 가 달려 있지만, 백그라운드가 끝나 CLI 가 스스로 이어간 턴에는 그게 없다 —
 * 그 턴을 멈출 수 있는 곳은 여기뿐이다. 유예 안에 안 끝나면 그때는 프로세스를 내린다.
 */
export function interruptClaudeSession(key: string): boolean {
  const s = live.get(key);
  if (!s || s.dead) return false;
  void s.q.interrupt().catch(() => {});
  setTimeout(() => {
    // 아직도 돌고 있으면 내린다. interrupt 를 무시하는 CLI 를 붙잡아 두면
    // 사용자는 중단을 눌렀는데 일이 계속되는 것을 보게 된다.
    if (live.get(key) === s && !s.dead && (s.turn || s.ambientMapper)) closeClaudeSession(key, mt("session.msg.stoppedShort"));
  }, INTERRUPT_GRACE_MS);
  return true;
}

function armIdle(s: LiveSession) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (live.get(s.key) !== s || s.turn) return;
    // 우리가 시작하지 않은 턴(백그라운드 결과를 처리하는 후속 턴)이 돌고 있으면 내리지 않는다.
    // s.turn 만 보면 그 턴은 안 보인다 — 첫 result 뒤 10분에 답을 쓰던 중인 세션을 죽인다.
    // 다만 mapper 가 있다는 것만으로 무한히 미루지는 않는다 — 턴 밖 잡음(commands_changed 등)도
    // mapper 를 만들고, result 가 와야만 지워진다. 한 번만 더 기다린다.
    if (s.ambientMapper && !s.idleDeferred) {
      s.idleDeferred = true;
      armIdle(s);
      return;
    }
    // 턴이 끝났어도 백그라운드 작업이 살아 있으면 내리지 않는다. 15분짜리 명령을 띄워 두고
    // 턴만 끝낸 세션을 10분 뒤에 죽이면, 그 일도 그 결과를 처리할 후속 턴도 함께 사라진다.
    if (s.liveTaskCount > 0) {
      s.log?.(`[claude ${s.key}] idle 이지만 백그라운드 ${s.liveTaskCount}개가 살아 있어 유지합니다.`);
      armIdle(s);
      return;
    }
    s.log?.(`[claude ${s.key}] idle ${sessionIdleMs}ms — 프로세스 종료`);
    closeClaudeSession(s.key);
  }, sessionIdleMs);
  s.idleTimer.unref?.();
}

function openSession(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<LiveSession> {
  const inflight = opening.get(req.sessionKey);
  if (inflight) return inflight;
  const p = openSessionNow(runtime, req).finally(() => {
    if (opening.get(req.sessionKey) === p) opening.delete(req.sessionKey);
  });
  opening.set(req.sessionKey, p);
  return p;
}

/**
 * 세션을 upToMessageId 항목까지(포함) 새 세션 파일로 복사하고 새 세션 id 를 돌려준다(SDK forkSession).
 * 파일 되감기 기록은 복사되지 않는다. SDK 는 세션 파일 위치를 이 프로세스의 CLAUDE_CONFIG_DIR 로 찾으므로,
 * CLI 에 넘기는 환경에만 있으면 여기에도 맞춘다.
 */
export async function forkClaudeSession(runtime: ClaudeRuntime, sessionId: string, cwd: string, upToMessageId: string): Promise<string> {
  const cfg = runtime.env.CLAUDE_CONFIG_DIR;
  if (cfg && !process.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = cfg;
  const r = await forkSession(sessionId, { dir: cwd, upToMessageId });
  return r.sessionId;
}

async function openSessionNow(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<LiveSession> {
  const input = new InputQueue();
  const s: LiveSession = {
    key: req.sessionKey,
    cwd: req.cwd,
    progressNotes: claudeProgressNotes(runtime.env, homedir(), req.cwd),
    sessionId: req.sessionId,
    mode: POLICY_TO_MODE[req.policy],
    model: req.model,
    q: null as unknown as Query,
    input,
    turn: null,
    dead: false,
    idleTimer: null,
    autoApprove: req.policy === "full",
    onAmbientEvent: req.onAmbientEvent,
    requestAmbientPermission: req.requestAmbientPermission,
    ambientMapper: null,
    ambientSeq: 0,
    liveTaskCount: 0,
    closing: null,
    idleDeferred: false,
    log: req.log,
    onBackgroundTasks: req.onBackgroundTasks,
    onTaskFinished: req.onTaskFinished,
  };
  const options: SdkOptions = {
    cwd: req.cwd,
    env: runtime.env,
    pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
    model: req.model,
    resume: req.sessionId ?? undefined,
    includePartialMessages: true,
    // SDK 는 systemPrompt 를 안 주면 빈 시스템 프롬프트로 띄운다 — 터미널 Claude Code 와 같은 기본 프롬프트(작업 전 한 줄 설명·간결한 답·도구 사용 규칙)를 쓴다
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      // 앱 화면은 툴카드가 접혀 있어 터미널보다 맥락이 덜 보인다 — 도구 사이사이에 짧은 설명을 두게 한다.
      // 해요체로 쓴다: 해라체로 쓰면 모델이 그 말투("확인한다")를 진행 설명에 그대로 따라 썼다.
      // 언어·말투 규칙은 따로 못박는다: 짧은 새 세션에서도 진행 설명이 영어로 넘어가는 일이 있었다.
      append: [
        mt("prompt.claude.progress.intro"),
        mt("prompt.claude.progress.before"),
        mt("prompt.claude.progress.after"),
        mt("prompt.claude.progress.short"),
        mt("prompt.claude.progress.language"),
      ].join("\n"),
    },
    // 위 언어 규칙은 세션을 시작할 때 한 번만 들어가 대화가 길어지면 약해진다. 한 번 다른 언어로 새면 앞선 답을 따라 다음 턴도 그 언어로 시작했다.
    // 사용자 메시지마다 가장 가까운 맥락에 다시 넣는다. 사용자가 쓴 글과 화면의 말풍선은 그대로다.
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: mt("prompt.claude.languageReminder") },
            }),
          ],
        },
      ],
    },
    permissionMode: s.mode,
    allowDangerouslySkipPermissions: req.policy === "full" ? true : undefined,
    stderr: (line) => (s.turn?.req.log ?? s.log)?.(line),
    // 권한 요청은 "지금 진행 중인 턴" 의 콜백으로 — 프로세스는 턴을 넘어 살기 때문에 options 에 고정할 수 없다.
    canUseTool: async (toolName, toolInput, ctx) => {
      const t = s.turn;
      // 우리가 시작하지 않은 턴도 승인을 받아야 한다 — 거부하면 하던 일이 거기서 멈춘다.
      const onEvent = t ? t.req.onEvent : s.onAmbientEvent;
      const ask = t ? t.req.requestPermission : s.requestAmbientPermission;
      if (!onEvent || !ask) return { behavior: "deny", message: mt("prompt.claude.noTurn"), interrupt: false };
      // 도중에 "전부 자동" 으로 바꾼 경우 여기서 끊는다 — 화면까지 왕복하지 않는다.
      // AskUserQuestion 은 권한이 아니라 질문이라 사람이 답해야 한다(빈 답은 거부와 같다).
      if (s.autoApprove && toolName !== "AskUserQuestion") {
        return permissionResultFor(toolName, toolInput, { behavior: "allow" }, ctx.suggestions);
      }
      const requestId = `${ctx.toolUseID}#${t ? ++t.permissionSeq : ++s.ambientSeq}`;
      const event: PermissionRequestEvent = {
        type: "permission_request",
        ts: Date.now(),
        requestId,
        toolUseId: ctx.toolUseID,
        tool: toolName,
        input: toolInput,
        title: ctx.title,
        description: ctx.description,
        canAlwaysAllow: Boolean(ctx.suggestions && ctx.suggestions.length > 0),
      };
      onEvent(event);
      onEvent({ type: "status", ts: Date.now(), status: "waiting_permission" });
      const answer = await ask(event);
      onEvent({ type: "permission_resolved", ts: Date.now(), requestId, behavior: answer.behavior });
      onEvent({ type: "status", ts: Date.now(), status: "running" });
      return permissionResultFor(toolName, toolInput, answer, ctx.suggestions);
    },
  };
  s.q = query({ prompt: input.iterate(), options });
  live.set(req.sessionKey, s);
  void pump(s);
  return s;
}

/** 프로세스가 사는 동안 메시지를 계속 읽어 진행 중인 턴에 전달한다. result 가 턴의 끝. */
async function pump(s: LiveSession) {
  try {
    for await (const message of s.q) handleMessage(s, message);
    // 예외 없이 끝났다 = 프로세스가 스스로 스트림을 닫았다.
    if (process.env.WORKBENCH_DEBUG_SDK) console.log(`[sdkend ${s.key.slice(0, 6)}] 정상종료(EOF) turn=${s.turn ? "있음" : "없음"}`);
    s.onStreamEnded?.(s.closing ?? mt("session.msg.streamClosed"), s.closing !== null);
  } catch (e) {
    if (process.env.WORKBENCH_DEBUG_SDK)
      console.log(`[sdkend ${s.key.slice(0, 6)}] 예외 turn=${s.turn ? "있음" : "없음"} ${e instanceof Error ? e.message : String(e)}`);
    s.onStreamEnded?.(s.closing ?? (e instanceof Error ? e.message : String(e)), s.closing !== null);
    s.turn?.reject(e);
    s.turn = null;
  } finally {
    // 프로세스가 끝났다(정상 종료·크래시·close). 진행 중이던 턴은 실패로.
    if (live.get(s.key) === s) live.delete(s.key);
    s.dead = true;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.turn?.reject(new MsgError("session.msg.claudeExited"));
    s.turn = null;
    s.onBackgroundTasks?.(s.sessionId ?? "", [], "cleanup");
  }
}

function handleMessage(s: LiveSession, message: SDKMessage) {
  const t = s.turn;
  // 진단용: 무엇이 어떤 순서로 오는지. 회차 완료 판정처럼 "순서" 가 답인 문제는 이게 없으면 추측이 된다.
  // WORKBENCH_DEBUG_SDK 일 때만 찍는다.
  if (process.env.WORKBENCH_DEBUG_SDK) {
    const m = message as { type: string; subtype?: string; state?: string; status?: string; is_error?: boolean; tasks?: unknown[] };
    const extra = [
      m.subtype ? `subtype=${m.subtype}` : "",
      m.state ? `state=${m.state}` : "",
      m.status ? `status=${m.status}` : "",
      m.is_error !== undefined ? `is_error=${m.is_error}` : "",
      Array.isArray(m.tasks) ? `tasks=${m.tasks.length}` : "",
      // i18n-ignore: log
      t ? "" : "(턴밖)",
    ].filter(Boolean).join(" ");
    console.log(`[sdkmsg ${s.key.slice(0, 6)}] ${m.type} ${extra}`);
  }
  if (message.type === "system") {
    if (message.subtype === "init") {
      s.sessionId = message.session_id;
      if (message.terminal_slash_commands) t?.req.onCommands?.({ terminal: message.terminal_slash_commands });
    } else if (message.subtype === "compact_boundary") {
      // 압축은 세션 안의 경계다 — 세션 id 는 그대로다. 화면에 구분선으로 남긴다.
      const m = message.compact_metadata;
      t?.req.onEvent({
        type: "compacted",
        ts: Date.now(),
        trigger: m.trigger,
        preTokens: m.pre_tokens,
        postTokens: m.post_tokens,
      });
    } else if (message.subtype === "background_tasks_changed") {
      // 살아 있는 백그라운드 작업 전체. 턴이 없어도 온다 — 턴에 묶으면 "턴은 끝났는데 일은 도는" 구간을 놓친다.
      {
        const tasks = parseLiveTasks(message.tasks);
        s.liveTaskCount = tasks.length;
        s.onBackgroundTasks?.(message.session_id ?? s.sessionId ?? "", tasks, "sdk");
      }
    } else if (message.subtype === "task_notification") {
      const note = parseTaskFinished(message);
      if (note) s.onTaskFinished?.(note);
    } else if (message.subtype === "commands_changed") {
      t?.req.onCommands?.({
        commands: message.commands.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          argumentHint: c.argumentHint ?? "",
          aliases: c.aliases && c.aliases.length > 0 ? c.aliases : undefined,
        })),
      });
    }
  }
  if (message.type === "rate_limit_event") {
    const limit = parseClaudeRateLimit(message.rate_limit_info, Date.now());
    if (limit) t?.req.onRateLimit?.(limit);
  }
  if (!t) {
    // 우리가 시작하지 않은 턴(백그라운드 작업이 끝나 CLI 가 스스로 이어갈 때)도 그대로 보여 준다.
    // 예전엔 여기서 버렸다 — 그 사이에 한 일이 통째로 사라져, 끝났는데 아무 말도 없는 것처럼 보였다.
    const onEvent = s.onAmbientEvent;
    if (!onEvent) return;
    // 이 턴이 도는 동안은 유휴 타이머를 계속 뒤로 민다. 한 번만 미루면 후속 턴이 시작한 직후에도
    // 잘린다(첫 result 10분 뒤 지연 소진 → 19분 59초에 후속 턴 시작 → 20분에 종료).
    s.idleDeferred = false;
    if (live.get(s.key) === s && !s.dead) armIdle(s);
    if (!s.ambientMapper) s.ambientMapper = new ClaudeEventMapper({ progressNotes: s.progressNotes });
    for (const e of s.ambientMapper.map(message, Date.now())) onEvent(e);
    if (message.type === "result") s.ambientMapper = null;
    return;
  }
  for (const e of t.mapper.map(message, Date.now())) t.req.onEvent(e);
  if (message.type === "result") {
    if (message.session_id) s.sessionId = message.session_id;
    s.turn = null;
    t.resolve();
  }
}

/** 살아 있는 세션을 이 턴에 맞추거나(정책·모델), 맞출 수 없으면(cwd·세션 id 가 다름) 내리고 새로 연다. */
async function sessionFor(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<LiveSession> {
  const inflight = opening.get(req.sessionKey);
  if (inflight) await inflight.catch(() => {}); // 예열이 여는 중이면 그 프로세스를 쓴다
  const cur = live.get(req.sessionKey);
  if (cur && !cur.dead) {
    const sameSession = req.sessionId === null || cur.sessionId === null || req.sessionId === cur.sessionId;
    const mode = POLICY_TO_MODE[req.policy];
    // bypassPermissions 는 프로세스 시작 플래그(allowDangerouslySkipPermissions)와 묶여 있어 setPermissionMode 로 오가면 안 된다 — 새로 띄운다.
    const bypassFlip = (mode === "bypassPermissions") !== (cur.mode === "bypassPermissions");
    if (cur.cwd === req.cwd && sameSession && !cur.turn && !bypassFlip) {
      if (mode !== cur.mode) {
        await cur.q.setPermissionMode(mode);
        cur.mode = mode;
      }
      if ((req.model ?? undefined) !== cur.model) {
        await cur.q.setModel(req.model);
        cur.model = req.model;
      }
      return cur;
    }
    closeClaudeSession(req.sessionKey);
  }
  return openSession(runtime, req);
}

/**
 * 턴 도중에 권한 설정이 바뀌었다. 살아 있는 프로세스에 바로 반영한다 — 다음 턴까지 기다리면
 * "계속 물어봐서 바꿨는데 그 턴 내내 계속 묻는" 일이 생긴다.
 *
 * 돌려주는 값: applied = 지금 턴부터 먹는다 · next-turn = 다음 턴부터다 · none = 살아 있는 세션이 없다.
 */
export async function applyClaudePolicy(sessionKey: string, policy: PermissionPolicy): Promise<"applied" | "next-turn" | "none"> {
  const s = live.get(sessionKey);
  if (!s || s.dead) return "none";
  s.autoApprove = policy === "full";
  if (policy === "full") return "applied";
  // bypassPermissions 로 띄운 프로세스는 우리에게 묻지 않는다 — 조이는 변경은 다음 턴에 새로 띄우며 적용된다.
  if (s.mode === "bypassPermissions") return "next-turn";
  const mode = POLICY_TO_MODE[policy];
  if (mode === s.mode) return "applied";
  try {
    await s.q.setPermissionMode(mode);
    s.mode = mode;
    return "applied";
  } catch (e) {
    s.log?.(`[claude ${sessionKey}] 권한 모드 변경 실패: ${describeErr(e)}`);
    return "next-turn";
  }
}

function describeErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type ClaudeWarmRequest = Pick<ClaudeTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log" | "onBackgroundTasks" | "onTaskFinished" | "onAmbientEvent" | "requestAmbientPermission">;

/**
 * 예열: 턴 없이 프로세스만 미리 띄운다(기동·MCP 연결·세션 복원을 사용자가 첫 메시지를 보내기 전에 끝내 둔다).
 * 이미 맞는 세션이 살아 있으면 아무것도 안 한다. 유휴 타이머는 그대로 걸린다.
 */
export async function warmClaudeSession(runtime: ClaudeRuntime, req: ClaudeWarmRequest): Promise<"reused" | "opened"> {
  if (opening.has(req.sessionKey)) return "reused";
  const cur = live.get(req.sessionKey);
  const mode = POLICY_TO_MODE[req.policy];
  if (cur && !cur.dead) {
    const sameSession = req.sessionId === null || cur.sessionId === null || req.sessionId === cur.sessionId;
    const bypassFlip = (mode === "bypassPermissions") !== (cur.mode === "bypassPermissions");
    if (cur.cwd === req.cwd && sameSession && !bypassFlip) return "reused";
    if (cur.turn) return "reused"; // 턴 중인 프로세스는 건드리지 않는다
    closeClaudeSession(req.sessionKey);
  }
  const s = await openSession(runtime, {
    ...req,
    prompt: "",
    images: [],
    abort: new AbortController(),
    onEvent: () => {},
    requestPermission: async () => ({ behavior: "deny" }),
  });
  armIdle(s);
  return "opened";
}

export async function runClaudeTurn(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<void> {
  if (req.abort.signal.aborted) throw new MsgError("session.msg.interrupted");
  const s = await sessionFor(runtime, req);
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  // 턴과 무관하게 오는 신호는 가장 최근 턴의 통로로 보낸다(탭마다 고정된 통로라 턴이 끝나도 유효하다).
  s.onBackgroundTasks = req.onBackgroundTasks;
  s.onTaskFinished = req.onTaskFinished;
  s.onAmbientEvent = req.onAmbientEvent;
  s.requestAmbientPermission = req.requestAmbientPermission;
  s.onStreamEnded = req.onStreamEnded;
  s.idleDeferred = false;
  const done = new Promise<void>((resolve, reject) => {
    s.turn = { req, mapper: new ClaudeEventMapper({ progressNotes: s.progressNotes }), resolve, reject, permissionSeq: 0 };
  });
  // 중단: 프로세스는 살려 두고 이 턴만 끊는다. result 가 안 오면 프로세스를 내린다.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    void s.q.interrupt().catch(() => {});
    graceTimer = setTimeout(() => {
      if (s.turn?.req === req) closeClaudeSession(s.key);
    }, INTERRUPT_GRACE_MS);
  };
  req.abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    s.input.push(buildClaudeUserMessage(req.images, req.prompt));
    await done;
  } finally {
    req.abort.signal.removeEventListener("abort", onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    if (live.get(s.key) === s && !s.dead) armIdle(s);
  }
}

