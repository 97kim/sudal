// 탭(=세션) 관리. Map<tabId, Session>. 탭마다 AbortController, 이벤트 로그, 대기 중인 권한 요청을 든다.
// provider 어댑터는 이벤트만 흘리고, 이 매니저가 renderer 로 보내는 emit 을 소유한다.
// 동시 실행 상한(기본 4)을 넘으면 큐에 넣고 status=queued 로 알린다.

import type {
  ChatEvent,
  PermissionAnswer,
  PermissionPolicy,
  PermissionRequestEvent,
  SessionStatus,
  ForkPoint,
  TurnResultEvent,
} from "@shared/chat-events";
import { buildDedupeIndex, dropReplayedPrefix, indexEvent, type DedupeIndex, type ReplayCutStats } from "@shared/event-dedupe";
import { buildHandoff, estimateTokens, type Handoff } from "@shared/handoff";
import type { Provider, ProviderRateLimitDto } from "@shared/ipc";
import type { SlashCommandDto } from "@shared/slash-commands";
import type { LiveBackgroundTask, TaskFinishedNote } from "@shared/bg-tasks";
import type { StoredChatImage } from "./chat-attachments";
import type { BackgroundTasksSource } from "./claude-adapter";
import { applyClaudePolicy, closeAllClaudeSessions, closeClaudeSession, interruptClaudeSession, runClaudeTurn, warmClaudeSession, type ClaudeRuntime } from "./claude-adapter";
import { applyCodexPolicy, closeAllCodexSessions, closeCodexSession, runCodexTurn, steerCodexTurn, warmCodexSession, type CodexRuntime } from "./codex-adapter";
import { randomUUID } from "node:crypto";
import {
  isUsageLimitText,
  USAGE_LIMIT_MAX_RETRIES,
  usageLimitRetryAt,
} from "@shared/usage-limit";
import type { LimitWaitDto, QueueInfoDto } from "@shared/ipc";
import fs from "node:fs";
import path from "node:path";
import { CompanionMirror } from "./companion-mirror";
import { appMsg, MsgError, mt } from "./i18n";
import { staleRunEvents } from "@shared/stale-runs";
import {
  TranscriptWatcher,
  findClaudeTranscript,
  findCodexRollout,
  mapClaudeHookLine,
  mapClaudeTranscriptLine,
  mapCodexRolloutLine,
  newMirrorState,
  readCodexRolloutMeta,
  type HookEvent,
} from "./transcript-mirror";
import { CodexApprovalDetector } from "./codex-approval";
import type { PersistedPrompt } from "./persistence";

/** 세션을 누가 제어하는가. "terminal" 이면 CLI(TUI)가 pty 에서 돌고 앱은 기록 파일을 미러만 한다. */
export type SessionController = "app" | "terminal";

/** 터미널 모드에서 CLI 가 사용자 입력을 기다리는 상황. 지금은 권한 다이얼로그만 (Claude 훅으로 감지). */
export interface TerminalAttention {
  kind: "permission";
  tool: string;
  /** 사람이 읽을 한 줄 요약 (Bash 는 명령, 파일 툴은 경로). */
  summary: string;
  since: number;
}

export interface SessionConfig {
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
  sessionId?: string | null;
}

export interface SessionSnapshot {
  tabId: string;
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
  status: SessionStatus;
  sessionId: string | null;
  /** provider 전환 후 아직 첫 메시지를 보내지 않아 요약이 대기 중이면 true. */
  handoffPending: boolean;
  startedAt: number | null;
  /** 지금 도는 턴이 실제로 시작된 시각(큐 대기 제외). 턴이 끝나면 null. */
  turnStartedAt: number | null;
  controller: SessionController;
  terminalAttention: TerminalAttention | null;
  /** controller=terminal 인데 앱이 띄운 CLI 가 아니라 통합 터미널에서 사용자가 직접 띄운 것이면 true(끊기 버튼 없음). */
  terminalExternal: boolean;
  pendingPrompts: PendingPromptSummary[];
  limitWait: LimitWaitDto | null;
  /** status=queued 일 때 왜 기다리는지: 대기 순번, 진행 중 턴 수(승인 대기 포함)와 상한. */
  queueInfo: QueueInfoDto | null;
  /** 지금 도는 턴이 백그라운드 작업이 끝나 CLI 가 스스로 이어간 것이면 true. */
  ambientFromBg: boolean;
}

interface QueuedTurn {
  text: string;
  prompt: string;
  images: StoredChatImage[];
}

/** 사용자가 턴 진행 중에 써 둔 다음 지시. 턴이 정상 종료되면 순서대로 자동 전송된다. */
/** 큐에 쌓인 프롬프트. 저장하는 모양과 같다. */
export type PendingPrompt = PersistedPrompt;

export interface PendingPromptSummary {
  id: string;
  text: string;
  hasImages: boolean;
}

interface Session {
  tabId: string;
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
  status: SessionStatus;
  sessionId: string | null;
  abort: AbortController | null;
  /** 우리가 시작하지 않은 턴을 사용자가 끊었다. 뒤늦게 오는 이벤트가 상태를 다시 "도는 중" 으로 올리지 않게 한다. */
  ambientStopped: boolean;
  /** 백그라운드 작업이 끝났다는 알림을 받았다. 곧 CLI 가 그 결과를 들고 스스로 턴을 이어간다. */
  bgTaskFinished: boolean;
  /** 지금 도는 이어받은 턴이 그 백그라운드 결과 때문인가. 확실할 때만 true. */
  ambientFromBg: boolean;
  pending: Map<string, (answer: PermissionAnswer) => void>;
  /** 대기 중인 권한 요청 본문(requestId → 이벤트). 교차 리뷰처럼 사람이 안 보는 탭을 main 이 대신 판정할 때 본다. */
  pendingReqs: Map<string, PermissionRequestEvent>;
  /** null 이면 아직 디스크에서 읽지 않았다 (lazy). */
  events: ChatEvent[] | null;
  /** 이미 기록한 이벤트의 색인. events 를 읽을 때 같이 만든다. */
  dedupe: DedupeIndex | null;
  /** provider 전환 시 다음 프롬프트 앞에 붙일 요약. 한 번 쓰고 비운다. */
  handoffPrefix: string | null;
  startedAt: number | null;
  /** 지금 도는 턴이 실제로 시작된 시각(큐 대기 제외). 턴이 끝나면 null. */
  turnStartedAt: number | null;
  queued: QueuedTurn | null;
  /** 프롬프트 큐 (턴 진행 중 써 둔 다음 지시들). */
  promptQueue: PendingPrompt[];
  /** "지금 반영" 으로 보내는 중인 대기 항목 id. 응답이 올 때까지 그 항목은 고치거나 지울 수 없다(보낸 것과 기록이 어긋나지 않게). */
  steeringId?: string | null;
  /** 한도 도달로 실패한 턴의 재시도 예약. */
  limitWait: (LimitWaitDto & { turn: QueuedTurn; timer: ReturnType<typeof setTimeout> | null }) | null;
  /** 재시도 중인 턴의 누적 시도 횟수(재시도 시작 시 limitWait 에서 옮겨 둔다). */
  limitAttempts: number;
  controller: SessionController;
  /** 터미널 모드 동안 기록 파일을 tail 하는 워처. */
  mirror: TranscriptWatcher | null;
  /** 터미널 모드(Claude) 동안 훅 로그를 tail 하는 워처와 그 파일. */
  hookWatcher: TranscriptWatcher<HookEvent> | null;
  hookLog: string | null;
  attention: TerminalAttention | null;
  /** 터미널 모드(Codex) 동안 pty 출력에서 승인 프롬프트를 찾는 감지기. */
  codexApproval: CodexApprovalDetector | null;
  /** 통합 터미널(사용자 셸)에서 직접 띄운 CLI 가 세션을 잡고 있다: 앱이 띄운 게 아니라 끊을 수도, 훅을 걸 수도 없다. 기록 파일 미러만. */
  external: { pid: number; cwd: string; watch: ReturnType<typeof setInterval> | null; since: number } | null;
  /** Skill·Agent 카드가 열려 있는 동안 codex-companion 이 띄운 Codex 의 rollout 을 tail 해 카드에 흘린다(화면 전용). */
  companion: CompanionMirror | null;
}

/** 탭의 살아 있는 provider 프로세스(Claude·Codex)를 모두 내린다. */
function closeProviderSessions(tabId: string) {
  closeClaudeSession(tabId);
  closeCodexSession(tabId);
}

export interface SessionStore {
  appendEvent(tabId: string, event: ChatEvent): void;
  readEvents(tabId: string): ChatEvent[];
  resetThread(tabId: string): void;
  /** 프롬프트 큐 영속화(선택). 없으면 큐는 메모리에만 산다. */
  savePromptQueue?(tabId: string, items: PendingPrompt[]): void;
  loadPromptQueue?(tabId: string): PendingPrompt[];
  /** 인계서 영속화(선택). 없으면 앱을 껐다 켤 때 맥락이 사라진다. */
  saveHandoffPrefix?(tabId: string, prefix: string | null): void;
  loadHandoffPrefix?(tabId: string): string | null;
}

export interface SessionManagerDeps {
  /** 돌고 있는 Codex 턴에 지시를 끼워 넣는다. 테스트에서 바꿔 끼운다(기본: codex-adapter 의 steerCodexTurn). */
  steerCodex?: typeof steerCodexTurn;
  emit(tabId: string, event: ChatEvent): void;
  /** tabId: 그 탭의 에이전트 프로세스에 자기 탭 id(SUDAL_TAB_ID)를 알려 준다. */
  claudeRuntime(tabId?: string): Promise<ClaudeRuntime>;
  codexRuntime(tabId?: string): Promise<CodexRuntime>;
  store?: SessionStore;
  /** 모르는 tabId 를 만났을 때 영속 모델에서 설정을 가져온다. */
  resolveConfig?(tabId: string): SessionConfig | null;
  /** 제목·sessionId·설정 변경을 영속 모델에 반영하도록 알린다. */
  onMeta?(
    tabId: string,
    patch: {
      title?: string;
      sessionId?: string | null;
      provider?: Provider;
      model?: string;
      policy?: PermissionPolicy;
      cwd?: string | null;
    },
  ): void;
  onStatus?(tabId: string, status: SessionStatus): void;
  maxConcurrent?: number;
  log?(tabId: string, line: string): void;
  /** 설정의 예열 스위치. false 면 warm() 은 아무것도 안 한다(턴은 정상 경로로 프로세스를 띄운다). */
  warmEnabled?(): boolean;
  /** Claude 턴 도중 알게 된 슬래시 커맨드 정보를 cwd 별 캐시에 반영한다. */
  onSlashCommands?(
    cwd: string,
    patch: { commands?: SlashCommandDto[]; terminal?: string[] },
  ): void;
  /** 턴 중 관측한 구독 한도(5시간/주간 창). */
  onRateLimit?(provider: Provider, limit: ProviderRateLimitDto): void;
  /** 백그라운드 작업 집합이 바뀌었다(턴 밖에서도 온다 — 턴이 끝난 뒤에도 도는 일이 있다). */
  onBackgroundTasks?(tabId: string, sessionId: string, tasks: LiveBackgroundTask[], source: BackgroundTasksSource): void;
  /** 백그라운드 작업 하나가 끝났다. */
  onTaskFinished?(tabId: string, note: TaskFinishedNote): void;
  /** provider 스트림이 끝났다(정상 종료·크래시·우리가 닫음). */
  onStreamEnded?(tabId: string, reason: string, expected: boolean): void;
  /** 터미널 모드: 이 탭의 pty 에 CLI 를 띄우고(spawn), 강제 종료(kill)한다. 종료는 terminalExited 로 알려 준다. */
  terminalCli?: {
    /** hookLog 가 있으면(Claude) CLI 에 훅을 주입해 그 파일로 이벤트를 남기게 한다. */
    spawn(
      tabId: string,
      provider: Provider,
      cwd: string,
      sessionId: string | null,
      isNew: boolean,
      hookLog: string | null,
    ): Promise<void>;
    kill(tabId: string): void;
  };
  /** 기록 파일 루트 (~/.claude/projects, ~/.codex/sessions). */
  transcriptRoots?: { claude: string; codex: string };
  /** 터미널 모드 훅 로그를 둘 디렉토리. 없으면 권한 대기 힌트를 끈다. */
  hookLogDir?: string;
  /** 컨트롤러 전환처럼 main 쪽에서 스냅샷이 바뀌었을 때 renderer 에 밀어 준다. */
  onSnapshot?(tabId: string, snapshot: SessionSnapshot): void;
}

const MAX_PROMPT_QUEUE = 20;

/** Claude 가 cwd 에 대응시키는 projects/ 하위 디렉토리 이름: 경로의 / 와 . 을 - 로. 심링크·정규화 차이를 대비해 realpath 것도 함께 본다. */
function claudeProjectDirs(root: string, cwd: string): string[] {
  const key = (p: string) => path.join(root, p.replace(/[\/.]/g, "-"));
  const out = [key(cwd)];
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) out.push(key(real));
  } catch {
    /* 없는 경로 */
  }
  return out;
}

/** 하위 에이전트를 띄우는 도구 — 이 카드가 열려 있는 동안 companion Codex 를 찾는다. */
const AGENT_TOOLS = new Set(["Skill", "Agent", "Task"]);

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: string[] = [];
  private maxConcurrent: number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
  }

  /** 동시 실행 상한을 바꾼다. 올리면 기다리던 턴을 바로 시작하고, 내려도 진행 중인 턴은 그대로 둔다(새 시작만 막힘). */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** 동시 작업 수에서 빼는 탭(오케스트레이션 코디네이터 — 인박스를 기다리는 동안 워커 자리를 막지 않게). */
  private exemptTabs = new Set<string>();
  setExemptTabs(ids: Iterable<string>): void {
    this.exemptTabs = new Set(ids);
    this.drain();
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.round(n));
    this.drain();
    this.broadcastQueued();
  }

  private queueInfo(tabId: string): QueueInfoDto | null {
    const i = this.queue.indexOf(tabId);
    if (i === -1) return null;
    let running = 0;
    let waitingPermission = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "running") running += 1;
      else if (s.status === "waiting_permission") {
        running += 1;
        waitingPermission += 1;
      }
    }
    return { position: i + 1, running, max: this.maxConcurrent, waitingPermission };
  }

  /** 진행 중 수나 대기 순번이 바뀌면 기다리는 탭들의 표시를 갱신한다. */
  private broadcastQueued() {
    for (const tabId of this.queue) this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  ensure(tabId: string, defaults?: Partial<SessionConfig>): Session {
    let s = this.sessions.get(tabId);
    if (!s) {
      const resolved = this.deps.resolveConfig?.(tabId) ?? null;
      s = {
        tabId,
        provider: defaults?.provider ?? resolved?.provider ?? "claude",
        cwd: defaults?.cwd ?? resolved?.cwd ?? null,
        policy: defaults?.policy ?? resolved?.policy ?? "ask",
        model: defaults?.model ?? resolved?.model,
        status: "idle",
        sessionId: defaults?.sessionId ?? resolved?.sessionId ?? null,
        abort: null,
        ambientStopped: false,
        bgTaskFinished: false,
        ambientFromBg: false,
        pending: new Map(),
        pendingReqs: new Map(),
        events: null,
        dedupe: null,
        // 전환·압축 때 만든 인계서. 다음 메시지에 실려 나가기 전에 앱이 꺼졌으면 디스크에서 되살린다.
        handoffPrefix: this.deps.store?.loadHandoffPrefix?.(tabId) ?? null,
        startedAt: null,
        turnStartedAt: null,
        queued: null,
        // 지난 실행(또는 닫았던 탭)에서 남은 대기 지시를 복원한다. 자동으로 보내지는 않고, 다음 턴이 끝나거나 "지금 보내기" 로 나간다.
        promptQueue: this.deps.store?.loadPromptQueue?.(tabId) ?? [],
        limitWait: null,
        limitAttempts: 0,
        controller: "app",
        mirror: null,
        hookWatcher: null,
        hookLog: null,
        attention: null,
        codexApproval: null,
        external: null,
        companion: null,
      };
      this.sessions.set(tabId, s);
    }
    return s;
  }

  snapshot(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    return {
      tabId,
      provider: s.provider,
      cwd: s.cwd,
      policy: s.policy,
      model: s.model,
      status: s.status,
      sessionId: s.sessionId,
      handoffPending: s.handoffPrefix !== null,
      startedAt: s.startedAt,
      turnStartedAt: s.turnStartedAt,
      controller: s.controller,
      terminalAttention: s.attention,
      terminalExternal: s.external !== null,
      pendingPrompts: s.promptQueue.map((p) => ({ id: p.id, text: p.text, hasImages: p.images.length > 0 })),
      limitWait: s.limitWait
        ? { until: s.limitWait.until, attempts: s.limitWait.attempts, message: s.limitWait.message }
        : null,
      queueInfo: s.status === "queued" ? this.queueInfo(tabId) : null,
      ambientFromBg: s.ambientFromBg,
    };
  }

  // ===== 사용 한도 도달 → 자동 재시도 =====

  /**
   * 턴이 한도 오류로 끝났다: 그 턴을 보관하고 리셋 시각에 다시 보낸다(사용자 메시지는 다시 기록하지 않음).
   * 리셋 시각을 모르면 예약 없이 배너만 띄운다(수동 재시도). 상한을 넘으면 예약하지 않는다.
   */
  private scheduleLimitRetry(s: Session, turn: QueuedTurn, message: string, rejectedResetsAt: number | null) {
    const attempts = (s.limitWait?.attempts ?? 0) + 1;
    this.clearLimitTimer(s);
    const until = attempts <= USAGE_LIMIT_MAX_RETRIES ? usageLimitRetryAt(message, rejectedResetsAt, Date.now()) : null;
    const tabId = s.tabId;
    s.limitWait = {
      until,
      attempts,
      message: message.split("\n")[0].slice(0, 200),
      turn,
      timer: until ? setTimeout(() => this.limitRetryNow(tabId), until - Date.now() + 5_000) : null,
    };
    this.record(s, {
      type: "error",
      ts: Date.now(),
      fatal: false,
      ...(until
        ? appMsg("session.msg.limit.retryAt", { until, attempts })
        : attempts > USAGE_LIMIT_MAX_RETRIES
          ? appMsg("session.msg.limit.gaveUp", { max: USAGE_LIMIT_MAX_RETRIES })
          : appMsg("session.msg.limit.unknownReset")),
    });
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  private clearLimitTimer(s: Session) {
    if (s.limitWait?.timer) clearTimeout(s.limitWait.timer);
    if (s.limitWait) s.limitWait.timer = null;
  }

  /** 지금 바로 다시 시도 (예약 시각 전이라도). 실행 중이면 무시. */
  limitRetryNow(tabId: string): SessionSnapshot {
    const s = this.sessions.get(tabId);
    if (!s) return this.snapshot(tabId);
    const wait = s.limitWait;
    if (!wait) return this.snapshot(tabId);
    this.clearLimitTimer(s);
    if (this.isBusy(tabId) || s.controller !== "app") {
      // 지금은 보낼 수 없다(다른 턴 실행 중·터미널 모드): 타이머를 짧게 다시 걸어 놓친 채로 남지 않게 한다.
      wait.timer = setTimeout(() => this.limitRetryNow(tabId), 30_000);
      return this.snapshot(tabId);
    }
    // attempts 는 다음 실패 때 이어 세도록 옮겨 두고, limitWait 는 지운다(실패하면 scheduleLimitRetry 가 다시 만든다).
    s.limitAttempts = wait.attempts;
    s.limitWait = null;
    s.queued = wait.turn;
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    // 동시 실행 상한은 일반 전송과 같이 지킨다(예외 탭은 바로 시작).
    if (!this.canStart(tabId)) {
      this.queue.push(tabId);
      this.setStatus(s, "queued");
    } else this.start(s);
    return this.snapshot(tabId);
  }

  limitCancel(tabId: string): SessionSnapshot {
    const s = this.sessions.get(tabId);
    if (!s) return this.snapshot(tabId);
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    return this.snapshot(tabId);
  }

  // ===== 프롬프트 큐 =====

  queueRemove(tabId: string, id: string): SessionSnapshot {
    const s = this.ensure(tabId);
    if (s.steeringId === id) return this.snapshot(tabId);
    const n = s.promptQueue.length;
    s.promptQueue = s.promptQueue.filter((p) => p.id !== id);
    if (s.promptQueue.length !== n) {
      this.persistQueue(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    return this.snapshot(tabId);
  }

  queueUpdate(tabId: string, id: string, text: string): SessionSnapshot {
    const s = this.ensure(tabId);
    if (s.steeringId === id) return this.snapshot(tabId);
    const p = s.promptQueue.find((x) => x.id === id);
    if (p) {
      p.text = text;
      if (p.userEvent.type === "user_message") p.userEvent = { ...p.userEvent, text };
      this.persistQueue(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    return this.snapshot(tabId);
  }

  /**
   * 예열: 탭이 활성화되거나 cwd 가 정해졌을 때 Claude 프로세스를 미리 띄워 첫 턴도 웜으로 시작하게 한다.
   * Claude·앱 제어·cwd 있음·턴 없음일 때만. 실패는 조용히 로그만(다음 턴이 정상 경로로 다시 띄운다).
   */
  async warm(tabId: string): Promise<void> {
    if (this.deps.warmEnabled && !this.deps.warmEnabled()) return;
    const s = this.ensure(tabId);
    if (!s.cwd || s.controller !== "app" || this.isBusy(tabId)) return;
    const req = {
      sessionKey: tabId,
      cwd: s.cwd,
      sessionId: s.sessionId,
      policy: s.policy,
      model: s.model,
      log: (line: string) => this.deps.log?.(tabId, line),
      onBackgroundTasks: (sessionId: string, tasks: LiveBackgroundTask[], source: BackgroundTasksSource) => this.deps.onBackgroundTasks?.(tabId, sessionId, tasks, source),
      onTaskFinished: (note: TaskFinishedNote) => {
        this.ensure(tabId).bgTaskFinished = true;
        this.deps.onTaskFinished?.(tabId, note);
      },
      onStreamEnded: (reason: string, expected: boolean) => this.deps.onStreamEnded?.(tabId, reason, expected),
      onAmbientEvent: (event: ChatEvent) => this.ambientEvent(tabId, event),
      requestAmbientPermission: (req: PermissionRequestEvent) => this.waitPermission(this.ensure(tabId), req, new AbortController().signal),
    };
    try {
      if (s.provider === "claude") {
        const r = await warmClaudeSession(await this.deps.claudeRuntime(tabId), req);
        if (r === "opened") this.deps.log?.(tabId, "[claude] 예열 시작");
      } else {
        const r = await warmCodexSession(await this.deps.codexRuntime(tabId), req);
        if (r === "opened") this.deps.log?.(tabId, "[codex] 예열 시작");
      }
    } catch (e) {
      this.deps.log?.(tabId, `[${s.provider}] 예열 실패: ${describeError(e)}`);
    }
  }

  /**
   * Codex 가 작업 중일 때 대기열의 지시 하나를 돌고 있는 턴에 바로 끼워 넣는다(turn/steer).
   * 성공하면 대기열에서 빼고 사용자 메시지로 남긴다. 실패하면(그새 턴이 끝났거나 끼워 넣을 수 없는 턴) 대기열에 그대로 둔다.
   */
  async queueSteer(tabId: string, id: string): Promise<{ ok: true; snapshot: SessionSnapshot } | { ok: false; error: string; snapshot: SessionSnapshot }> {
    const s = this.ensure(tabId);
    const p = s.promptQueue.find((x) => x.id === id);
    const fail = (error: string) => ({ ok: false as const, error, snapshot: this.snapshot(tabId) });
    if (!p) return fail(mt("session.error.queueMissing"));
    if (s.provider !== "codex" || s.controller !== "app" || (s.status !== "running" && s.status !== "waiting_permission"))
      return fail(mt("session.error.steerCodexOnly"));
    if (s.steeringId) return fail(mt("session.error.steerBusy"));
    // 보낸 그대로를 기록한다 — 응답을 기다리는 사이 항목이 바뀌어도(수정·삭제는 막지만) 보낸 것과 어긋나지 않게
    const sent = { text: p.text, images: p.images, userEvent: p.userEvent };
    s.steeringId = id;
    try {
      await (this.deps.steerCodex ?? steerCodexTurn)(tabId, sent.text, sent.images);
    } catch (e) {
      return fail(describeError(e));
    } finally {
      s.steeringId = null;
    }
    s.promptQueue = s.promptQueue.filter((x) => x.id !== id);
    this.persistQueue(s);
    this.record(s, { ...sent.userEvent, ts: Date.now() });
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    return { ok: true, snapshot: this.snapshot(tabId) };
  }

  /** 세션이 놀고 있을 때(복원됐거나 오류로 끝난 뒤) 큐 맨 앞을 지금 보낸다. 진행 중이면 아무것도 안 한다. */
  queueSendNext(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    // 사용자가 직접 누른 것이므로 오류로 멈춘 상태에서도 보낸다(자동 drain 은 정상 종료 뒤에만).
    this.drainPending(s, { allowError: true });
    return this.snapshot(tabId);
  }

  /** 인계서는 만드는 데 턴 하나가 드는 글이다 — 메모리와 디스크를 같이 움직인다. */
  private setHandoffPrefix(s: Session, prefix: string | null) {
    s.handoffPrefix = prefix;
    this.deps.store?.saveHandoffPrefix?.(s.tabId, prefix);
  }

  private persistQueue(s: Session) {
    this.deps.store?.savePromptQueue?.(s.tabId, s.promptQueue);
  }

  /** 턴이 정상 종료됐을 때: 큐 맨 앞을 보낸다. 오류로 끝났으면 멈춰 두고 사용자에게 맡긴다(allowError 는 "지금 보내기" 전용). */
  private drainPending(s: Session, opts: { allowError?: boolean } = {}) {
    // release() 로 내려간 세션 객체(탭 닫기·삭제)는 더 이상 이 매니저의 것이 아니다 — 큐를 소비하지 않고 디스크에 남긴다.
    if (this.sessions.get(s.tabId) !== s) return;
    const restable = s.status === "idle" || (opts.allowError && s.status === "error");
    if (s.controller !== "app" || s.limitWait || !restable || s.promptQueue.length === 0 || this.isBusy(s.tabId)) return;
    const next = s.promptQueue.shift()!;
    this.persistQueue(s);
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
    void this.send(s.tabId, next.text, next.images, { ...next.userEvent, ts: Date.now() }).then((r) => {
      // 보낼 수 없었으면(작업 경로 없음 등) 조용히 버리지 않고 남긴다.
      if (!r.ok)
        this.record(s, {
          type: "error",
          ts: Date.now(),
          fatal: false,
          ...appMsg("session.msg.queueSendFailed", { detail: r.error, text: next.text.slice(0, 200) }),
        });
    });
  }

  // ===== 터미널 모드 (하이브리드): 같은 세션 id 를 앱과 CLI 가 번갈아 잡는다 =====

  /**
   * 세션 제어를 터미널로 넘긴다. Claude 는 세션 id 가 없으면 지금 만들어 --session-id 로 넘기고(나중에 SDK resume 가능),
   * Codex 는 새 세션이면 rollout 파일이 생긴 뒤 그 id 를 가져온다. 기록 파일 미러는 CLI 가 종료될 때까지 돈다.
   */
  async attachTerminal(
    tabId: string,
  ): Promise<
    { ok: true; snapshot: SessionSnapshot } | { ok: false; error: string }
  > {
    const s = this.ensure(tabId);
    if (s.controller === "terminal")
      return { ok: true, snapshot: this.snapshot(tabId) };
    if (this.isBusy(tabId))
      return {
        ok: false,
        error: mt("session.error.terminalAfterTurn"),
      };
    if (!s.cwd) return { ok: false, error: mt("session.error.cwdFirst") };
    if (!this.deps.terminalCli)
      return { ok: false, error: mt("session.error.terminalUnavailable") };
    // 같은 세션 id 에 앱의 SDK 프로세스와 CLI 가 동시에 붙으면 안 된다 — 살아 있던 프로세스를 먼저 내린다.
    closeProviderSessions(tabId);
    const isNew = !s.sessionId;
    if (s.provider === "claude" && !s.sessionId) {
      s.sessionId = randomUUID();
      this.deps.onMeta?.(tabId, { sessionId: s.sessionId });
    }
    s.controller = "terminal";
    this.setHandoffPrefix(s, null);
    // 터미널이 세션을 잡는 동안 앱의 자동 재시도는 의미가 없다 — 예약을 지운다(큐는 돌아오면 이어 간다).
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
    }
    s.hookLog = this.prepareHookLog(s);
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    try {
      await this.deps.terminalCli.spawn(
        tabId,
        s.provider,
        s.cwd,
        s.sessionId,
        isNew,
        s.hookLog,
      );
    } catch (e) {
      s.controller = "app";
      this.stopHookWatcher(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
      return { ok: false, error: describeError(e) };
    }
    this.startMirror(s, isNew);
    this.startHookWatcher(s);
    return { ok: true, snapshot: this.snapshot(tabId) };
  }

  /** Claude 만: 세션 id 이름의 빈 훅 로그를 만든다. id 가 파일 이름으로 안전한 형식(UUID 등)이 아니면 힌트를 끈다. */
  private prepareHookLog(s: Session): string | null {
    const dir = this.deps.hookLogDir;
    if (!dir || s.provider !== "claude" || !s.sessionId) return null;
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(s.sessionId)) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${s.sessionId}.jsonl`);
      fs.writeFileSync(file, "");
      return file;
    } catch {
      return null;
    }
  }

  private startHookWatcher(s: Session) {
    if (!s.hookLog) return;
    // 돌던 워처만 놓는다. stopHookWatcher 는 훅 로그 파일까지 지우므로 여기서 부르면
    // 방금 만들어 둔 로그가 사라져 권한 대기·세션 전환 신호가 영영 오지 않는다.
    s.hookWatcher?.stop();
    s.hookWatcher = null;
    const tabId = s.tabId;
    s.hookWatcher = new TranscriptWatcher<HookEvent>({
      resolveFile: () => s.hookLog,
      map: (line) => mapClaudeHookLine(line),
      skipExisting: false,
      intervalMs: 400,
      onEvents: (events) => {
        const cur = this.sessions.get(tabId);
        if (!cur || cur.controller !== "terminal") return;
        for (const e of events) this.applyHookEvent(cur, e);
      },
    });
    s.hookWatcher.start();
  }

  private applyHookEvent(s: Session, e: HookEvent) {
    if (e.type === "permission_request") {
      this.setAttention(s, {
        kind: "permission",
        tool: e.tool,
        summary: summarizeToolInput(e.tool, e.input),
        since: e.ts,
      });
    } else if (e.type === "tool_done") {
      // 같은 툴이 끝났을 때만 (병렬로 돌던 다른 툴의 종료가 대기 표시를 지우지 않게)
      if (s.attention && s.attention.tool === e.tool) this.setAttention(s, null);
    } else if (e.type === "stop") {
      this.setAttention(s, null);
    } else if (e.type === "session") {
      // TUI 안에서 /resume 등으로 다른 세션에 갈아탔다: 그 세션의 지금까지 대화를 채팅에 불러오고, 그 뒤부터 미러를 이어 간다.
      if (s.provider !== "claude" || e.sessionId === s.sessionId) return;
      const roots = this.deps.transcriptRoots;
      const file =
        e.transcriptPath && fs.existsSync(e.transcriptPath) ? e.transcriptPath : roots ? findClaudeTranscript(roots.claude, e.sessionId) : null;
      this.switchToTranscript(s, e.sessionId, file, e.ts);
    }
  }

  /**
   * 세션을 갈아탄다(TUI 의 /resume, 통합 터미널에서 직접 띄운 CLI 등): 그 세션의 지금까지 기록을 채팅에 불러오고,
   * 안내 한 줄을 사이에 두고, 미러는 읽은 바이트 뒤부터 잇는다. 이 탭의 기존 기록은 지우지 않는다. 탭의 세션 id 는 새 것으로.
   */
  private switchToTranscript(s: Session, sessionId: string, file: string | null, ts: number) {
    s.mirror?.stop();
    s.mirror = null;
    const history = file ? this.readTranscript(file, s.provider) : { events: [], bytes: 0 };
    // 재개처럼 "같은 대화인데 id 만 새로 붙은" 경우가 있다. 이미 가진 것을 빼고 새로 생긴 뒷부분만 받는다.
    const cutStats: ReplayCutStats = { keyed: 0, known: 0, cut: 0, firstMissAt: -1, knownAfterMiss: 0 };
    const fresh = dropReplayedPrefix(this.dedupeIndex(s), history.events, cutStats);
    // 자르기가 첫 미스에서 멈췄는데 그 뒤로도 이미 가진 것이 더 있었다 = 되풀이인데 못 잘랐다.
    // 그만큼이 화면에 한 벌 더 쌓인다. 실측(스레드 20개)에서는 자르기 도입 뒤의 사례가 아직 없어,
    // 짐작으로 열쇠를 늘리기 전에 실제로 생기는지부터 남겨 둔다.
    if (cutStats.knownAfterMiss > 0)
      this.deps.log?.(
        s.tabId,
        `[dedupe] 되풀이를 다 자르지 못했습니다 — 열쇠 ${cutStats.keyed}건 중 아는 것 ${cutStats.known}건, ` +
          `잘라 낸 것 ${cutStats.cut}건, ${cutStats.firstMissAt}번째에서 멈춘 뒤 아는 것이 ${cutStats.knownAfterMiss}건 더 있었습니다`,
      );
    const turns = fresh.filter((h) => h.type === "user_message").length;
    s.sessionId = sessionId;
    this.deps.onMeta?.(s.tabId, { sessionId });
    this.record(s, {
      type: "error",
      ts,
      fatal: false,
      ...appMsg(turns > 0 ? "session.msg.switched.withTurns" : "session.msg.switched.noTurns", { id: sessionId.slice(0, 8), count: turns }),
    });
    for (const h of fresh) this.record(s, h);
    this.record(s, { type: "session", ts, sessionId, provider: s.provider });
    this.startMirror(s, false, file, file ? history.bytes : null);
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
  }

  // ===== 통합 터미널에서 직접 띄운 CLI =====

  /**
   * 사용자 셸(통합 터미널)에서 claude/codex 가 떴다. 탭이 놀고 있고 provider 가 맞으면 터미널 모드(외부)로 들어가
   * 그 CLI 가 쓰는 기록 파일을 찾아 미러한다. 어느 파일인지는 모르므로 "감지 이후에 바뀐 가장 최근 파일" 을 따라간다
   * (/resume 으로 옛 세션을 이어도 첫 프롬프트부터 그 파일이 바뀐다). 파일이 바뀌면 그 세션의 이전 대화를 불러온다.
   */
  externalCliStarted(tabId: string, provider: Provider, cwd: string, pid: number, resumeId: string | null = null): void {
    const s = this.ensure(tabId);
    if (s.controller !== "app" || this.isBusy(tabId) || s.external) return;
    if (s.provider !== provider) {
      // 조용히 넘기면 "터미널에서 띄웠는데 채팅에 아무것도 안 뜬다" 로 보인다 — 이유를 채팅에 남긴다.
      this.record(s, {
        type: "error",
        ts: Date.now(),
        fatal: false,
        ...appMsg("session.msg.providerMismatch", { launched: PROVIDER_LABEL[provider], current: PROVIDER_LABEL[s.provider] }),
      });
      return;
    }
    const roots0 = this.deps.transcriptRoots;
    if (!roots0) return;
    closeProviderSessions(tabId); // 같은 세션에 앱 프로세스와 CLI 가 같이 붙지 않게
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
    }
    s.controller = "terminal";
    this.setHandoffPrefix(s, null);
    s.external = { pid, cwd, watch: null, since: Date.now() - 2000 };
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    // 명령에 세션 id 가 있으면(`codex resume <id>`) 바로 그 세션을 붙인다 —
    // 첫 턴을 보내기 전에는 기록 파일이 그대로라 "최근에 바뀐 파일" 로는 찾을 수 없다.
    if (resumeId) {
      const file =
        provider === "codex" ? findCodexRollout(roots0.codex, { sessionId: resumeId }) : findClaudeTranscript(roots0.claude, resumeId);
      if (!file) this.deps.log?.(tabId, `[external] resume 세션 ${resumeId} 의 기록 파일을 찾지 못했습니다`);
      else if (resumeId !== s.sessionId) this.switchToTranscript(s, resumeId, file, Date.now());
      // 이 탭이 이미 붙어 있던 세션을 터미널에서 그대로 이어받았다: 대화는 화면에 있으니 다시 불러오지 않고 뒤만 잇는다.
      // 아래 tick 은 같은 세션이면 넘기므로, 여기서 켜지 않으면 미러가 영영 시작되지 않는다.
      else this.startMirror(s, false, file, null);
    }
    const tick = () => {
      const cur = this.sessions.get(tabId);
      if (!cur || cur.external === null) return;
      const found = this.newestTranscriptSince(cur.provider, cur.external.cwd, cur.external.since);
      if (!found || found.sessionId === cur.sessionId) return;
      this.switchToTranscript(cur, found.sessionId, found.file, Date.now());
    };
    s.external.watch = setInterval(tick, 1000);
    tick();
  }

  /** 그 CLI 프로세스가 끝났다(또는 셸이 닫혔다): 제어를 앱으로 돌린다. 세션 id 는 그대로 — 채팅에서 이어 보내면 그 세션이 계속된다. */
  externalCliExited(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || !s.external) return;
    if (s.external.watch) clearInterval(s.external.watch);
    s.external = null;
    s.mirror?.stop();
    s.mirror = null;
    s.attention = null;
    s.controller = "app";
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    this.deps.onStatus?.(tabId, s.status);
    this.drainPending(s);
  }

  /** 감지 시각 이후에 쓰인 가장 최근 기록 파일. Claude 는 cwd 의 프로젝트 디렉토리, Codex 는 rollout 탐색. */
  private newestTranscriptSince(provider: Provider, cwd: string, since: number): { sessionId: string; file: string } | null {
    const roots = this.deps.transcriptRoots;
    if (!roots) return null;
    if (provider === "codex") {
      const file = findCodexRollout(roots.codex, { cwd, after: since });
      const id = file ? readCodexRolloutMeta(file)?.sessionId : null;
      return file && id ? { sessionId: id, file } : null;
    }
    let best: { sessionId: string; file: string; mtime: number } | null = null;
    for (const dir of claudeProjectDirs(roots.claude, cwd)) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = path.join(dir, n);
        let mtime: number;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < since) continue;
        if (!best || mtime > best.mtime) best = { sessionId: n.slice(0, -6), file, mtime };
      }
    }
    return best ? { sessionId: best.sessionId, file: best.file } : null;
  }

  /** 기록 파일 전체를 채팅 이벤트로 바꾼다. bytes 는 읽은 길이 — 미러가 그 뒤부터 잇게. */
  private readTranscript(file: string, provider: Provider): { events: ChatEvent[]; bytes: number } {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return { events: [], bytes: 0 };
    }
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    // 줄 경계까지만 — 쓰다 만 마지막 줄은 미러가 마저 읽는다
    const whole = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
    const state = newMirrorState();
    const map = provider === "codex" ? mapCodexRolloutLine : mapClaudeTranscriptLine;
    const events: ChatEvent[] = [];
    for (const line of whole.split("\n")) if (line.trim()) events.push(...map(line, state));
    return { events, bytes: Buffer.byteLength(whole, "utf8") };
  }

  /** 미러된 tool_result 가 대기 중인 툴의 것인지 — 기록의 tool_use 이름으로 대조한다. */
  private resultMatchesAttention(s: Session, toolUseId: string): boolean {
    if (!s.attention) return false;
    const use = (s.events ?? []).find(
      (e) => e.type === "tool_use" && e.toolUseId === toolUseId,
    );
    return !use || (use.type === "tool_use" && use.name === s.attention.tool);
  }

  private setAttention(s: Session, next: TerminalAttention | null) {
    if (s.attention === next) return;
    if (
      s.attention &&
      next &&
      s.attention.tool === next.tool &&
      s.attention.summary === next.summary
    )
      return;
    s.attention = next;
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
  }

  /**
   * 터미널 모드 CLI 의 pty 출력. Codex 는 훅이 없어 화면 문구로 승인 프롬프트를 알아낸다(Claude 는 훅 로그가 담당하므로 무시).
   * "Approved action:" 이 찍히면 답한 것으로 보고 내린다.
   */
  terminalOutput(tabId: string, data: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal" || s.provider !== "codex") return;
    s.codexApproval ??= new CodexApprovalDetector();
    const signal = s.codexApproval.push(data);
    if (!signal) return;
    if (signal.kind === "prompt") this.setAttention(s, signal.attention);
    else this.setAttention(s, null);
  }

  /**
   * 사용자가 CLI pty 에 친 입력. 권한 다이얼로그가 떠 있을 때 Enter/Esc/번호/y/n 은 답한 것으로 보고 힌트를 내린다.
   * 훅은 "떴다" 만 알려 주고 "허용했다" 는 알려 주지 않아서(툴이 끝나야 PostToolUse) 이 휴리스틱으로 빈틈을 메운다.
   */
  terminalInput(tabId: string, data: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal" || !s.attention) return;
    // 단독 ESC 만 취소로 본다 — 방향키(\x1b[A)·마우스 리포트 같은 ESC 시퀀스는 아직 답한 게 아니다.
    if (data === "\x1b" || /[\r\n]/.test(data) || /^[0-9yYnN]$/.test(data))
      this.setAttention(s, null);
  }

  /** 사용자가 "채팅으로 돌아가기" 를 눌렀을 때: CLI 를 끊는다. 실제 복귀는 terminalExited 에서. */
  detachTerminal(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal" || s.external) return;
    this.deps.terminalCli?.kill(tabId);
  }

  /** pty 의 CLI 프로세스가 끝났다: 마지막으로 기록을 따라잡고 제어를 앱으로 되돌린다. */
  terminalExited(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal") return;
    s.mirror?.stop();
    const file = s.mirror?.currentFile() ?? null;
    s.mirror = null;
    this.stopHookWatcher(s);
    s.attention = null;
    s.codexApproval = null;
    s.controller = "app";
    // CLI 가 첫 메시지 전에 끝나면 기록 파일이 없다 → 그 id 로 SDK resume 하면 실패하므로 새 세션으로 돌린다.
    if (s.sessionId && !file) {
      const roots = this.deps.transcriptRoots;
      const exists =
        roots &&
        (s.provider === "claude"
          ? findClaudeTranscript(roots.claude, s.sessionId) !== null
          : findCodexRollout(roots.codex, { sessionId: s.sessionId }) !== null);
      if (!exists) {
        s.sessionId = null;
        this.deps.onMeta?.(tabId, { sessionId: null });
      }
    }
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    this.deps.onStatus?.(tabId, s.status);
    // 터미널 구간 동안 써 둔 다음 지시가 있으면 이어서 보낸다.
    this.drainPending(s);
  }

  private stopHookWatcher(s: Session) {
    s.hookWatcher?.stop();
    s.hookWatcher = null;
    if (s.hookLog) {
      try {
        fs.rmSync(s.hookLog, { force: true });
      } catch {
        /* 무시 */
      }
      s.hookLog = null;
    }
  }

  /** fileHint: 훅이 알려 준 기록 파일 경로. 있으면 그걸 우선 쓴다(projects/ 아래 어느 키 디렉토리에 있든). startOffset: 그 파일에서 이미 읽어 들인 길이. */
  private startMirror(s: Session, isNew: boolean, fileHint: string | null = null, startOffset: number | null = null) {
    const roots = this.deps.transcriptRoots;
    if (!roots) return;
    // 이미 돌던 워처가 있으면 놓고 간다. 남겨 두면 같은 파일을 둘이 tail 하며 같은 줄을 두 번 옮긴다.
    s.mirror?.stop();
    s.mirror = null;
    const startedAt = Date.now();
    const tabId = s.tabId;
    const onEvents = (events: ChatEvent[]) => {
      const cur = this.sessions.get(tabId);
      if (!cur || cur.controller !== "terminal") return;
      const hadUser = this.events(tabId).some((e) => e.type === "user_message");
      for (const e of events) {
        this.record(cur, e);
        if (!hadUser && e.type === "user_message" && e.text.trim())
          this.deps.onMeta?.(tabId, { title: e.text });
        // 권한을 거절하면 곧바로 tool_result(오류) 가 기록된다 → 대기 힌트를 내린다 (그 툴의 결과일 때만).
        if (e.type === "tool_result" && this.resultMatchesAttention(cur, e.toolUseId))
          this.setAttention(cur, null);
      }
    };
    if (s.provider === "claude") {
      const sessionId = s.sessionId!;
      s.mirror = new TranscriptWatcher({
        resolveFile: () => (fileHint && fs.existsSync(fileHint) ? fileHint : findClaudeTranscript(roots.claude, sessionId)),
        map: mapClaudeTranscriptLine,
        onEvents,
        skipExisting: !isNew,
        ...(startOffset !== null ? { startOffset } : {}),
      });
    } else {
      const cwd = s.cwd;
      s.mirror = new TranscriptWatcher({
        resolveFile: () =>
          fileHint && fs.existsSync(fileHint)
            ? fileHint
            : s.sessionId
              ? findCodexRollout(roots.codex, { sessionId: s.sessionId })
              : findCodexRollout(roots.codex, { cwd, after: startedAt }),
        map: mapCodexRolloutLine,
        onEvents,
        skipExisting: !isNew,
        ...(startOffset !== null ? { startOffset } : {}),
        onFile: (file) => {
          // 새 Codex 세션이면 rollout 의 session_meta 에서 id 를 가져와 나중에 SDK 가 이어받게 한다.
          if (s.sessionId) return;
          const meta = readCodexRolloutMeta(file);
          if (meta?.sessionId) {
            s.sessionId = meta.sessionId;
            this.deps.onMeta?.(tabId, { sessionId: meta.sessionId });
            this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
          }
        },
      });
    }
    s.mirror.start();
  }

  /**
   * "이 턴에서 분기" 의 출발점. 분기할 수 있는지 보고, 새 탭에 옮길 기록(그 턴 끝까지)을 돌려준다.
   * 분기 지점은 탭의 지금 provider 세션 것이어야 한다 — provider 를 바꾸기 전 턴이나 분기로 복사된 턴은 다른 세션을 가리킨다.
   * 팬아웃·리뷰·검증·오케스트레이션 카드는 원래 탭의 작업(worktree 삭제 같은 동작이 딸림)이라 옮기지 않는다.
   */
  forkSource(tabId: string, pointId: string):
    | { ok: true; point: ForkPoint; cwd: string; provider: Provider; model?: string; policy: PermissionPolicy; prefix: ChatEvent[] }
    | { ok: false; error: string } {
    const s = this.ensure(tabId);
    if (s.controller !== "app") return { ok: false, error: mt("session.error.forkTerminal") };
    if (this.isBusy(tabId)) return { ok: false, error: mt("session.error.forkBusy") };
    if (!s.cwd) return { ok: false, error: mt("session.error.noCwd") };
    const events = this.loadEvents(s);
    const idx = events.findIndex((e) => e.type === "turn_result" && e.forkPoint?.pointId === pointId);
    const point = idx >= 0 ? (events[idx] as TurnResultEvent).forkPoint! : null;
    if (!point) return { ok: false, error: mt("session.error.forkPointMissing") };
    if (point.provider !== s.provider || point.sessionId !== s.sessionId)
      return { ok: false, error: mt("session.error.forkNotCurrent") };
    const carried = new Set<ChatEvent["type"]>(["review", "verify", "fanout", "orchestration", "thinking_delta", "subagent_activity"]);
    const prefix = events.slice(0, idx + 1).filter((e) => !carried.has(e.type));
    return { ok: true, point, cwd: s.cwd, provider: s.provider, model: s.model, policy: s.policy, prefix };
  }

  /** 분기로 만든 새 탭에 새 provider 세션과 옮겨 온 기록을 심는다. 대기열·예약·백그라운드는 물려받지 않는다. */
  adoptFork(tabId: string, cfg: { provider: Provider; cwd: string; model?: string; policy: PermissionPolicy; sessionId: string }, prefix: ChatEvent[]): SessionSnapshot {
    const s = this.ensure(tabId);
    closeProviderSessions(tabId);
    s.provider = cfg.provider;
    s.cwd = cfg.cwd;
    s.model = cfg.model;
    s.policy = cfg.policy;
    s.sessionId = cfg.sessionId;
    this.deps.onMeta?.(tabId, { provider: cfg.provider, cwd: cfg.cwd, model: cfg.model, policy: cfg.policy, sessionId: cfg.sessionId });
    const now = Date.now();
    for (const e of prefix) this.record(s, e);
    this.record(s, { type: "session", ts: now, sessionId: cfg.sessionId, provider: cfg.provider, ...(cfg.model ? { model: cfg.model } : {}) });
    this.record(s, { type: "status", ts: now, status: "idle" });
    this.record(s, { type: "notice", ts: now, level: "notice", ...appMsg("session.msg.forked") });
    const snap = this.snapshot(tabId);
    this.deps.onSnapshot?.(tabId, snap);
    return snap;
  }

  /** 앱 기능(교차 리뷰 등)이 탭 기록에 남기는 알림 이벤트. */
  note(tabId: string, event: ChatEvent): void {
    this.record(this.ensure(tabId), event);
  }

  statuses(): Record<string, SessionStatus> {
    const out: Record<string, SessionStatus> = {};
    for (const [id, s] of this.sessions) out[id] = s.status;
    return out;
  }

  events(tabId: string): ChatEvent[] {
    const s = this.ensure(tabId);
    return this.loadEvents(s);
  }

  configure(tabId: string, patch: Partial<SessionConfig>): SessionSnapshot {
    const s = this.ensure(tabId);
    const meta: Parameters<NonNullable<SessionManagerDeps["onMeta"]>>[1] = {};
    if (patch.provider && patch.provider !== s.provider) {
      // provider 가 바뀌면 이전 provider 의 세션 id 는 의미가 없다. 살아 있던 Claude 프로세스도 내린다.
      closeProviderSessions(tabId);
      s.provider = patch.provider;
      s.sessionId = null;
      meta.provider = patch.provider;
      meta.sessionId = null;
      // 모델 id 는 provider 에 딸린 것이다. 새 탭이 활성 탭의 모델을 물려받은 채 provider 만 바뀌면(CLI `tab new --provider codex`)
      // Codex 가 Claude 모델을 받아 400 으로 거절한다. 같은 patch 에 model 이 있으면 아래에서 그것으로 덮인다.
      if (s.model !== undefined) {
        s.model = undefined;
        meta.model = undefined;
      }
    }
    if (patch.cwd !== undefined && patch.cwd !== s.cwd) {
      // 작업 경로가 바뀌면 provider 세션은 새로 시작한다 (기록은 그대로). 살아 있던 프로세스는 옛 cwd 것이라 내린다.
      closeProviderSessions(tabId);
      s.cwd = patch.cwd;
      s.sessionId = null;
      meta.sessionId = null;
      meta.cwd = patch.cwd;
    }
    if (patch.policy) {
      const changed = patch.policy !== s.policy;
      s.policy = patch.policy;
      meta.policy = patch.policy;
      if (changed) this.applyPolicyNow(tabId, s, patch.policy);
    }
    if ("model" in patch) {
      s.model = patch.model || undefined;
      meta.model = s.model;
    }
    if (Object.keys(meta).length > 0) this.deps.onMeta?.(tabId, meta);
    const snap = this.snapshot(tabId);
    // 설정을 바꾼 호출자 말고도(다른 창·스크립트·마운트 중인 뷰) 모두 새 스냅샷을 받게 한다 — 뷰가 마운트 직후 가져온 옛 값이 남지 않게.
    if (Object.keys(meta).length > 0) this.deps.onSnapshot?.(tabId, snap);
    return snap;
  }

  /**
   * 워크스페이스 기본 경로가 바뀌었을 때, 그 경로를 물려받는 탭(자기 경로가 없는 탭)의 세션 cwd 를 맞춘다.
   * configure 와 달리 탭에 경로를 박아 두지 않는다(계속 워크스페이스 것을 따라야 하므로). 아직 세션이 없는 탭은
   * 다음 ensure 때 새 경로로 만들어지니 손대지 않는다.
   */
  inheritCwd(tabId: string, cwd: string | null): void {
    const s = this.sessions.get(tabId);
    if (!s || s.cwd === cwd) return;
    closeProviderSessions(tabId);
    s.cwd = cwd;
    s.sessionId = null;
    this.deps.onMeta?.(tabId, { sessionId: null });
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  /**
   * 압축을 provider 에게 맡길 수 있나. Claude 는 SDK 가 `/compact` 를 처리하고 결과가
   * compact_boundary 로 돌아온다 — 모델이 무엇을 남길지 정하므로 우리가 자르는 것보다 낫다.
   * Codex 는 app-server 에 압축이 없고, 터미널이 세션을 쥔 동안에는 우리가 턴을 보낼 수 없다.
   */
  canCompactNatively(tabId: string): boolean {
    const s = this.sessions.get(tabId);
    if (!s || s.provider !== "claude") return false;
    return !!s.sessionId && s.controller !== "terminal" && !this.isBusy(tabId);
  }

  /** provider 가 압축을 못 할 때의 대비책: 지금까지를 요약해 같은 provider 의 새 세션으로 넘긴다. */
  compactFallback(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    return this.switchProvider(tabId, {
      provider: s.provider,
      model: s.model,
      preserveContext: true,
    });
  }

  /** 전환 모달 미리보기: 지금까지의 이벤트로 요약과 통계를 만든다. */
  handoffPreview(tabId: string): Handoff {
    const s = this.ensure(tabId);
    return buildHandoff(mt, this.events(tabId), {
      cwd: s.cwd,
      fromProvider: PROVIDER_LABEL[s.provider],
    });
  }

  /**
   * provider 전환. 실행 중이면 현재 턴을 중단한다(SDK 에 툴콜 단위 정지가 없다).
   * preserveContext 면 요약을 다음 프롬프트 앞에 붙인다. 화면의 대화는 그대로 남는다.
   */
  switchProvider(
    tabId: string,
    opts: {
      provider: Provider;
      model?: string;
      preserveContext: boolean;
      /** 떠나는 provider 가 직접 쓴 인계서. 있으면 우리가 만든 요약 대신 이걸 넘긴다. */
      summary?: string;
    },
  ): SessionSnapshot {
    const s = this.ensure(tabId);
    if (this.isBusy(tabId)) this.abort(tabId);
    const events = this.events(tabId);
    const written = opts.preserveContext ? (opts.summary ?? "").trim() : "";
    const handoff = written
      ? { summary: written, stats: { messages: 0, files: 0, pendingTasks: 0, tokensEstimate: estimateTokens(written) } }
      : opts.preserveContext && events.length > 0
        ? this.handoffPreview(tabId)
        : null;
    const from = s.provider;
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
    }
    s.limitAttempts = 0;
    closeProviderSessions(tabId); // 새 세션으로 시작하므로 살아 있던 프로세스는 내린다
    s.provider = opts.provider;
    s.model = opts.model || undefined;
    s.sessionId = null;
    this.setHandoffPrefix(s, handoff ? handoff.summary : null);
    this.deps.onMeta?.(tabId, {
      provider: s.provider,
      model: s.model,
      sessionId: null,
    });
    this.record(s, { type: "session_reset", ts: Date.now() });
    this.record(s, {
      type: "error",
      ts: Date.now(),
      fatal: false,
      ...(from === opts.provider
        ? handoff
          ? appMsg("session.msg.reset.withSummary", { messages: handoff.stats.messages, files: handoff.stats.files })
          : appMsg("session.msg.reset.fresh")
        : handoff
          ? appMsg("session.msg.switchProvider.withSummary", {
              from: PROVIDER_LABEL[from],
              to: PROVIDER_LABEL[opts.provider],
              messages: handoff.stats.messages,
              files: handoff.stats.files,
            })
          : appMsg("session.msg.switchProvider.fresh", { from: PROVIDER_LABEL[from], to: PROVIDER_LABEL[opts.provider] })),
    });
    return this.snapshot(tabId);
  }

  /** 실행 중이거나 큐에 있으면 true. */
  isBusy(tabId: string): boolean {
    const s = this.sessions.get(tabId);
    return !!s && s.status !== "idle" && s.status !== "error";
  }

  private runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this.exemptTabs.has(s.tabId)) continue;
      if (s.status === "running" || s.status === "waiting_permission") n += 1;
    }
    return n;
  }

  async send(
    tabId: string,
    text: string,
    images: StoredChatImage[],
    userEvent: ChatEvent,
  ): Promise<{ ok: true; queued: boolean; pending?: boolean } | { ok: false; error: string }> {
    const s = this.ensure(tabId);
    if (s.controller === "terminal")
      return {
        ok: false,
        error: mt("session.error.terminalControlling"),
      };
    if (!s.cwd) return { ok: false, error: mt("session.error.noCwd") };
    if (this.isBusy(tabId) || s.limitWait) {
      // 턴 진행 중(또는 한도 재시도 대기 중): 큐에 넣고, 이 턴이 끝나면 자동으로 보낸다.
      if (s.promptQueue.length >= MAX_PROMPT_QUEUE)
        return { ok: false, error: mt("session.error.queueFull", { max: MAX_PROMPT_QUEUE }) };
      s.promptQueue.push({ id: randomUUID(), text, images, userEvent });
      this.persistQueue(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
      return { ok: true, queued: false, pending: true };
    }
    // 사용자가 새 지시를 직접 보내는 것이므로 이전 한도 재시도 예산은 리셋.
    s.limitAttempts = 0;

    // 첫 사용자 메시지가 탭 제목이 된다.
    const hadUser = this.events(tabId).some((e) => e.type === "user_message");
    this.record(s, userEvent);
    if (
      !hadUser &&
      userEvent.type === "user_message" &&
      userEvent.text.trim()
    ) {
      this.deps.onMeta?.(tabId, { title: userEvent.text });
    }

    const prompt = s.handoffPrefix
      ? `${s.handoffPrefix}\n\n---\n\n${text}`
      : text;
    this.setHandoffPrefix(s, null);
    s.queued = { text, prompt, images };

    if (!this.canStart(tabId)) {
      this.queue.push(tabId);
      this.setStatus(s, "queued");
      return { ok: true, queued: true };
    }
    this.start(s);
    return { ok: true, queued: false };
  }

  private start(s: Session) {
    const turn = s.queued;
    if (!turn) return;
    s.queued = null;
    const abort = new AbortController();
    s.abort = abort;
    s.ambientStopped = false;
    // 사용자가 새로 말을 걸었다. 이건 이어받은 턴이 아니다 — 지난 백그라운드 표시를 물려주지 않는다.
    s.ambientFromBg = false;
    s.bgTaskFinished = false;
    s.startedAt ??= Date.now();
    s.turnStartedAt = Date.now();
    // 턴 시작 시각을 렌더러가 바로 알게(진행 줄의 경과 시간 기준)
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
    this.setStatus(s, "running");

    // 한도 도달 감지: 오류 텍스트(turn_result/error) + rate_limit_event 의 거절 리셋 시각
    let limitText: string | null = null;
    let rejectedResetsAt: number | null = null;
    // 어댑터는 실패로 끝난 턴(turn_result.isError)도 정상 resolve 한다 — 여기서 기억해 두고 idle 대신 error 로 끝낸다.
    // 그래야 "앞 작업이 됐다" 는 전제로 큐의 다음 지시가 자동으로 나가지 않는다(사용자는 "지금 보내기" 로 이어갈 수 있다).
    let turnFailed = false;
    const emit = (e: ChatEvent) => {
      // Skill·Agent 카드가 열리면 companion Codex 의 rollout 을 찾기 시작하고, 그 카드가 끝나면 멈춘다
      if (s.provider === "claude" && e.type === "tool_use" && !e.partial && !e.preview && AGENT_TOOLS.has(e.name) && !s.companion) this.startCompanion(s, e.toolUseId);
      if (e.type === "tool_result" && s.companion?.parentToolUseId === e.toolUseId) this.stopCompanion(s);
      if (e.type === "turn_result" && e.isError) turnFailed = true;
      if (e.type === "turn_result" && e.isError && isUsageLimitText(e.errorText)) limitText = e.errorText ?? "usage limit";
      if (e.type === "error" && isUsageLimitText(e.message)) limitText = e.message;
      if (e.type === "status") s.status = e.status;
      if (e.type === "session" || (e.type === "turn_result" && e.sessionId)) {
        const next = e.sessionId ?? s.sessionId;
        if (next !== s.sessionId) {
          s.sessionId = next;
          this.deps.onMeta?.(s.tabId, { sessionId: next });
        }
      }
      this.record(s, e);
    };

    void (async () => {
      try {
        if (s.provider === "codex") {
          const runtime = await this.deps.codexRuntime(s.tabId);
          await runCodexTurn(runtime, {
            sessionKey: s.tabId,
            cwd: s.cwd!,
            prompt: turn.prompt,
            images: turn.images,
            sessionId: s.sessionId,
            policy: s.policy,
            currentPolicy: () => s.policy,
            model: s.model,
            abort,
            onEvent: emit,
            requestPermission: (req) => this.waitPermission(s, req, abort.signal),
            log: (line) => this.deps.log?.(s.tabId, line),
          });
        } else {
          const runtime = await this.deps.claudeRuntime(s.tabId);
          await runClaudeTurn(runtime, {
            sessionKey: s.tabId,
            cwd: s.cwd!,
            prompt: turn.prompt,
            images: turn.images,
            sessionId: s.sessionId,
            policy: s.policy,
            model: s.model,
            abort,
            onEvent: emit,
            requestPermission: (req) =>
              this.waitPermission(s, req, abort.signal),
            log: (line) => this.deps.log?.(s.tabId, line),
            onCommands: (patch) => this.deps.onSlashCommands?.(s.cwd!, patch),
            onBackgroundTasks: (sessionId, tasks, source) => this.deps.onBackgroundTasks?.(s.tabId, sessionId, tasks, source),
            onTaskFinished: (note) => {
              s.bgTaskFinished = true;
              this.deps.onTaskFinished?.(s.tabId, note);
            },
            onStreamEnded: (reason, expected) => this.deps.onStreamEnded?.(s.tabId, reason, expected),
            onAmbientEvent: (event) => this.ambientEvent(s.tabId, event),
            // 이 턴은 우리가 시작한 게 아니라 끊을 abort 가 없다 — 사용자가 답할 때까지 기다린다.
            requestAmbientPermission: (req) => this.waitPermission(s, req, new AbortController().signal),
            onRateLimit: (limit) => {
              if (limit.rejectedResetsAt) rejectedResetsAt = limit.rejectedResetsAt;
              this.deps.onRateLimit?.("claude", limit);
            },
          });
        }
        // 한도 오류는 finally 의 재시도 예약이 맡는다(그 경로는 idle 을 전제로 한다).
        this.setStatus(s, turnFailed && !limitText && !abort.signal.aborted ? "error" : "idle");
      } catch (e) {
        if (!abort.signal.aborted && isUsageLimitText(describeError(e))) limitText = describeError(e);
        if (abort.signal.aborted) {
          this.record(s, {
            type: "error",
            ts: Date.now(),
            ...appMsg("session.msg.interrupted"),
            fatal: false,
          });
          this.setStatus(s, "idle");
        } else {
          this.record(s, {
            type: "error",
            ts: Date.now(),
            ...(/ENOENT/.test(describeRaw(e))
              ? appMsg("session.msg.cliNotFound", { detail: describeRaw(e) })
              : e instanceof MsgError
                ? { message: e.message, msg: e.msg }
                : { message: describeError(e) }),
          });
          this.setStatus(s, "error");
        }
      } finally {
        s.abort = null;
        s.turnStartedAt = null;
        // 탭이 닫히며 release 된 뒤에 늦게 끝난 턴이면 세션이 이미 지워져 있다 —
        // snapshot() 은 ensure() 로 되살리므로, 아직 같은 세션일 때만 알린다.
        if (this.sessions.get(s.tabId) === s) this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
        this.stopCompanion(s);
        this.rejectAllPending(s);
        if (limitText && !abort.signal.aborted) {
          // 재시도를 예약한다. 큐는 재시도가 성공할 때까지 멈춰 둔다(연쇄로 같은 한도에 걸리며 유실되는 것을 막는다).
          if (s.limitAttempts > 0) s.limitWait = { until: null, attempts: s.limitAttempts, message: "", turn, timer: null };
          this.scheduleLimitRetry(s, turn, limitText, rejectedResetsAt);
        } else if (!abort.signal.aborted) {
          s.limitAttempts = 0;
        }
        this.drain();
        // 중단된 턴(사용자 중단·탭 닫기·앱 종료) 뒤에는 큐를 자동으로 보내지 않는다 — 닫는 중에 새 턴이 시작되면 안 된다.
        if (!s.limitWait && !abort.signal.aborted) this.drainPending(s);
      }
    })();
  }

  private startCompanion(s: Session, parentToolUseId: string) {
    const roots = this.deps.transcriptRoots;
    if (!roots || !s.cwd) return;
    const tabId = s.tabId;
    s.companion = new CompanionMirror({
      codexRoot: roots.codex,
      cwd: s.cwd,
      since: Date.now(),
      parentToolUseId,
      // 앱 자신의 Codex 탭 세션은 companion 이 아니다
      excludeSessionIds: () => new Set([...this.sessions.values()].filter((x) => x.provider === "codex" && x.sessionId).map((x) => x.sessionId!)),
      onEvents: (events) => {
        const cur = this.sessions.get(tabId);
        if (!cur || cur.companion?.parentToolUseId !== parentToolUseId) return;
        for (const e of events) this.record(cur, e);
      },
    });
    s.companion.start();
    this.deps.log?.(tabId, `[companion] ${parentToolUseId} 카드 동안 Codex rollout 감시 시작 (cwd ${s.cwd})`);
  }

  private stopCompanion(s: Session) {
    if (!s.companion) return;
    const file = s.companion.file();
    s.companion.stop();
    s.companion = null;
    if (file) this.deps.log?.(s.tabId, `[companion] 감시 종료 (${file})`);
  }

  /** 상한과 무관하게 시작해도 되는지: 예외 탭(코디네이터)이거나 자리가 있으면. */
  private canStart(tabId: string): boolean {
    return this.exemptTabs.has(tabId) || this.runningCount() < this.maxConcurrent;
  }

  private drain() {
    // 예외 탭은 큐 어디에 있든 먼저 꺼내고, 나머지는 자리가 나는 만큼 순서대로
    for (const tabId of [...this.queue]) {
      if (!this.exemptTabs.has(tabId)) continue;
      this.queue.splice(this.queue.indexOf(tabId), 1);
      const s = this.sessions.get(tabId);
      if (s && s.status === "queued" && s.queued) this.start(s);
    }
    while (this.queue.length > 0 && this.runningCount() < this.maxConcurrent) {
      const tabId = this.queue.shift()!;
      const s = this.sessions.get(tabId);
      if (!s || s.status !== "queued" || !s.queued) continue;
      this.start(s);
    }
  }

  /**
   * 사용자의 중단은 "멈춰" 라는 뜻: 실행 여부와 무관하게 한도 재시도 예약과 써 둔 다음 지시를 버린다.
   * keepQueue 는 앱 종료·탭 닫기 같은 정리 경로용 — 대기 지시를 디스크에 남겨 다음 실행에서 복원한다.
   */
  abort(tabId: string, opts: { keepQueue?: boolean } = {}): boolean {
    const s = this.sessions.get(tabId);
    if (!s) return false;
    let did = false;
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
      did = true;
    }
    if (s.promptQueue.length > 0 && !opts.keepQueue) {
      s.promptQueue = [];
      this.persistQueue(s);
      did = true;
    }
    if (did) this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    if (s.status === "queued") {
      const i = this.queue.indexOf(tabId);
      if (i !== -1) this.queue.splice(i, 1);
      s.queued = null;
      this.record(s, {
        type: "error",
        ts: Date.now(),
        ...appMsg("session.msg.queueCancelled"),
        fatal: false,
      });
      this.setStatus(s, "idle");
      return true;
    }
    if (!s.abort) {
      // 우리가 시작하지 않은 턴(백그라운드가 끝나 CLI 가 스스로 이어간 턴)에는 끊을 abort 가 없다.
      // 여기서 그냥 돌아가면 화면은 "도는 중" 인데 중단만 아무 일도 하지 않는다 — 어댑터로 직접 끊는다.
      if (this.isBusy(tabId)) {
        // 살아 있으면 끊는다. 프로세스가 이미 없으면(유령 상태) 끊을 것이 없을 뿐,
        // 화면에 남은 "도는 중" 은 똑같이 정리해 줘야 한다 — 안 그러면 영영 못 멈춘다.
        if (s.provider === "claude") interruptClaudeSession(tabId);
        this.rejectAllPending(s);
        s.ambientStopped = true;
        s.turnStartedAt = null;
        this.record(s, { type: "error", ts: Date.now(), ...appMsg("session.msg.interrupted"), fatal: false });
        this.setStatus(s, "idle");
        this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
        return true;
      }
      return did;
    }
    this.rejectAllPending(s);
    s.abort.abort();
    return true;
  }

  /**
   * 권한 변경을 지금 반영한다. 다음 턴까지 기다리면 "계속 물어봐서 바꿨는데 그 턴 내내 계속 묻는" 일이 생긴다.
   * 느슨해지는 방향만 즉시 먹는다 — 조이는 쪽은 프로세스가 우리에게 묻지 않으므로 다음 턴부터다.
   */
  private applyPolicyNow(tabId: string, s: Session, policy: PermissionPolicy): void {
    if (s.provider === "claude") {
      void applyClaudePolicy(tabId, policy)
        .then((r) => {
          if (r !== "none") this.deps.log?.(tabId, `[claude] 권한 ${policy} — ${r === "applied" ? "이번 턴부터" : "다음 턴부터"}`);
        })
        .catch(() => {});
    } else {
      const r = applyCodexPolicy(tabId, policy);
      if (r !== "none") this.deps.log?.(tabId, `[codex] 권한 ${policy} — ${r === "applied" ? "이번 턴부터(샌드박스는 다음 턴부터)" : "다음 턴부터"}`);
    }
    if (policy !== "full") return;
    // 이미 떠 있는 승인 창은 게이트가 지나쳐 버린 요청이라 따로 풀어 준다.
    for (const requestId of [...s.pending.keys()]) {
      // 질문은 권한이 아니다 — 사람이 답해야 한다(빈 답은 거부와 같다).
      if (s.pendingReqs.get(requestId)?.tool === "AskUserQuestion") continue;
      this.answerPermission(tabId, requestId, { behavior: "allow" });
    }
  }

  /**
   * 우리가 시작하지 않은 턴의 이벤트(백그라운드 작업이 끝나 CLI 가 스스로 이어갈 때).
   * 기록·전달은 평소와 같고, 화면이 "도는 중" 으로 보이도록 상태만 우리가 올려 준다.
   */
  private ambientEvent(tabId: string, e: ChatEvent): void {
    const s = this.sessions.get(tabId);
    if (!s) return;
    if (e.type === "turn_result") {
      this.record(s, e);
      s.turnStartedAt = null;
      // 사용자가 끊은 턴은 오류로 끝난 것처럼 오지만(interrupt), 그건 사고가 아니라 시킨 대로 된 것이다.
      // 우리가 시작한 턴에서도 중단은 idle 로 끝낸다 — 같게 맞춘다.
      const stopped = s.ambientStopped;
      s.ambientStopped = false;
      s.ambientFromBg = false;
      s.bgTaskFinished = false;
      this.setStatus(s, e.isError && !stopped ? "error" : "idle");
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
      return;
    }
    if (e.type === "status") {
      s.status = e.status;
      this.record(s, e);
      return;
    }
    // 사용자가 끊은 턴이 남긴 이벤트다. 기록은 하되 "도는 중" 으로 되돌리지는 않는다.
    if (!s.ambientStopped && (s.status === "idle" || s.status === "error")) {
      s.turnStartedAt = Date.now();
      // 이 턴이 왜 시작됐는지는 여기서만 안다. 백그라운드가 끝났다는 알림을 받은 뒤라면 그 결과를
      // 처리하는 중이다. 알림이 없었으면 이유를 모르므로 평소 표시를 그대로 둔다 — 짐작해서 적지 않는다.
      s.ambientFromBg = s.bgTaskFinished;
      this.setStatus(s, "running");
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    this.record(s, e);
  }

  answerPermission(
    tabId: string,
    requestId: string,
    answer: PermissionAnswer,
  ): boolean {
    const s = this.sessions.get(tabId);
    const resolve = s?.pending.get(requestId);
    if (!s || !resolve) return false;
    s.pending.delete(requestId);
    s.pendingReqs.delete(requestId);
    resolve(answer);
    return true;
  }

  /** 이 provider 세션 id 를 쓰는 탭. 백그라운드 작업 기록처럼 tabId 를 모르는 쪽이 탭을 찾을 때. */
  tabForSessionId(sessionId: string): string | null {
    if (!sessionId) return null;
    for (const [tabId, s] of this.sessions) if (s.sessionId === sessionId) return tabId;
    return null;
  }

  /** 답을 기다리는 권한 요청들. */
  pendingPermissions(tabId: string): PermissionRequestEvent[] {
    return [...(this.sessions.get(tabId)?.pendingReqs.values() ?? [])];
  }

  /** 대화를 비운다. 실행 중이면 중단. provider 세션도 새로 시작한다. */
  /**
   * 탭 기록은 그대로 두고 provider 세션만 새로 시작한다. 예약이 제 탭에 회차를 쌓을 때 쓴다 —
   * 같은 세션을 계속 이어 가면 회차마다 맥락이 누적돼 비용이 매일 오르고 결국 한도에 부딪힌다.
   * 지난 회차는 탭을 스크롤하면 그대로 있으므로 비교에는 지장이 없다.
   *
   * clear() 와 다르다. clear 는 기록까지 지운다 — 그러면 지난 회차를 볼 수 없다.
   * provider 를 바꿀 때 하는 것과 같은 일이다(세션만 새로, 기록은 유지).
   */
  resetSession(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.sessionId === null) return;
    closeProviderSessions(tabId);
    s.sessionId = null;
    this.deps.onMeta?.(tabId, { sessionId: null });
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  clear(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    this.externalCliExited(tabId);
    if (s.controller === "terminal") this.detachTerminal(tabId);
    if (this.isBusy(tabId)) this.abort(tabId);
    closeProviderSessions(tabId);
    s.events = [];
    s.dedupe = buildDedupeIndex([]);
    s.sessionId = null;
    this.setHandoffPrefix(s, null);
    s.startedAt = null;
    s.promptQueue = [];
    this.persistQueue(s);
    this.clearLimitTimer(s);
    s.limitWait = null;
    s.limitAttempts = 0;
    this.deps.store?.resetThread(tabId);
    this.deps.onMeta?.(tabId, { sessionId: null, title: "" });
    return this.snapshot(tabId);
  }

  /** 탭을 닫을 때: 중단하고 메모리에서 내린다. 디스크의 스레드는 남는다(다시 열기). */
  /** 탭 닫기·삭제: 턴을 멈추고 세션을 내린다. 대기 지시는 디스크에 남긴다(삭제면 스레드와 함께 지워진다). */
  release(tabId: string): void {
    this.externalCliExited(tabId);
    this.abort(tabId, { keepQueue: true });
    closeProviderSessions(tabId);
    const s = this.sessions.get(tabId);
    if (s) {
      s.mirror?.stop();
      this.stopCompanion(s);
      this.stopHookWatcher(s);
      this.clearLimitTimer(s);
      s.limitWait = null;
    }
    this.sessions.delete(tabId);
  }

  abortAll(opts: { keepQueue?: boolean } = {}): void {
    for (const tabId of this.sessions.keys()) this.abort(tabId, opts);
  }

  /** 앱 종료: 턴 중단 + 미러·훅 워처 정리(훅 로그 삭제). */
  shutdown(): void {
    this.abortAll({ keepQueue: true });
    closeAllClaudeSessions();
    closeAllCodexSessions();
    for (const s of this.sessions.values()) {
      s.mirror?.stop();
      s.mirror = null;
      this.stopCompanion(s);
      this.stopHookWatcher(s);
      this.clearLimitTimer(s);
      s.limitWait = null;
    }
  }

  /**
   * 기록을 처음 읽을 때: 지난 실행에서 "진행 중" 으로 남은 카드(verify·fanout·review)는 이 프로세스에 없으므로 닫아 준다.
   *
   * 이미 쌓인 중복도 여기서 걸러 낸다. 예전에 세션을 갈아탔다고 보고 기록을 통째로 다시 불러온 탭이 있어서,
   * 파일에는 같은 말이 두세 벌씩 남아 있다. 파일을 고쳐 쓰지는 않는다 — 대화 기록을 덮어쓰는 위험을
   * 감수할 만큼 아끼는 용량이 아니고, 걸러서 읽으면 화면은 바로 제대로 나온다.
   */
  /** 이 탭이 이미 가진 것들의 색인. 기록을 통째로 불러올 때 대조한다. */
  private dedupeIndex(s: Session): DedupeIndex {
    this.loadEvents(s);
    return (s.dedupe ??= buildDedupeIndex(s.events ?? []));
  }

  private loadEvents(s: Session): ChatEvent[] {
    if (s.events) return s.events;
    const events = this.deps.store?.readEvents(s.tabId) ?? [];
    for (const e of staleRunEvents(mt, events)) {
      events.push(e);
      this.deps.store?.appendEvent(s.tabId, e);
    }
    s.events = events;
    s.dedupe = buildDedupeIndex(events);
    return events;
  }

  private record(s: Session, e: ChatEvent) {
    // 생각 조각은 화면에만 흘리고 기록·메모리엔 남기지 않는다(양이 크고 다시 볼 일이 없다).
    if (e.type === "thinking_delta" || e.type === "subagent_activity" || (e.type === "tool_use" && e.preview) || (e.type === "verify" && e.partial)) {
      this.deps.emit(s.tabId, e);
      return;
    }
    this.loadEvents(s).push(e);
    // 여기서 거르지는 않는다(길목에서 버리면 정당한 재전송까지 막힌다). 색인만 따라가게 해서,
    // 나중에 기록을 통째로 불러올 때 "이미 가진 것" 에 실시간으로 받은 것도 포함되게 한다.
    indexEvent(this.dedupeIndex(s), e);
    this.deps.store?.appendEvent(s.tabId, e);
    this.deps.emit(s.tabId, e);
  }

  private waitPermission(
    s: Session,
    req: PermissionRequestEvent,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      const done = (answer: PermissionAnswer) => {
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = () => {
        s.pending.delete(req.requestId);
        s.pendingReqs.delete(req.requestId);
        done({ behavior: "deny" });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      s.pending.set(req.requestId, done);
      s.pendingReqs.set(req.requestId, req);
    });
  }

  private rejectAllPending(s: Session) {
    for (const [id, resolve] of s.pending) {
      s.pending.delete(id);
      resolve({ behavior: "deny" });
    }
  }

  private setStatus(s: Session, status: SessionStatus) {
    s.status = status;
    this.record(s, { type: "status", ts: Date.now(), status });
    this.deps.onStatus?.(s.tabId, status);
    // 진행 중 수·승인 대기 수·대기 순번이 바뀌었을 수 있다 — 기다리는 탭들에 알린다.
    if (this.queue.length > 0) this.broadcastQueued();
  }
}

/** 권한 힌트용 한 줄 요약. 렌더러의 툴카드 요약과 같은 규칙을 최소로 따른다. */
export function summarizeToolInput(
  tool: string,
  input: Record<string, unknown>,
): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const firstLine = (v: string) => v.split("\n")[0].trim();
  if (tool === "Bash") return firstLine(str(input.description) || str(input.command));
  if (tool === "AskUserQuestion") {
    const qs = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : [];
    return qs.map((q) => str(q?.question)).filter(Boolean).join(" · ").slice(0, 160);
  }
  const p = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (p) return p;
  if (str(input.url)) return str(input.url);
  if (str(input.pattern)) return str(input.pattern);
  const keys = Object.keys(input);
  return keys.length ? firstLine(JSON.stringify(input)).slice(0, 120) : "";
}

function describeRaw(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeError(e: unknown): string {
  const msg = describeRaw(e);
  if (/ENOENT/.test(msg)) return mt("session.error.cliNotFound", { detail: msg });
  return msg;
}
