// provider(claude/codex) 를 정규화한 공통 이벤트 스키마. renderer 는 provider 를 모른다.
// main 의 adapter 가 SDK 메시지를 이 이벤트로 바꾸고, renderer/persistence 는 이 이벤트만 다룬다.
// 모든 이벤트에 ts(ms) 를 찍어 threads/*.jsonl 에 그대로 append 할 수 있게 한다.

import type { Msg } from "./i18n/msg";
import type { Provider } from "./ipc";

export type SessionStatus = "idle" | "queued" | "running" | "waiting_permission" | "error";

/**
 * Claude permissionMode / Codex sandbox·승인 정책을 한 줄로 통일. 느슨해지는 순서다.
 * auto_review 는 사람 대신 AI 가 승인 요청을 판단한다(Claude auto 모드 · Codex approvalsReviewer auto_review).
 */
export type PermissionPolicy = "ask" | "auto_edit" | "auto_review" | "full";
export const PERMISSION_POLICIES: readonly PermissionPolicy[] = ["ask", "auto_edit", "auto_review", "full"];
export function isPermissionPolicy(v: unknown): v is PermissionPolicy {
  return PERMISSION_POLICIES.includes(v as PermissionPolicy);
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export interface ModelUsageEntry extends TokenUsage {
  costUsd: number;
  /** 모델 컨텍스트 창 크기(토큰). Claude 결과에만 있다. */
  contextWindow?: number;
}

interface Base {
  ts: number;
}

export interface UserMessageEvent extends Base {
  type: "user_message";
  id: string;
  text: string;
  images?: { dataUrl: string }[];
}

export interface StatusEvent extends Base {
  type: "status";
  status: SessionStatus;
}

/** provider 세션이 열렸을 때 (Claude: system/init, Codex: thread.started). */
export interface SessionEvent extends Base {
  type: "session";
  sessionId: string;
  provider?: Provider;
  model?: string;
  cwd?: string;
}

/** 스트리밍 텍스트 조각. blockId 로 같은 블록에 이어 붙인다. */
export interface TextDeltaEvent extends Base {
  type: "text_delta";
  blockId: string;
  text: string;
}

/**
 * 모델의 생각(reasoning) 조각. 화면의 "생각 중" 에 흘려 보여 주기만 하고 기록 파일엔 남기지 않는다(ephemeral).
 * Claude 는 thinking_delta, Codex 는 item/reasoning/summaryTextDelta 에서 온다.
 */
export interface ThinkingDeltaEvent extends Base {
  type: "thinking_delta";
  text: string;
}

/** 완성된 텍스트 블록. 같은 blockId 가 있으면 통째로 교체(dedupe). */
export interface AssistantTextEvent extends Base {
  type: "assistant_text";
  blockId: string;
  text: string;
}

/** 툴 호출. 같은 toolUseId 가 다시 오면 input 을 갱신한다(스트리밍 중 partial → 완성). */
export interface ToolUseEvent extends Base {
  type: "tool_use";
  toolUseId: string;
  name: string;
  input: unknown;
  /** input 이 아직 스트리밍 중이면 true. */
  partial?: boolean;
  /**
   * 스트리밍 중인 JSON 에서 뽑은 미리보기(명령·경로가 타이핑되듯 보이게). 화면에만 흘리고 기록엔 남기지 않는다 —
   * 완성된 tool_use 가 곧 따라오므로 재생에 필요 없다.
   */
  preview?: boolean;
}

/**
 * Skill·Agent 가 띄운 하위 에이전트의 활동(도구 호출·말). 그 툴카드 아래에 "하위 에이전트 · Bash …" 로 보여 주기만 하고
 * 기록엔 남기지 않는다(ephemeral). parentToolUseId = 하위 에이전트를 띄운 상위 툴 호출 id.
 */
export interface SubagentActivityEvent extends Base {
  type: "subagent_activity";
  parentToolUseId: string;
  /** 도구 호출이면 이름과 잘라 낸 입력(문자열 필드만, 200자) */
  tool?: string;
  input?: Record<string, string>;
  /** 말이면 마지막 줄(160자) */
  text?: string;
  /** 출처. codex = Skill 이 codex-companion 으로 띄운 Codex 의 rollout 미러(하위 에이전트의 하위). */
  via?: "codex";
}

export interface ToolResultEvent extends Base {
  type: "tool_result";
  toolUseId: string;
  output: string;
  /** 앱이 대신 채운 결과 문구의 사전 키. 보일 때 지금 언어로 번역한다. */
  outputMsg?: Msg;
  isError: boolean;
}

export interface PermissionRequestEvent extends Base {
  type: "permission_request";
  requestId: string;
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  title?: string;
  /** title 이 앱이 만든 문구면 그 키(그릴 때 번역한다). */
  titleMsg?: Msg;
  description?: string;
  /** "이 세션에서 항상 허용" 을 제안할 수 있는지 (SDK suggestions 유무). */
  canAlwaysAllow: boolean;
}

export interface PermissionResolvedEvent extends Base {
  type: "permission_resolved";
  requestId: string;
  behavior: "allow" | "deny";
}

export interface TurnResultEvent extends Base {
  type: "turn_result";
  /** 턴 안의 모든 API 요청 누적치 (툴콜마다 대화를 다시 보내므로 컨텍스트 크기가 아니다). */
  usage: TokenUsage;
  /** 마지막 assistant 메시지 하나가 든 입력 컨텍스트(input + cache read + cache write). 다음 턴이 들고 갈 크기. */
  contextTokens?: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  sessionId?: string;
  modelUsage: Record<string, ModelUsageEntry>;
  isError: boolean;
  errorText?: string;
  /** 앱이 만든 errorText 의 사전 키. provider 가 준 원문에는 없다. */
  errorMsg?: Msg;
  /**
   * 이 턴 끝에서 대화를 갈라 새 탭으로 이어 갈 수 있는 지점. 정상으로 끝난 일반 턴에만 붙는다.
   * sessionId 는 그 지점이 속한 provider 세션 — 탭의 지금 세션과 다르면(provider 전환 전, 분기로 복사된 턴) 쓸 수 없다.
   * pointId: Claude 는 그 턴 마지막 최상위 체인 항목의 uuid(forkSession upToMessageId), Codex 는 turn id(thread/fork lastTurnId).
   */
  forkPoint?: ForkPoint;
}

export interface ForkPoint {
  provider: Provider;
  sessionId: string;
  pointId: string;
}

/** provider 세션을 새로 시작했다(요약 후 새 세션 등). 컨텍스트 사용량 표시를 초기화한다. */
export interface SessionResetEvent extends Base {
  type: "session_reset";
}

/**
 * provider 가 대화를 압축했다(세션은 그대로 이어진다 — session_reset 과 다르다).
 * SDK 의 compact_boundary 를 그대로 옮긴 것이라 압축 전후 토큰 수를 알 수 있다.
 */
export interface CompactedEvent extends Base {
  type: "compacted";
  /** 사용자가 시킨 압축인지(manual), 한도가 차서 자동으로 일어난 것인지(auto). */
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
}

/**
 * 교차 리뷰: 다른 provider 탭에 diff 를 보내 받은 결과. reviewTabId 로 같은 카드를 갱신한다(requested → done|failed).
 * 원래 탭의 기록에 남으므로 재시작 뒤에도 카드가 보인다.
 */
export interface ReviewEvent extends Base {
  type: "review";
  reviewer: Provider;
  reviewTabId: string;
  status: "requested" | "done" | "failed";
  /** done 이면 리뷰 본문(마크다운), failed 면 이유. */
  text: string;
  /** 리뷰 대상 요약(파일 수·줄 수). */
  scope?: string;
  /** 앱이 만든 문구(scope·실패 text)의 사전 키 — 보일 때 지금 언어로 번역한다. 모델이 쓴 리뷰 본문에는 없다. */
  scopeMsg?: Msg;
  textMsg?: Msg;
}

/**
 * 검증 실행의 명령 하나. output 은 꼬리(마지막 몇 KB)만 든 명령의 출력 원문이다.
 * 앱이 덧붙이는 안내(앞부분 생략·시간 초과 등)는 output 에 섞지 않고 truncated / note / noteMsg 로 따로 남긴다
 * (예전 기록에는 안내 문장이 output 에 섞여 있다).
 */
export interface VerifyCommandResult {
  cmd: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "aborted";
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  /** output 의 앞부분을 잘랐다. */
  truncated?: true;
  /** 출력 뒤에 붙는 앱 안내(만든 시점의 문장)와 그 사전 키. 화면은 noteMsg 를 지금 언어로 그린다. */
  note?: string;
  noteMsg?: Msg;
}

/**
 * 검증 실행(저장해 둔 명령들을 순서대로 돌린 결과). runId 로 같은 카드를 갱신한다(running → passed|failed|aborted).
 * 명령 경계마다 기록에 남고(재시작 뒤에도 카드가 보인다), 출력이 흐르는 중간 상태는 partial 로 화면에만 흘린다.
 */
export interface VerifyEvent extends Base {
  type: "verify";
  runId: string;
  status: "running" | "passed" | "failed" | "aborted";
  cwd: string;
  /** 실행 시점의 HEAD. 레포가 아니면 null. dirty = 커밋 안 된 변경이 있었다. */
  head: { sha: string; branch: string | null; dirty: boolean } | null;
  commands: VerifyCommandResult[];
  /** 출력 스트리밍 등 중간 상태 — 기록하지 않는다. */
  partial?: boolean;
}

/** 팬아웃의 변형 하나 = 격리 세션(worktree) 탭. */
export interface FanoutVariant {
  tabId: string;
  /** A·B·C… */
  label: string;
  provider: Provider;
  model?: string;
  /** waiting = 권한 응답 대기(사람이 봐야 함). cleaned = worktree 정리됨. */
  status: "running" | "waiting" | "done" | "failed" | "cleaned";
  /** 끝난 뒤 worktree 의 변경 요약. */
  files?: number;
  added?: number;
  deleted?: number;
  /** 답변 앞부분(400자). */
  summary?: string;
  durationMs?: number;
  error?: string;
  /** 앱이 만든 error 문구의 사전 키. */
  errorMsg?: Msg;
}

/**
 * 팬아웃: 지시 하나를 격리 세션 여러 개에 동시에 보낸 결과. fanoutId 로 같은 카드를 갱신한다.
 * 원래 탭의 기록에 남는다(변형 탭의 대화는 각 탭에).
 */
export interface FanoutEvent extends Base {
  type: "fanout";
  fanoutId: string;
  status: "running" | "done" | "cleaned";
  /** 보낸 지시(앞 300자). */
  prompt: string;
  policy: PermissionPolicy;
  variants: FanoutVariant[];
  /** 채택한 변형(패치를 원본에 적용함). */
  adoptedTabId?: string;
}

/** 오케스트레이션 카드(코디네이터 탭에). runId 로 같은 카드를 갱신한다. 내용은 Run 상태의 요약(projection). */
export interface OrchestrationEvent extends Base {
  type: "orchestration";
  runId: string;
  revision: number;
  objective: string;
  status: "active" | "closed";
  coordinator: "user" | "tab";
  tasks: { id: string; seq: number; spec: string; status: string; tabId: string | null; provider: Provider | null; execution: string | null; summary: string | null; blocked?: string | null; /** 대기 사유의 코드 값. 그릴 때 지금 언어로 번역하고, 없으면(예전 기록) blocked 문장을 쓴다. */ blockedBy?: { kind: "deps"; seqs: (number | "?")[] } | { kind: "gates" } | null }[];
  gates?: number;
  questions: number;
  escalations: number;
  notes: number;
  openDispatches?: number;
}

export interface ErrorEvent extends Base {
  type: "error";
  message: string;
  /** 앱이 만든 문구면 사전 키와 값. 그릴 때 지금 언어로 번역하고, 없으면(외부 오류·예전 기록) message 를 쓴다. */
  msg?: Msg;
  /** false 면 턴은 계속된다 (Codex 의 non-fatal error item 등). 기본 true. */
  fatal?: boolean;
  /** provider 가 스스로 다시 시도한다. 이 오류로 턴이 끝난 것이 아니다. */
  willRetry?: boolean;
}

/**
 * 턴 도중 CLI 가 띄우는 안내·경고(Claude 의 system/informational). 턴은 계속된다.
 * key 가 같으면 한 줄로 갱신한다(같은 도구의 진행 안내).
 */
export interface NoticeEvent extends Base {
  type: "notice";
  message: string;
  msg?: Msg;
  level: "notice" | "suggestion" | "warning";
  key?: string;
}

/** 승인 요청을 AI 가 검토하는 중이거나 허용했다(권한 auto_review). 해당 도구 카드에 표시만 붙인다. 거절은 notice 로 온다. */
export interface ToolReviewEvent extends Base {
  type: "tool_review";
  toolUseId: string;
  status: "in_progress" | "approved";
}

export type ChatEvent =
  | UserMessageEvent
  | StatusEvent
  | SessionEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | SubagentActivityEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | TurnResultEvent
  | SessionResetEvent
  | CompactedEvent
  | ReviewEvent
  | VerifyEvent
  | FanoutEvent
  | OrchestrationEvent
  | NoticeEvent
  | ToolReviewEvent
  | ErrorEvent;

/** renderer → main 권한 응답. */
export interface PermissionAnswer {
  behavior: "allow" | "deny";
  /** allow 일 때, 이 세션에서 같은 툴을 다시 묻지 않도록 SDK 제안 규칙을 적용. */
  always?: boolean;
  /**
   * AskUserQuestion 의 답 (질문 문장 → 고른 라벨, 다중 선택은 쉼표로 이음, 직접 입력은 그 문장).
   * 이 도구는 bypassPermissions 에서도 canUseTool 로 오므로 승인이 아니라 답을 돌려줘야 한다.
   */
  answers?: Record<string, string>;
}
