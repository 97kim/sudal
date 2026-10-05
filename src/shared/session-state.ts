// 세션 상태 머신 — 순수 리듀서. UI 는 이 상태를 그리기만 하고, main 은 재생(replay)에 쓴다.
// 부수효과 없음. node:test 로 검증 (session-state.test.ts).

import { ko } from "./i18n/ko";
import type { Msg } from "./i18n/msg";
import {
  addUsage,
  ZERO_USAGE,
  type ChatEvent,
  type PermissionRequestEvent,
  type SessionStatus,
  type TokenUsage,
  type TurnResultEvent,
  type VerifyCommandResult,
  type FanoutVariant,
  type PermissionPolicy,
  type OrchestrationEvent,
  type ForkPoint,
} from "./chat-events";
import type { Provider } from "./ipc";

export interface UserBlock {
  kind: "user";
  id: string;
  text: string;
  images?: { dataUrl: string }[];
  ts: number;
}

export interface TextBlock {
  kind: "text";
  id: string;
  text: string;
  streaming: boolean;
}

export interface ToolBlock {
  kind: "tool";
  id: string; // === toolUseId
  /** 카드가 처음 생긴 시각(경과 시간 표시용). */
  ts: number;
  name: string;
  input: unknown;
  partial: boolean;
  /** outputMsg: 앱이 대신 채운 결과 문구(도구가 결과 없이 끝났을 때). 그릴 때 번역한다. */
  result?: { output: string; isError: boolean; outputMsg?: Msg };
  permission?: "pending" | "allowed" | "denied";
  /** Skill·Agent 가 띄운 하위 에이전트의 활동(화면 전용, 재생하면 없다). */
  subagent?: SubagentProgress;
}

export interface SubagentProgress {
  /** 하위 에이전트가 부른 도구 수 */
  toolCalls: number;
  /** 마지막 도구 호출 */
  lastTool: { name: string; input: Record<string, string> } | null;
  /** 마지막으로 한 말(한 줄) */
  lastText: string | null;
  updatedAt: number;
  /** 최근 활동 로그(도구·말, 오래된 것부터, 최대 SUBAGENT_LOG_MAX). 카드를 펼치면 보인다. */
  log: string[];
  /** 마지막 활동의 출처(codex = companion 이 띄운 Codex). */
  via?: "codex";
}

export const SUBAGENT_LOG_MAX = 12;

/** 하위 에이전트 활동 한 줄 요약(로그용). */
export function subagentLogLine(e: { tool?: string; input?: Record<string, string>; text?: string; via?: "codex" }): string {
  const src = e.via === "codex" ? "Codex · " : "";
  if (e.tool) {
    const v = e.input ? Object.values(e.input).find((x) => typeof x === "string" && x.trim()) ?? "" : "";
    return `${src}${e.tool}${v ? " " + v.split("\n")[0].slice(0, 120) : ""}`;
  }
  return `${src}${(e.text ?? "").slice(0, 160)}`;
}

export interface TurnBlock {
  kind: "turn";
  id: string;
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
  errorText?: string;
  errorMsg?: Msg;
  forkPoint?: ForkPoint;
}

/** 압축 경계. 여기 위쪽 대화는 요약으로 대체됐다는 표시. */
export interface CompactedBlock {
  kind: "compacted";
  id: string;
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
}

export interface ErrorBlock {
  kind: "error";
  id: string;
  message: string;
  msg?: Msg;
}

export interface NoticeBlock {
  kind: "notice";
  id: string;
  message: string;
  msg?: Msg;
  level: "notice" | "suggestion" | "warning";
}

export interface ReviewBlock {
  kind: "review";
  id: string; // === reviewTabId
  reviewer: Provider;
  status: "requested" | "done" | "failed";
  text: string;
  scope?: string;
  scopeMsg?: Msg;
  textMsg?: Msg;
  ts: number;
}

export interface VerifyBlock {
  kind: "verify";
  id: string; // === runId
  status: "running" | "passed" | "failed" | "aborted";
  cwd: string;
  head: { sha: string; branch: string | null; dirty: boolean } | null;
  commands: VerifyCommandResult[];
  ts: number;
  /** 끝난 시각(running 이면 없음). */
  endedAt?: number;
}

export interface FanoutBlock {
  kind: "fanout";
  id: string; // === fanoutId
  status: "running" | "done" | "cleaned";
  prompt: string;
  policy: PermissionPolicy;
  variants: FanoutVariant[];
  adoptedTabId?: string;
  ts: number;
}

export interface OrchestrationBlock {
  kind: "orchestration";
  id: string; // === runId
  revision: number;
  objective: string;
  status: "active" | "closed";
  coordinator: "user" | "tab";
  tasks: OrchestrationEvent["tasks"];
  gates: number;
  questions: number;
  escalations: number;
  notes: number;
  ts: number;
}

export type Block = UserBlock | TextBlock | ToolBlock | TurnBlock | CompactedBlock | ErrorBlock | NoticeBlock | ReviewBlock | VerifyBlock | FanoutBlock | OrchestrationBlock;

export interface SessionTotals {
  usage: TokenUsage;
  costUsd: number;
  turns: number;
}

export interface SessionState {
  status: SessionStatus;
  sessionId: string | null;
  provider: Provider | null;
  model: string | null;
  cwd: string | null;
  blocks: Block[];
  /** 지금 승인 창에 띄울 요청. 여럿이 겹치면 먼저 온 것부터 하나씩 보여 준다. */
  pendingPermission: PermissionRequestEvent | null;
  /**
   * 아직 답을 못 받은 요청들(온 순서). 병렬 도구는 승인 요청도 한꺼번에 오는데, 하나만 들고 있으면
   * 나머지는 답이 와도 짚을 데가 없어 카드가 "권한 대기" 로 굳고 승인 창도 사라진다.
   */
  permissionWaits: PermissionRequestEvent[];
  totals: SessionTotals;
  /** 마지막 턴 결과 — 컨텍스트 사용량 표시용. */
  lastTurn: TurnResultEvent | null;
  /**
   * 지금 턴에서 흘러온 생각(reasoning) 텍스트의 꼬리. "생각 중" 표시에만 쓴다.
   * 도구가 시작돼도 지우지 않는다 — Codex 는 요약을 그 단계의 생각이 끝난 직후(도구 호출 직전)에 보내므로, 지우면 한순간만 보인다.
   * 대신 stale 로 표시해 두고 다음 생각 조각이 오면 이어 붙이지 않고 교체한다. 답(텍스트)이 시작되거나 턴이 끝나면 비운다.
   */
  reasoning: string;
  reasoningStale: boolean;
  /** 리듀서가 처리한 이벤트 수. 재생 검증/디버깅용. */
  eventCount: number;
}

export function initialSessionState(): SessionState {
  return {
    status: "idle",
    sessionId: null,
    provider: null,
    model: null,
    cwd: null,
    blocks: [],
    pendingPermission: null,
    permissionWaits: [],
    totals: { usage: ZERO_USAGE, costUsd: 0, turns: 0 },
    lastTurn: null,
    reasoning: "",
    reasoningStale: false,
    eventCount: 0,
  };
}

/** 생각 텍스트는 꼬리만 든다 — 화면엔 마지막 몇 줄만 보이고, 긴 생각을 통째로 들고 있을 이유가 없다. */
const REASONING_TAIL = 2000;
function appendReasoning(cur: string, piece: string): string {
  const next = cur + piece;
  return next.length > REASONING_TAIL ? next.slice(next.length - REASONING_TAIL) : next;
}

function finalizeStreaming(blocks: Block[]): Block[] {
  if (!blocks.some((b) => b.kind === "text" && b.streaming)) return blocks;
  return blocks.map((b) => (b.kind === "text" && b.streaming ? { ...b, streaming: false } : b));
}

/**
 * 턴이 끝났는데 결과가 안 온 도구는 끝을 못 본 것이다. 그대로 두면 카드가 "실행 중" 으로 남아
 * 경과 시간만 올라간다 — 중단했는데도 계속 도는 것처럼 보인다(실제로 그렇게 보였다).
 *
 * 결과를 지어내지 않는다. isError 로 적어 두고 무슨 일이 있었는지만 남긴다.
 * 입력을 만들던 중(partial)에 끝난 도구는 실행되지 않았다 — partial 은 그대로 둬서 덜 만든 명령·경로로
 * "터미널에서 실행"·파일 열기가 붙지 않게 한다.
 */
function finalizeRunningTools(blocks: Block[], note: keyof typeof ko.session.msg.tool): Block[] {
  if (!blocks.some((b) => b.kind === "tool" && !b.result)) return blocks;
  return blocks.map((b) => {
    if (b.kind !== "tool" || b.result) return b;
    const key = b.partial ? "partialInput" : note;
    // output 은 원본(한국어) 문장 — 인계·내보내기처럼 번역 없이 읽는 곳이 쓴다
    return { ...b, result: { output: ko.session.msg.tool[key], outputMsg: { key: `session.msg.tool.${key}` }, isError: true } };
  });
}

function upsert<T extends Block>(
  blocks: Block[],
  id: string,
  kind: T["kind"],
  update: (existing: T | null) => T,
): Block[] {
  const idx = blocks.findIndex((b) => b.id === id && b.kind === kind);
  if (idx === -1) return [...blocks, update(null)];
  const next = blocks.slice();
  next[idx] = update(blocks[idx] as T);
  return next;
}

export function reduceSession(state: SessionState, event: ChatEvent): SessionState {
  const next = apply(state, event);
  return next === state ? state : { ...next, eventCount: state.eventCount + 1 };
}

function apply(state: SessionState, event: ChatEvent): SessionState {
  switch (event.type) {
    case "thinking_delta":
      return { ...state, reasoning: state.reasoningStale ? event.text : appendReasoning(state.reasoning, event.text), reasoningStale: false };

    case "user_message":
      return {
        ...state,
        reasoning: "",
        reasoningStale: false,
        blocks: [
          ...finalizeStreaming(state.blocks),
          { kind: "user", id: event.id, text: event.text, images: event.images, ts: event.ts },
        ],
      };

    case "status": {
      const blocks = event.status === "running" ? state.blocks : finalizeStreaming(state.blocks);
      // 승인 하나가 풀릴 때마다 어댑터가 running 을 내보낸다. 그때 창을 지우면 아직 답을 기다리는
      // 다른 요청이 물어볼 자리를 잃는다 — 남은 것이 있으면 그대로 둔다.
      const pendingPermission =
        event.status === "waiting_permission" || state.permissionWaits.length > 0 ? state.pendingPermission : null;
      return { ...state, status: event.status, blocks, pendingPermission, reasoning: event.status === "running" ? state.reasoning : "", reasoningStale: event.status === "running" ? state.reasoningStale : false };
    }

    case "session": {
      // provider 가 바뀌면 이전 provider 의 모델명은 무효.
      const providerChanged = !!event.provider && event.provider !== state.provider;
      return {
        ...state,
        sessionId: event.sessionId,
        provider: event.provider ?? state.provider,
        model: event.model ?? (providerChanged ? null : state.model),
        cwd: event.cwd ?? state.cwd,
      };
    }

    case "text_delta":
      return {
        ...state,
        reasoning: "",
        reasoningStale: false,
        blocks: upsert<TextBlock>(state.blocks, event.blockId, "text", (b) =>
          b
            ? { ...b, text: b.text + event.text, streaming: true }
            : { kind: "text", id: event.blockId, text: event.text, streaming: true },
        ),
      };

    case "assistant_text":
      return {
        ...state,
        reasoning: "",
        reasoningStale: false,
        blocks: upsert<TextBlock>(state.blocks, event.blockId, "text", () => ({
          kind: "text",
          id: event.blockId,
          text: event.text,
          streaming: false,
        })),
      };

    case "tool_use":
      return {
        ...state,
        reasoningStale: true,
        // 도구가 시작됐다 = 앞 텍스트 블록은 끝났다(커서 막대가 남지 않게)
        blocks: upsert<ToolBlock>(finalizeStreaming(state.blocks), event.toolUseId, "tool", (b) => ({
          kind: "tool",
          id: event.toolUseId,
          ts: b?.ts ?? event.ts,
          name: event.name,
          input: event.input,
          partial: event.partial ?? false,
          result: b?.result,
          permission: b?.permission,
          subagent: b?.subagent,
        })),
      };

    case "subagent_activity": {
      // 상위 툴 호출 id 로 찾고, 없으면(중첩 에이전트 등) 진행 중인 Skill·Agent 카드에 붙인다
      const isAgentTool = (b: Block): b is ToolBlock => b.kind === "tool" && !b.result && ["Skill", "Agent", "Task"].includes(b.name);
      let idx = state.blocks.findIndex((b) => b.kind === "tool" && b.id === event.parentToolUseId);
      if (idx === -1) for (let i = state.blocks.length - 1; i >= 0; i--) if (isAgentTool(state.blocks[i])) { idx = i; break; }
      if (idx === -1) return state;
      const cur = state.blocks[idx] as ToolBlock;
      const prev: SubagentProgress = cur.subagent ?? { toolCalls: 0, lastTool: null, lastText: null, updatedAt: 0, log: [] };
      const log = [...(prev.log ?? []), subagentLogLine(event)].slice(-SUBAGENT_LOG_MAX);
      const via = event.via ?? (event.tool || event.text ? undefined : prev.via);
      const subagent: SubagentProgress = event.tool
        ? { ...prev, toolCalls: prev.toolCalls + 1, lastTool: { name: event.tool, input: event.input ?? {} }, updatedAt: event.ts, log, via }
        : { ...prev, lastText: event.text ?? prev.lastText, updatedAt: event.ts, log, via };
      const blocks = state.blocks.slice();
      blocks[idx] = { ...cur, subagent };
      return { ...state, blocks };
    }

    case "tool_result":
      return {
        ...state,
        blocks: upsert<ToolBlock>(state.blocks, event.toolUseId, "tool", (b) => ({
          kind: "tool",
          id: event.toolUseId,
          ts: b?.ts ?? event.ts,
          name: b?.name ?? "(unknown)",
          input: b?.input ?? {},
          partial: false,
          permission: b?.permission,
          subagent: b?.subagent,
          result: { output: event.output, isError: event.isError, ...(event.outputMsg ? { outputMsg: event.outputMsg } : {}) },
        })),
      };

    case "permission_request":
      return {
        ...state,
        status: "waiting_permission",
        pendingPermission: state.pendingPermission ?? event,
        permissionWaits: [...state.permissionWaits, event],
        blocks: upsert<ToolBlock>(state.blocks, event.toolUseId, "tool", (b) => ({
          kind: "tool",
          id: event.toolUseId,
          ts: b?.ts ?? event.ts,
          name: b?.name ?? event.tool,
          input: b?.input ?? event.input,
          partial: false,
          result: b?.result,
          permission: "pending",
        })),
      };

    case "permission_resolved": {
      // 답은 그 요청의 것만 짚는다. 예전에는 "마지막으로 온 요청" 을 기준으로 삼아, 병렬 요청에서는
      // 엉뚱한 카드가 지워지고 나머지는 결과가 와도 "권한 대기" 로 굳었다(카드는 결과보다 권한을 먼저 본다).
      const done = state.permissionWaits.find((w) => w.requestId === event.requestId) ?? null;
      const waits = state.permissionWaits.filter((w) => w.requestId !== event.requestId);
      const blocks = done
        ? state.blocks.map((b) =>
            b.kind === "tool" && b.id === done.toolUseId && b.permission === "pending"
              ? { ...b, permission: event.behavior === "allow" ? "allowed" : "denied" }
              : b,
          )
        : state.blocks;
      const wasShown = state.pendingPermission?.requestId === event.requestId;
      return {
        ...state,
        blocks: blocks as Block[],
        permissionWaits: waits,
        // 창에 띄워 두던 것이 풀렸으면 다음 차례를 올린다.
        pendingPermission: wasShown ? (waits[0] ?? null) : state.pendingPermission,
        status:
          waits.length > 0
            ? state.status
            : wasShown && state.status === "waiting_permission"
              ? "running"
              : state.status,
      };
    }

    case "turn_result": {
      // /mcp 같은 로컬 커맨드 턴은 모델을 거치지 않아 사용량이 0 이다. 컨텍스트 패널의 "마지막 턴" 은
      // 모델이 실제로 돈 마지막 턴을 가리키게 유지한다.
      const u = event.usage;
      const hasUsage = u.input + u.output + u.cacheRead + u.cacheWrite > 0;
      return {
        ...state,
        lastTurn: hasUsage || !state.lastTurn ? event : state.lastTurn,
        sessionId: event.sessionId ?? state.sessionId,
        blocks: [
          ...finalizeRunningTools(finalizeStreaming(state.blocks), "turnEnded"),
          {
            kind: "turn",
            id: `turn-${event.ts}-${state.totals.turns + 1}`,
            usage: event.usage,
            costUsd: event.costUsd,
            durationMs: event.durationMs,
            numTurns: event.numTurns,
            isError: event.isError,
            errorText: event.errorText,
            errorMsg: event.errorMsg,
            forkPoint: event.forkPoint,
          },
        ],
        totals: {
          usage: addUsage(state.totals.usage, event.usage),
          costUsd: state.totals.costUsd + event.costUsd,
          turns: state.totals.turns + 1,
        },
      };
    }

    case "review":
      return {
        ...state,
        blocks: upsert<ReviewBlock>(finalizeStreaming(state.blocks), event.reviewTabId, "review", (b) => ({
          kind: "review",
          id: event.reviewTabId,
          reviewer: event.reviewer,
          status: event.status,
          text: event.text,
          textMsg: event.textMsg,
          scope: event.scope ?? b?.scope,
          scopeMsg: event.scopeMsg ?? b?.scopeMsg,
          ts: b?.ts ?? event.ts,
        })),
      };

    case "verify":
      return {
        ...state,
        blocks: upsert<VerifyBlock>(finalizeStreaming(state.blocks), event.runId, "verify", (b) => ({
          kind: "verify",
          id: event.runId,
          status: event.status,
          cwd: event.cwd,
          head: event.head ?? b?.head ?? null,
          commands: event.commands,
          ts: b?.ts ?? event.ts,
          ...(event.status !== "running" ? { endedAt: event.ts } : b?.endedAt ? { endedAt: b.endedAt } : {}),
        })),
      };

    case "fanout":
      return {
        ...state,
        blocks: upsert<FanoutBlock>(finalizeStreaming(state.blocks), event.fanoutId, "fanout", (b) => ({
          kind: "fanout",
          id: event.fanoutId,
          status: event.status,
          prompt: event.prompt,
          policy: event.policy,
          variants: event.variants,
          ...(event.adoptedTabId ?? b?.adoptedTabId ? { adoptedTabId: event.adoptedTabId ?? b?.adoptedTabId } : {}),
          ts: b?.ts ?? event.ts,
        })),
      };

    case "orchestration":
      // 코디네이터가 말하는 중에도 카드가 갱신된다 — 스트리밍을 끊지 않는다(finalizeStreaming 호출 안 함)
      return {
        ...state,
        blocks: upsert<OrchestrationBlock>(state.blocks, event.runId, "orchestration", (b) => ({
          kind: "orchestration",
          id: event.runId,
          revision: event.revision,
          objective: event.objective,
          status: event.status,
          coordinator: event.coordinator,
          tasks: event.tasks,
          gates: event.gates ?? 0,
          questions: event.questions,
          escalations: event.escalations,
          notes: event.notes,
          ts: b?.ts ?? event.ts,
        })),
      };

    case "compacted":
      // 압축은 세션을 끊지 않는다 — 경계만 남기고, 다음 턴이 실제 사용량을 알려줄 때까지 게이지는 비운다.
      return {
        ...state,
        lastTurn: null,
        blocks: [
          ...finalizeStreaming(state.blocks),
          {
            kind: "compacted",
            id: `compact-${event.ts}-${state.eventCount}`,
            trigger: event.trigger,
            preTokens: event.preTokens,
            postTokens: event.postTokens,
          },
        ],
      };

    case "session_reset":
      // 새 provider 세션: 다음 턴이 들고 갈 컨텍스트는 요약 한 덩어리뿐이라 게이지를 비운다.
      return { ...state, lastTurn: null };

    case "notice": {
      const id = event.key ? `notice-${event.key}` : `notice-${event.ts}-${state.eventCount}`;
      return { ...state, blocks: upsert<NoticeBlock>(state.blocks, id, "notice", () => ({ kind: "notice", id, message: event.message, msg: event.msg, level: event.level })) };
    }

    case "error":
      return {
        ...state,
        status: event.fatal === false ? state.status : "error",
        pendingPermission: event.fatal === false ? state.pendingPermission : null,
        permissionWaits: event.fatal === false ? state.permissionWaits : [],
        blocks: [
          ...(event.fatal === false
            ? finalizeStreaming(state.blocks)
            : finalizeRunningTools(finalizeStreaming(state.blocks), "errorEnded")),
          { kind: "error", id: `err-${event.ts}-${state.eventCount}`, message: event.message, msg: event.msg },
        ],
      };

    default:
      return state;
  }
}

/** 이벤트 배열을 처음부터 재생한다 (threads jsonl 복원용). */
export function replaySession(events: ChatEvent[]): SessionState {
  return events.reduce(reduceSession, initialSessionState());
}

export interface ContextUsage {
  /** 마지막 모델 턴이 쓴 입력 토큰(입력 + 캐시 읽기 + 캐시 쓰기) — 곧 다음 턴이 들고 갈 컨텍스트 크기. */
  used: number;
  /** 모델 컨텍스트 창. Claude 결과에만 있어 Codex 는 null. */
  window: number | null;
  /** 0~100. window 를 모르면 null. */
  pct: number | null;
}

/**
 * 컨텍스트 패널의 게이지와 채팅의 경고 배너가 같은 숫자를 쓰도록 한 곳에서 계산한다.
 * used 는 마지막 assistant 메시지의 입력(contextTokens). 없는 옛 기록은 턴 누적치를 요청 수로 나눈 근사치.
 * 창 크기는 세션 모델의 것을 우선하고(서브에이전트가 다른 모델일 수 있다), 없으면 가장 큰 값.
 */
export function contextUsage(state: SessionState): ContextUsage | null {
  const last = state.lastTurn;
  if (!last) return null;
  const sum = last.usage.input + last.usage.cacheRead + last.usage.cacheWrite;
  const used = last.contextTokens ?? Math.round(sum / Math.max(1, last.numTurns));
  const own = state.model ? last.modelUsage[state.model]?.contextWindow : undefined;
  const windows = Object.values(last.modelUsage)
    .map((m) => m.contextWindow ?? 0)
    .filter((w) => w > 0);
  const window = own || (windows.length ? Math.max(...windows) : null);
  const pct = window ? Math.min(100, Math.round((used / window) * 100)) : null;
  return { used, window, pct };
}

/** 경고 단계: 80% 부터 warn, 95% 부터 critical. */
export const CONTEXT_WARN_PCT = 80;
export const CONTEXT_CRITICAL_PCT = 95;

export function contextWarnLevel(pct: number | null): "warn" | "critical" | null {
  if (pct === null) return null;
  if (pct >= CONTEXT_CRITICAL_PCT) return "critical";
  if (pct >= CONTEXT_WARN_PCT) return "warn";
  return null;
}

/** 마지막 사용자 메시지 뒤의 어시스턴트 텍스트를 이어 붙인 것(교차 리뷰 결과·CLI wait 의 reply). */
export function lastReplyText(events: ChatEvent[]): string {
  const blocks = replaySession(events).blocks;
  let i = blocks.length - 1;
  while (i >= 0 && blocks[i].kind !== "user") i--;
  return blocks
    .slice(i + 1)
    .filter((b): b is TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
