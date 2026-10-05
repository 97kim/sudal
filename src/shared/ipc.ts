// renderer ↔ main 계약. 양쪽 모두 이 파일만 import 한다 (node/electron 의존성 없음).

import type {
  ChatEvent,
  PermissionAnswer,
  PermissionPolicy,
  SessionStatus,
} from "./chat-events";
import type { BackgroundJobDto } from "./background-jobs";
import type { Run, Schedule } from "./schedules";
import type { NetFailure } from "./browser-diagnostics";
import type { Handoff } from "./handoff";
import type { OrchRunState } from "./orchestration";
import type { LspServerId } from "./lsp-servers";
import type { SlashCommandDto } from "./slash-commands";
import type { SnippetDto } from "./snippets";
import type { SearchHit } from "./transcript-search";
import type { WorkbenchModel } from "./workspace-model";
import type { PricingEntry, UsageFilter, UsageSummary } from "./usage";

export type Provider = "claude" | "codex";
export const PROVIDERS: Provider[] = ["claude", "codex"];

/** 모델 피커의 한 줄. id 는 CLI 에 넘기는 값(별칭 또는 전체 이름). */
export interface ModelOptionDto {
  id: string;
  label: string;
  description?: string;
  /** 별칭이 가리키는 실제 모델 id(Claude). */
  resolved?: string;
  /** CLI 가 기본으로 고른 모델(Codex). */
  isDefault?: boolean;
}

export interface CliStatusDto {
  installed: boolean;
  path: string | null;
  source?: "auto" | "override";
  error?: string;
  /** --version 첫 줄. 설치된 경우에만. */
  version?: string;
  /** CLI 설정 파일의 기본 모델(~/.claude/settings.json model, ~/.codex/config.toml model). 없으면 undefined. */
  defaultModel?: string;
}

export interface CliCandidateDto {
  path: string;
  verified: boolean;
  versionOutput?: string;
}

export interface OverrideSetResultDto {
  ok: boolean;
  reason?:
    | "not_found"
    | "permission_denied"
    | "disk_full"
    | "readonly_fs"
    | "unknown";
  message?: string;
}

export interface AppInfoDto {
  version: string;
  platform: string;
  userDataPath: string;
  /** OS 로그인 사용자명 (os.userInfo). 사이드바 하단 표시용. */
  userName: string;
  /** main 콘솔이 기록되는 로그 파일 경로 (userData/logs/main.log). */
  logPath: string;
}

/** 업데이트 확인 결과. brew 가 false 면 앱 안에서 올릴 수 없으니 릴리즈 페이지를 안내한다. */
export interface UpdateCheckDto {
  current: string;
  latest: string;
  available: boolean;
  releaseUrl: string;
  /** 이 앱이 Homebrew cask 로 설치됐는지(개발 실행이면 false). */
  brew: boolean;
}

export type UpdateRunResult = { ok: true; version: string } | { ok: false; error: string };

/** 업데이트가 지금 하는 일. downloading 만 진행률을 낼 수 있다. */
export type UpdatePhase = "checking" | "downloading" | "installing";

/** main 이 들고 있는 업데이트 상태. running 은 올리는 중인 목표 버전, installed 는 이번 실행에서 brew 로 설치를 마친 버전. */
export interface UpdateStatusDto {
  running: string | null;
  installed: string | null;
  /** running 일 때의 단계와, 내려받는 중이면 진행률(0~100, 크기를 모르면 없음). */
  phase?: UpdatePhase;
  percent?: number;
  /** 마지막으로 확인한 결과. 앱이 스스로 확인한 것도 포함한다(시작 직후와 몇 시간마다). 아직 확인 전이면 null. */
  check: UpdateCheckDto | null;
  /** 마지막 업데이트 시도가 실패했으면 그 내용. 다시 시도하거나 확인하면 지운다. */
  error?: string;
}

/** 예열 대상: 보고 있는 탭(활성화·설정 변경·시작 때 프로세스를 미리 띄움) 또는 끔. */
export type WarmTarget = "active" | "off";

/** 앱 동작 설정(userData/settings.json). 링크 열기 방식은 renderer 의 localStorage 에 있어 여기 없다. */
import type { ThemeMode } from "./theme";
import type { LanguageSetting, Locale } from "./i18n/locale";

export interface AppSettingsDto {
  /** 화면 테마. system 이면 macOS 화면 모드를 따른다. */
  theme: ThemeMode;
  /** 표시 언어 설정. system 이면 macOS 의 선호 언어를 따른다. */
  language: LanguageSetting;
  /** language 를 해석한 실제 표시 언어(읽기 전용 — main 이 정한다). */
  resolvedLocale: Locale;
  warmTarget: WarmTarget;
  /** 턴 없이 이만큼(분) 지나면 provider 프로세스를 내린다. */
  sessionIdleMinutes: number;
  /** 동시에 진행할 턴 수(승인 대기 포함). 넘치면 큐에서 기다린다. */
  maxConcurrent: number;
  /** 응답이 끝났을 때 macOS 알림: always = 항상, unfocused = 창이 포커스 밖이거나 다른 탭을 볼 때, off = 안 함. */
  notifyOnDone: NotifyOnDone;
  /**
   * 인앱 브라우저의 로그인을 앱을 껐다 켜도 유지한다. 로그인 세션은 대개 만료 없는 세션 쿠키라
   * Chromium 이 종료할 때 버린다 — 끌 때 받아 적고 켤 때 되돌려 놓는다(크롬의 "이전 세션 계속하기").
   * 로그인 증표를 앱 데이터 디렉토리에 두는 일이므로 끌 수 있고, 끄면 적어 둔 것을 지운다.
   */
  keepBrowserLogin: boolean;
  /**
   * 격리 세션·팬아웃 등이 git worktree를 만드는 폴더. 기본 ~/sudal/worktrees.
   * 바꾸면 앞으로 만드는 것부터 — 이미 만든 worktree 는 옮기지 않는다(git 연결이 깨진다).
   * 경로는 설정 저장으로 바꾸지 않고 app:pick-worktree-dir(선택 창)로만 고른다. 저장으로는 worktreeDirCustom:false(기본값으로)만.
   */
  worktreeDir: string;
  worktreeDirCustom: boolean;
  /** 앱 데이터(워크스페이스·채팅 기록·설정) 폴더. 읽기 전용 표시용. */
  dataDir: string;
}

export type NotifyOnDone = "always" | "unfocused" | "off";
export const NOTIFY_ON_DONE_DEFAULT: NotifyOnDone = "always";
export function isNotifyOnDone(v: unknown): v is NotifyOnDone {
  return v === "always" || v === "unfocused" || v === "off";
}
/** 응답 완료 알림을 띄울지 — 순수 판정(테스트용). */
export function shouldNotifyDone(mode: NotifyOnDone, focused: boolean, isActiveTab: boolean): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return !focused || !isActiveTab;
}

export const SESSION_IDLE_MINUTES_DEFAULT = 10;
export const SESSION_IDLE_MINUTES_MIN = 1;
export const SESSION_IDLE_MINUTES_MAX = 120;
export const MAX_CONCURRENT_DEFAULT = 4;
export const MAX_CONCURRENT_MIN = 1;
/** UI 상한. 검증된 안전선이 아니라 입력 범위다. */
export const MAX_CONCURRENT_MAX = 8;

/** renderer 의 처리되지 않은 오류. main 이 로그 파일에 남긴다. */
export interface RendererErrorDto {
  kind: "error" | "unhandledrejection";
  message: string;
  stack?: string;
  source?: string;
}

/** 압축 결과. native 면 provider 가 세션 안에서 압축했고(세션 유지), 아니면 요약 후 새 세션이다. */
export type CompactResult =
  | { ok: true; native: boolean; config?: SessionSnapshotDto }
  | { ok: false; error: string };

export const IPC = {
  appInfo: "app:info",
  appModels: "app:models",
  appOpenLogs: "app:open-logs",
  appOpenPath: "app:open-path",
  appPickWorktreeDir: "app:pick-worktree-dir",
  appSettingsGet: "app:settings-get",
  appSettingsSet: "app:settings-set",
  appSettingsChanged: "app:settings-changed",
  appUpdateChanged: "app:update-changed",
  appUpdateCheck: "app:update-check",
  appUpdateRun: "app:update-run",
  appUpdateStatus: "app:update-status",
  appRelaunch: "app:relaunch",
  stateLoad: "state:load",
  stateSet: "state:set",
  rendererError: "app:renderer-error",
  cliStatus: "cli:status",
  cliCandidates: "cli:candidates",
  cliSetOverride: "cli:set-override",
  cliRefresh: "cli:refresh",
  chatSend: "chat:send",
  chatAbort: "chat:abort",
  chatPermission: "chat:permission",
  chatConfigure: "chat:configure",
  chatSnapshot: "chat:snapshot",
  chatEvents: "chat:events",
  chatClear: "chat:clear",
  chatCompact: "chat:compact",
  browserRegister: "browser:register",
  browserFavicon: "browser:favicon",
  chatHandoffPreview: "chat:handoff-preview",
  chatSwitchProvider: "chat:switch-provider",
  chatEvent: "chat:event",
  chatCommands: "chat:commands",
  chatCommandsChanged: "chat:commands-changed",
  chatSearch: "chat:search",
  chatQueueRemove: "chat:queue-remove",
  chatLimitRetry: "chat:limit-retry",
  chatLimitCancel: "chat:limit-cancel",
  chatQueueUpdate: "chat:queue-update",
  chatQueueSendNext: "chat:queue-send-next",
  chatQueueSteer: "chat:queue-steer",
  chatFork: "chat:fork",
  chatExport: "chat:export",
  chatAttachTerminal: "chat:attach-terminal",
  chatDetachTerminal: "chat:detach-terminal",
  chatSnapshotChanged: "chat:snapshot-changed",
  mcpStatus: "mcp:status",
  pickDirectory: "dialog:pick-directory",
  openExternal: "browser:open-external",
  browserNetFailures: "browser:net-failures",
  backgroundJobs: "jobs:list",
  backgroundJobsChanged: "jobs:changed",
  gitInfo: "git:info",
  gitChanges: "git:changes",
  gitCommit: "git:commit",
  gitRevert: "git:revert",
  snippetsList: "snippets:list",
  snippetsSave: "snippets:save",
  snippetsRemove: "snippets:remove",
  snippetsChanged: "snippets:changed",
  gitDraftMessage: "git:draft-message",
  fileRead: "file:read",
  fileWrite: "file:write",
  fileCreate: "file:create",
  lspStatus: "lsp:status",
  lspSetPath: "lsp:set-path",
  lspStart: "lsp:start",
  lspSend: "lsp:send",
  lspMessage: "lsp:message",
  lspExit: "lsp:exit",
  fileRename: "file:rename",
  fileDelete: "file:delete",
  fileList: "file:list",
  fileLocate: "file:locate",
  previewUrl: "preview:url",
  controlOpen: "control:open",
  controlInstallCli: "control:install-cli",
  controlInstallSkill: "control:install-skill",
  controlInstallStatus: "control:install-status",
  chatCrossReview: "chat:cross-review",
  chatVerify: "chat:verify",
  chatVerifyAbort: "chat:verify-abort",
  chatVerifySuggest: "chat:verify-suggest",
  chatFanout: "chat:fanout",
  chatFanoutCompare: "chat:fanout-compare",
  chatFanoutAdopt: "chat:fanout-adopt",
  chatFanoutCleanup: "chat:fanout-cleanup",
  orchList: "orch:list",
  orchReply: "orch:reply",
  orchFollowup: "orch:followup",
  orchTakeover: "orch:takeover",
  orchWorker: "orch:worker",
  orchClose: "orch:close",
  orchGate: "orch:gate",
  orchChanged: "orch:changed",
  cliDiagnostics: "cli:diagnostics",
  wsState: "ws:state",
  wsAdd: "ws:add",
  wsCreate: "ws:create",
  wsUpdate: "ws:update",
  wsRemove: "ws:remove",
  wsChanged: "ws:changed",
  tabCreate: "tab:create",
  tabClose: "tab:close",
  tabReopen: "tab:reopen",
  tabDelete: "tab:delete",
  wtCreate: "worktree:create",
  wtStatus: "worktree:status",
  wtMerge: "worktree:merge",
  wtRemove: "worktree:remove",
  wtListManaged: "worktree:list-managed",
  wtRemoveManaged: "worktree:remove-managed",
  tabActivate: "tab:activate",
  tabSetVisible: "tab:set-visible",
  tabRename: "tab:rename",
  tabReorder: "tab:reorder",
  workspaceReorder: "workspace:reorder",
  schedulesList: "schedules:list",
  schedulesSave: "schedules:save",
  schedulesRemove: "schedules:remove",
  schedulesRunNow: "schedules:run-now",
  schedulesChanged: "schedules:changed",
  shortcut: "app:shortcut",
  usageQuery: "usage:query",
  usageStatus: "usage:status",
  usageRescan: "usage:rescan",
  usageExport: "usage:export",
  usageSettingsGet: "usage:settings-get",
  usageSettingsSet: "usage:settings-set",
  usageChanged: "usage:changed",
  usageRefreshLimits: "usage:refresh-limits",
  termOpen: "term:open",
  termWrite: "term:write",
  termResize: "term:resize",
  termClose: "term:close",
  termClear: "term:clear",
  termData: "term:data",
  termExit: "term:exit",
  termList: "term:list",
  termOpened: "term:opened",
} as const;

/** 채팅 탭에 붙는 통합 터미널 (main 의 node-pty). 패널을 닫아도 셸은 유지, 탭을 닫으면 종료. */
export interface TerminalOpenResultDto {
  ok: boolean;
  existing: boolean;
  shell: string;
  pid?: number;
  error?: string;
  /** 이미 떠 있던 터미널에 다시 붙을 때 최근 출력. */
  backlog?: string;
}

/**
 * ⌘K: main 이 백로그를 비운 그 지점에 출력 스트림으로 끼워 보내는 표시. renderer 는 이걸 받으면 앞선 출력을 다 그린 뒤
 * 화면을 지운다 — 별도 채널로 지우면 어느 출력까지가 "지우기 전" 인지 main 과 renderer 가 다르게 본다.
 * APC 시퀀스라 혹시 그대로 xterm 에 써도 아무것도 그리지 않는다.
 */
export const TERMINAL_CLEAR_MARK = "\u001b_sudal:clear\u001b\\";

/** 터미널 id 는 "<채팅탭 id>:<이름>". kind=command 는 하이브리드 모드의 CLI. */
export interface TerminalInfoDto {
  id: string;
  kind: "shell" | "command";
  title: string;
}

export interface TerminalApi {
  /** termId 로 셸을 연다. 이미 있으면 그 pty 에 붙는다(backlog 포함). */
  open(
    termId: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<TerminalOpenResultDto>;
  write(termId: string, data: string): void;
  resize(termId: string, cols: number, rows: number): void;
  close(termId: string): Promise<void>;
  /**
   * ⌘K: main 이 들고 있는 출력 백로그를 비우고(안 비우면 채팅 탭을 오갈 때 지운 화면이 되살아난다)
   * 그 자리에 TERMINAL_CLEAR_MARK 를 onData 로 보낸다. 화면은 그 표시를 받았을 때 지운다.
   */
  clear(termId: string): void;
  /** 이 채팅 탭에 붙어 있는 터미널 목록 ("<tabId>:" 접두어). */
  list(tabId: string): Promise<TerminalInfoDto[]>;
  onData(listener: (termId: string, data: string) => void): () => void;
  /** 같은 id 의 가장 최근 프로세스가 끝났을 때만 온다(옛 프로세스의 늦은 exit 는 main 이 거른다). */
  onExit(listener: (termId: string, exitCode: number) => void): () => void;
  /** main 이 새 pty 를 만들었을 때 (하이브리드 CLI 등). */
  onOpened(listener: (info: TerminalInfoDto) => void): () => void;
}

/** 구독 한도 창 하나 (5시간 세션 창 / 주간 창). */
export interface RateLimitWindowDto {
  usedPercent: number;
  windowMinutes: number;
  /** epoch 초 */
  resetsAt: number;
}

/** provider 별 구독 한도. Claude 는 턴 중 rate_limit_event, Codex 는 트랜스크립트의 rate_limits 에서 온다. */
export interface ProviderRateLimitDto {
  session: RateLimitWindowDto | null;
  weekly: RateLimitWindowDto | null;
  /** 특정 모델에만 적용되는 주간 창 (Claude 의 "Current week (Fable)" 등). label 은 모델 표시명. */
  modelWeekly: (RateLimitWindowDto & { label: string }) | null;
  /** 관측 시각(ms). 턴이 돌아야 갱신되므로 화면에 같이 표시한다. */
  observedAt: number;
  /** rate_limit_event 가 status "rejected" 였으면 그 리셋 시각(epoch 초). 자동 재시도 예약에 쓴다. */
  rejectedResetsAt?: number;
}

/** 동시 실행 상한에 걸려 기다리는 턴의 상태(status=queued). */
export interface QueueInfoDto {
  /** 대기 순번(1 이 다음 차례). */
  position: number;
  /** 지금 진행 중인 턴 수(승인 대기 포함). */
  running: number;
  max: number;
  /** 진행 중 가운데 권한 승인을 기다리는 턴 수 — 사용자가 답하면 자리가 난다. */
  waitingPermission: number;
}

/** 한도 도달로 멈춘 턴의 자동 재시도 상태. */
export interface LimitWaitDto {
  /** 재시도 예정 시각(ms). 리셋 시각을 모르면 null (수동 재시도만). */
  until: number | null;
  attempts: number;
  /** 한도 오류 원문 (배너에 표시). */
  message: string;
}

export interface UsageStatusDto {
  scanning: boolean;
  files: number;
  records: number;
  lastScanAt: number | null;
  lastScanMs: number;
  rateLimits: {
    claude: ProviderRateLimitDto | null;
    codex: ProviderRateLimitDto | null;
  };
  roots: { claude: string; codex: string };
  /** userData/pricing.json 이 있으면 true (기본 가격표 대체). */
  customPricing: boolean;
  pricing: PricingEntry[];
}

export interface UsageSettingsDto {
  /** 월 예산(USD, 추정 비용 기준). null 이면 알림 없음. */
  monthlyBudgetUsd: number | null;
}

export interface UsageApi {
  query(filter: UsageFilter): Promise<UsageSummary>;
  status(): Promise<UsageStatusDto>;
  rescan(): Promise<UsageStatusDto>;
  /** 구독 한도 새로고침: Claude 는 /usage 로컬 커맨드(비용 0), Codex 는 트랜스크립트 재스캔. */
  refreshLimits(): Promise<UsageStatusDto>;
  /** 저장 다이얼로그를 띄워 CSV 로 내보낸다. 취소하면 null. */
  exportCsv(filter: UsageFilter): Promise<string | null>;
  getSettings(): Promise<UsageSettingsDto>;
  setSettings(patch: Partial<UsageSettingsDto>): Promise<UsageSettingsDto>;
  onChanged(listener: () => void): () => void;
}

/** 사용자 응답이 필요한 세션: 권한 대기 / 안 보는 사이 끝난 턴(완료·오류). */
export type SessionAttention = "permission" | "done" | "error";

export type VerifyStartResult = { ok: true; runId: string } | { ok: false; error: string };
export type OrchResult = { ok: true } | { ok: false; error: string };

/** 팬아웃 시작 요청: 지시 하나를 격리 세션(worktree) 여러 개에 동시에 보낸다. */
export interface FanoutStartDto {
  prompt: string;
  variants: { provider: Provider; model?: string }[];
  policy?: PermissionPolicy;
}
export type FanoutStartResult = { ok: true; fanoutId: string; tabIds: string[] } | { ok: false; error: string };
/** 비교 화면 데이터: 변형마다 worktree 의 변경 목록과 파일별 diff. */
export interface FanoutCompareDto {
  fanoutId: string;
  variants: {
    tabId: string;
    label: string;
    provider: Provider;
    status: string;
    summary?: string;
    /** worktree 가 없으면(정리됨) false. */
    exists: boolean;
    changes: GitChangeDto[];
    diffs: Record<string, string>;
  }[];
}
export type FanoutAdoptResult = { ok: true; files: string[] } | { ok: false; error: string };

export interface WorkspaceStateDto {
  model: WorkbenchModel;
  statuses: Record<string, SessionStatus>;
  attention: Record<string, SessionAttention>;
}

export type ShortcutName =
  | "new-tab"
  | "close-tab"
  | "switch-workspace"
  | "toggle-terminal"
  | "toggle-sidebar"
  | "toggle-editor-maximize"
  | "browser-address"
  | "browser-reload"
  | "browser-hard-reload"
  | "reopen-tab"
  | "search"
  | "next-attention"
  | "prev-attention"
  | "next-tab"
  | "prev-tab"
  | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export interface GitInfoDto {
  root: string;
  name: string;
  branch: string | null;
  /** 조회한 cwd 가 레포 안에서 차지하는 상대 경로("" 이면 루트). 변경 목록의 루트 기준 경로를 cwd 기준으로 바꿀 때 쓴다. */
  prefix: string;
}

export interface GitChangeDto {
  path: string;
  /** kind === "renamed" 일 때 이전 경로. 커밋 pathspec 에 함께 넣어야 삭제까지 커밋된다. */
  oldPath?: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  added: number;
  deleted: number;
}

/** 전체 세션 검색 결과 — 세션 단위로 묶고 일치 블록을 나열한다. */
export interface SearchResultDto {
  tabId: string;
  title: string;
  workspaceName: string;
  provider: Provider;
  open: boolean;
  updatedAt: number;
  hits: SearchHit[];
}

export type GitCommitResult =
  | { ok: true; hash: string; subject: string; files: number }
  | { ok: false; error: string };

export type GitDraftResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** 파일 탐색기의 디렉토리 항목. .git 은 제외한다. */
export interface DirEntryDto {
  name: string;
  /** 절대 경로 */
  path: string;
  kind: "dir" | "file";
  size: number;
}

/** 코드 뷰어용 파일 한 개. 변경 파일 목록이나 툴카드의 경로를 눌렀을 때 읽는다. */
export type FileOpResultDto = { ok: true; path: string } | { ok: false; error: string };

export interface LspStatusDto {
  serverId: LspServerId;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  typescriptLib: string | null;
  override: string | null;
  running: string[];
  hint: string;
}

/** 언어 서버(shared/lsp-servers 의 명세: TypeScript, Python …). 렌더러의 CodeMirror LSP 클라이언트가 JSON-RPC 본문을 그대로 주고받는다. */
export interface LspApi {
  /** 서버 종류마다 한 항목. */
  status(): Promise<LspStatusDto[]>;
  setPath(serverId: LspServerId, path: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 탭 cwd 를 주면 main 이 저장소 루트를 정해 그 서버를 띄운다((서버, 루트)마다 하나). */
  start(cwd: string, serverId: LspServerId): Promise<{ ok: true; id: string; root: string } | { ok: false; error: string }>;
  send(id: string, message: string): void;
  onMessage(listener: (id: string, message: string) => void): () => void;
  onExit(listener: (id: string) => void): () => void;
}

export interface FileViewDto {
  /** 절대 경로. */
  path: string;
  /** git 루트(없으면 cwd) 기준 상대 경로. 표시용. */
  relPath: string;
  /** 현재 디스크 내용. 없거나(삭제) 바이너리/너무 크면 null. */
  content: string | null;
  /** HEAD 버전. 추적 중이고 HEAD 에 있을 때만. 새 파일이면 null. */
  headContent: string | null;
  size: number;
  missing: boolean;
  binary: boolean;
  tooLarge: boolean;
  /** 디스크 파일의 수정 시각(ms). 없으면 null. 저장 시 충돌 감지에 쓴다. */
  mtimeMs: number | null;
  /** 이미지 파일이면(확장자 기준, 상한 이내) 미리보기용 data URL. 그 밖엔 없음. */
  image?: { mime: string; dataUrl: string };
}

/** 설정 화면의 PATH 진단. 로그인 셸 PATH 와 앱 프로세스 PATH 의 차이를 보여준다. */
export interface CliDiagnosticsDto {
  loginShell: string;
  shellPathDirs: string[];
  appPathDirs: string[];
  /** 셸 PATH 에는 있지만 앱 PATH 에는 없는 디렉토리 중 CLI 가 실제로 발견된 곳. */
  missingInApp: { dir: string; provider: Provider }[];
}

/** Claude CLI 가 보는 MCP 서버 하나의 상태 (터미널 /mcp 화면과 같은 정보). */
export interface McpServerStatusDto {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  error?: string;
  /** user / project / local / claudeai / managed … */
  scope?: string;
  serverInfo?: { name: string; version: string };
  /** stdio / sse / http / claudeai-proxy */
  transport?: string;
  /** stdio 면 command + args, 아니면 url */
  target?: string;
  tools: { name: string; description?: string }[];
}

export interface SwitchProviderDto {
  provider: Provider;
  model?: string;
  preserveContext: boolean;
  /**
   * 떠나는 provider 에게 인계서를 직접 쓰게 한다. 우리가 기록을 잘라 만드는 요약보다
   * 낫지만 턴 하나를 더 돌리므로 시간이 걸린다. 실패하면 조용히 기존 요약으로 돌아간다.
   */
  askSummary?: boolean;
}

export interface ChatImageDto {
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** 순수 base64 (data: 접두사 없음). */
  base64: string;
}

export interface ChatSendDto {
  text: string;
  images?: ChatImageDto[];
}

export type ChatSendResult =
  /** pending: 턴 진행 중이라 프롬프트 큐에 들어갔다 (턴이 끝나면 자동 전송). */
  | { ok: true; queued: boolean; pending?: boolean }
  | { ok: false; error: string };

export interface PendingPromptDto {
  id: string;
  text: string;
  hasImages: boolean;
}

export interface SessionConfigDto {
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
}

export interface SessionSnapshotDto extends SessionConfigDto {
  tabId: string;
  status: SessionStatus;
  sessionId: string | null;
  handoffPending: boolean;
  /** 세션의 첫 턴 시작 시각(컨텍스트 패널의 세션 타이머용). */
  startedAt: number | null;
  /** 지금 도는 턴의 실제 시작 시각(큐 대기 제외). 턴이 끝나면 null. */
  turnStartedAt: number | null;
  /** "terminal" 이면 CLI(TUI)가 pty 에서 세션을 제어 중이고 앱은 기록을 미러만 한다. */
  controller: "app" | "terminal";
  /** 턴 진행 중에 써 둔 다음 지시들. 턴이 정상 종료되면 순서대로 자동 전송. */
  pendingPrompts: PendingPromptDto[];
  /** 사용 한도 도달로 멈춰 재시도를 기다리는 중이면 그 상태. */
  limitWait: LimitWaitDto | null;
  /** 동시 실행 상한에 걸려 기다리는 중(status=queued)이면 그 상태. */
  queueInfo: QueueInfoDto | null;
  /**
   * 지금 도는 턴이 "백그라운드 작업이 끝나 CLI 가 스스로 이어간 것" 인가.
   * 사용자는 아무 말도 안 했는데 화면이 도는 경우라, 그대로 "응답 중" 이라고 적으면 무엇에 답하는지 알 수 없다.
   * 백그라운드 완료 알림을 받은 뒤일 때만 true — 이유를 모르면 짐작하지 않는다.
   */
  ambientFromBg: boolean;
  /** 터미널 모드에서 CLI 가 권한 승인을 기다리는 중이면 그 툴. (Claude 만 감지) */
  terminalAttention: {
    kind: "permission";
    tool: string;
    summary: string;
    since: number;
  } | null;
  /** controller=terminal 인데 앱이 띄운 CLI 가 아니라 통합 터미널에서 사용자가 직접 띄운 것이면 true(끊기 버튼 없음). */
  terminalExternal: boolean;
}

export interface WorktreeStatusDto {
  exists: boolean;
  baseMissing: boolean;
  ahead: number;
  behind: number;
  dirty: number;
}

export type WorktreeResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface WorktreeApi {
  /** 워크스페이스의 저장소(활성 탭 cwd 또는 기본 경로)에서 브랜치+worktree 를 만들고 그 경로로 새 세션을 연다. */
  create(workspaceId: string, fromTabId?: string | null): Promise<WorktreeResult<{ tabId: string }>>;
  status(tabId: string): Promise<WorktreeStatusDto | null>;
  /** 이 세션의 커밋을 base 브랜치로 merge (원본 저장소에서). */
  merge(tabId: string): Promise<WorktreeResult<{ merged: number }>>;
  /** worktree 삭제. 탭은 원본 저장소 경로로 돌아간다. 미커밋 변경은 force 없이는 거부. */
  remove(tabId: string, opts?: { force?: boolean }): Promise<WorktreeResult<{ branchDeleted: boolean }>>;
  /** worktree 폴더(지금·예전 위치)에 있는 앱이 만든 worktree 전부. 설정의 정리 목록용. */
  listManaged(): Promise<ManagedWorktreeDto[]>;
  /** 목록의 worktree 하나를 지운다(미커밋 변경도 함께). 열린 탭이 쓰고 있으면 거부. */
  removeManaged(path: string): Promise<WorktreeResult<{ branchDeleted: boolean }>>;
}

export interface ManagedWorktreeDto {
  path: string;
  repo: string;
  branch: string;
  dirty: number;
  sizeKb: number | null;
  /** 이 worktree 를 작업 경로로 쓰는 탭. 없으면(탭을 지웠거나 팬아웃 정리 전) null. */
  tab: { id: string; title: string; open: boolean } | null;
  /** 이 폴더를 쓰는 열린 탭 수(분기 탭 포함). 하나라도 있으면 지울 수 없다. */
  openTabs: number;
}

export interface WorkspaceApi {
  state(): Promise<WorkspaceStateDto>;
  /** path 를 주지 않으면 디렉토리 선택 다이얼로그를 띄운다. 취소하면 null. */
  add(path?: string): Promise<{ workspaceId: string; tabId: string } | null>;
  /** 이름만으로 워크스페이스를 만들고 빈 세션을 하나 연다. 작업 경로는 탭에서 정한다. */
  create(name: string): Promise<{ workspaceId: string; tabId: string }>;
  /** 이름·기본 경로·검증 명령 변경. path 를 "" 로 주면 기본 경로 해제. */
  update(
    workspaceId: string,
    patch: { name?: string; path?: string; verifyCommands?: string[] },
  ): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  createTab(workspaceId?: string): Promise<string | null>;
  closeTab(tabId: string): Promise<void>;
  reopenTab(tabId: string): Promise<void>;
  /** 세션을 목록에서 지우고 대화 기록 파일도 삭제한다. 격리 세션의 worktree 가 dirty 면 지우지 않고 오류를 돌려준다. */
  deleteTab(tabId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  activateTab(tabId: string): Promise<void>;
  /** 화면에 보이는 채팅 탭(분할이면 둘, 설정·사용량 화면이면 없음). 완료·오류 표시와 완료 알림이 "보고 있는 탭" 을 이걸로 판단한다. */
  setVisibleTabs(tabIds: string[]): void;
  renameTab(tabId: string, title: string): Promise<void>;
  reorderTabs(openTabIds: string[]): Promise<void>;
  /** 사이드바에서 끌어 옮긴 워크스페이스 순서. */
  reorderWorkspaces(workspaceIds: string[]): Promise<void>;
  onChanged(listener: (state: WorkspaceStateDto) => void): () => void;
}

/** 화면에 주는 예약 목록. nextRunAt 은 main 이 계산해 붙인다. */
export interface ScheduleListDto {
  schedules: (Schedule & { nextRunAt: number | null })[];
  runs: Run[];
}

export interface ChatEventEnvelope {
  tabId: string;
  event: ChatEvent;
}

/** preload 가 window.workbench 로 노출하는 API. */
export interface WorkbenchApi {
  app: {
    info(): Promise<AppInfoDto>;
    /** GitHub 최신 릴리즈와 지금 버전을 비교한다. */
    checkUpdate(): Promise<UpdateCheckDto>;
    /** brew 로 cask 를 마지막으로 확인한 최신 버전까지 올린다. 이미 도는 중이면 그 결과를 기다린다. 끝나도 지금 앱은 옛 버전이니 relaunch 로 다시 시작해야 한다. */
    runUpdate(): Promise<UpdateRunResult>;
    updateStatus(): Promise<UpdateStatusDto>;
    /** 업데이트 상태가 바뀔 때(새 버전 발견·단계·진행률·완료·실패). */
    onUpdateChanged(listener: (status: UpdateStatusDto) => void): () => void;
    relaunch(): Promise<void>;
    /** provider 의 모델 목록(CLI 에 물어 온 것, 실패하면 정적 폴백). force 면 캐시를 무시한다. */
    models(provider: Provider, opts?: { force?: boolean }): Promise<{ models: ModelOptionDto[]; source: "cli" | "static" }>;
    /** 메뉴 단축키(⌘T/⌘W/⌘K/⌘1~9)는 main 메뉴가 받아 renderer 로 넘긴다. */
    onShortcut(listener: (name: ShortcutName) => void): () => void;
    /** 로그 폴더를 Finder 로 연다. */
    openLogs(): Promise<void>;
    /** 앱 데이터 폴더 또는 worktree 폴더를 Finder 로 연다. */
    openPath(which: "data" | "worktrees"): Promise<void>;
    /** 선택 창으로 worktree 폴더를 고른다. 취소하면 그대로. 바뀐 설정을 돌려준다. */
    pickWorktreeDir(): Promise<AppSettingsDto>;
    /** window error / unhandledrejection 을 main 로그 파일로 보낸다 (fire-and-forget). */
    reportError(error: RendererErrorDto): void;
    getSettings(): Promise<AppSettingsDto>;
    /** 바꾼 값은 바로 적용된다(유휴 시간은 지금 놀고 있는 프로세스에도). */
    setSettings(patch: Partial<AppSettingsDto>): Promise<AppSettingsDto>;
    /** 설정이 바뀌면(어느 창에서 바꿨든) 새 값을 받는다. 표시 언어를 따라가는 데 쓴다. */
    onSettingsChanged(listener: (settings: AppSettingsDto) => void): () => void;
    /** `sudal` CLI(제어 소켓)가 "이 탭에서 파일/브라우저를 열어라" 를 밀어 넣을 때. */
    onControlOpen(listener: (req: ControlOpenDto) => void): () => void;
    /** `sudal` 명령을 ~/.local/bin 에 설치한다(앱 동봉 스크립트를 앱의 node 로 실행하는 셸 스크립트). */
    installCli(): Promise<{ ok: true; path: string; onPath: boolean; hint?: string } | { ok: false; error: string }>;
    /** 스킬 스텁을 이 PC 에 있는 에이전트(Claude Code · Codex CLI)마다 설치한다. */
    installSkill(agent?: "claude" | "codex"): Promise<{ ok: true; paths: string[]; skipped: string[] } | { ok: false; error: string }>;
    /** 두 설치물의 현재 상태(있는지·이 앱을 가리키는지·PATH 에 있는지·스텁이 최신인지). */
    installStatus(): Promise<InstallStatusDto>;
  };
  /** 렌더러 상태(열린 파일·미저장 초안·입력창 초안)의 파일 저장소. 시작 때 load, 바뀔 때 set(한 방향, 즉시 디스크). */
  state: {
    load(): Promise<Record<string, string>>;
    set(key: string, value: string | null): void;
  };
  workspaces: WorkspaceApi;
  usage: UsageApi;
  terminal: TerminalApi;
  cli: {
    status(provider: Provider): Promise<CliStatusDto>;
    candidates(provider: Provider): Promise<CliCandidateDto[]>;
    setOverride(
      provider: Provider,
      binPath: string | null,
    ): Promise<OverrideSetResultDto>;
    /** 캐시를 비우고 셸 PATH 부터 다시 캡처한다. */
    refresh(): Promise<void>;
    diagnostics(): Promise<CliDiagnosticsDto>;
  };
  chat: {
    send(tabId: string, payload: ChatSendDto): Promise<ChatSendResult>;
    abort(tabId: string): Promise<boolean>;
    answerPermission(
      tabId: string,
      requestId: string,
      answer: PermissionAnswer,
    ): Promise<boolean>;
    configure(
      tabId: string,
      patch: Partial<SessionConfigDto>,
    ): Promise<SessionSnapshotDto>;
    snapshot(tabId: string): Promise<SessionSnapshotDto>;
    /** 교차 리뷰: 이 탭의 작업 트리 diff 를 다른 provider 의 새 탭에 보내고, 답이 오면 이 탭에 카드로 붙인다. */
    crossReview(tabId: string): Promise<{ ok: true; reviewTabId: string; scope: string } | { ok: false; error: string }>;
    /** 검증: 워크스페이스에 저장한 명령(또는 commands)을 이 탭의 cwd 에서 순서대로 돌리고 결과를 이 탭에 카드로 남긴다. */
    verify(tabId: string, opts?: { commands?: string[] }): Promise<VerifyStartResult>;
    verifyAbort(tabId: string): Promise<boolean>;
    /** 저장한 명령이 없을 때 cwd 의 매니페스트에서 추천하는 명령. */
    verifySuggest(tabId: string): Promise<string[]>;
    /** 팬아웃: 지시 하나를 격리 세션 N개에 보내고 이 탭에 카드로 남긴다. */
    fanout(tabId: string, req: FanoutStartDto): Promise<FanoutStartResult>;
    fanoutCompare(tabId: string, fanoutId: string): Promise<FanoutCompareDto>;
    /** 변형의 변경(패치)을 이 탭의 저장소에 적용한다. */
    fanoutAdopt(tabId: string, fanoutId: string, variantTabId: string): Promise<FanoutAdoptResult>;
    /** 변형 worktree 를 모두 지우고 탭을 닫는다(미커밋 변경 포함, 강제). */
    fanoutCleanup(tabId: string, fanoutId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** 지금까지의 이벤트 로그 (화면 재구성용). */
    events(tabId: string): Promise<ChatEvent[]>;
    clear(tabId: string): Promise<SessionSnapshotDto>;
    /**
     * 컨텍스트를 줄인다. Claude 는 provider 에게 맡기고(`/compact`) 세션이 그대로 이어진다 —
     * focus 를 주면 무엇을 남길지 지시할 수 있다. Codex 는 압축이 없어 요약 후 새 세션으로 간다.
     */
    compact(tabId: string, focus?: string): Promise<CompactResult>;
    handoffPreview(tabId: string): Promise<Handoff>;
    switchProvider(
      tabId: string,
      opts: SwitchProviderDto,
    ): Promise<SessionSnapshotDto>;
    /** 구독 해제 함수를 돌려준다. */
    onEvent(listener: (envelope: ChatEventEnvelope) => void): () => void;
    /**
     * 탭의 cwd 에서 쓸 수 있는 Claude 슬래시 커맨드(터미널 전용 제외). Codex 탭이면 빈 배열.
     * 캐시가 없으면 CLI 를 잠깐 띄워 받아오므로 첫 호출은 수 초 걸릴 수 있다.
     */
    commands(tabId: string): Promise<SlashCommandDto[]>;
    /** 어떤 cwd 의 커맨드 목록이 바뀌었을 때 (턴 도중 갱신 포함). */
    onCommandsChanged(listener: (cwd: string) => void): () => void;
    /** 하이브리드: 세션 제어를 터미널(CLI TUI)로 넘긴다. 같은 세션 id 로 claude --resume / codex resume 를 pty 에 띄운다. */
    attachTerminal(
      tabId: string,
    ): Promise<
      { ok: true; snapshot: SessionSnapshotDto } | { ok: false; error: string }
    >;
    /** 터미널의 CLI 를 끊고 채팅으로 돌아온다 (실제 복귀는 프로세스 종료 시). */
    detachTerminal(tabId: string): Promise<void>;
    /** main 이 스냅샷을 바꿨을 때(컨트롤러 전환, 세션 id 확정 등). */
    onSnapshotChanged(
      listener: (snapshot: SessionSnapshotDto) => void,
    ): () => void;
    /** 한도 대기: 지금 바로 재시도 / 재시도 취소. */
    limitRetryNow(tabId: string): Promise<SessionSnapshotDto>;
    limitCancel(tabId: string): Promise<SessionSnapshotDto>;
    /** 프롬프트 큐 항목 삭제·수정. 스냅샷을 돌려준다. */
    queueRemove(tabId: string, id: string): Promise<SessionSnapshotDto>;
    queueUpdate(tabId: string, id: string, text: string): Promise<SessionSnapshotDto>;
    /** 세션이 놀고 있을 때 대기열 맨 앞을 지금 보낸다(앱 재시작으로 복원된 지시 등). */
    queueSendNext(tabId: string): Promise<SessionSnapshotDto>;
    /** Codex 가 작업 중일 때 대기열의 지시를 돌고 있는 턴에 바로 끼워 넣는다. 실패하면 대기열에 남고 error 가 온다. */
    queueSteer(tabId: string, id: string): Promise<{ ok: boolean; error?: string; snapshot: SessionSnapshotDto }>;
    /** 이 턴(분기 지점 id)까지의 대화를 새 탭으로 갈라 이어 간다. 원래 탭은 그대로다. */
    fork(tabId: string, pointId: string): Promise<{ ok: true; tabId: string } | { ok: false; error: string }>;
    /** 모든 세션(닫힌 것 포함)의 사용자·어시스턴트 텍스트에서 부분 일치 검색. */
    search(query: string): Promise<SearchResultDto[]>;
    /** 저장 다이얼로그를 띄워 세션을 마크다운으로 내보낸다. 취소하면 null. */
    exportMarkdown(tabId: string): Promise<string | null>;
  };
  worktree: WorktreeApi;
  /** 오케스트레이션(Run/Task/Dispatch) — 사람 코디네이터용 UI. */
  orch: {
    list(): Promise<OrchRunState[]>;
    reply(runId: string, questionId: string, body: string): Promise<OrchResult>;
    followup(runId: string, dispatchId: string, body: string): Promise<OrchResult>;
    takeover(runId: string): Promise<OrchResult>;
    worker(runId: string, dispatchId: string, action: "retain" | "release" | "stop" | "abandon" | "cleanup"): Promise<OrchResult>;
    gate(runId: string, gateId: string, resolution: string): Promise<OrchResult>;
    close(runId: string): Promise<OrchResult>;
    onChanged(listener: (runId: string) => void): () => void;
  };
  lsp: LspApi;
  snippets: {
    list(): Promise<SnippetDto[]>;
    save(input: {
      id?: string;
      name: string;
      text: string;
      workspaceId: string | null;
    }): Promise<{ ok: true; snippet: SnippetDto } | { ok: false; error: string }>;
    remove(id: string): Promise<void>;
    onChanged(listener: (items: SnippetDto[]) => void): () => void;
  };
  git: {
    info(cwd: string): Promise<GitInfoDto | null>;
    changes(cwd: string): Promise<GitChangeDto[]>;
    /** 고른 파일만 add 하고 그 파일들만 커밋한다 (다른 스테이징은 건드리지 않음). */
    commit(cwd: string, paths: string[], message: string): Promise<GitCommitResult>;
    /** 고른 파일의 diff 로 Claude(haiku) 에게 커밋 메시지 초안을 받는다. */
    draftMessage(cwd: string, paths: string[]): Promise<GitDraftResult>;
    /** 파일 하나의 변경을 버린다(HEAD 상태로). 되돌릴 수 없다. */
    revert(cwd: string, path: string): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  files: {
    /** 절대 경로 또는 cwd 기준 상대 경로의 파일을 읽는다 (현재 내용 + HEAD 내용). */
    read(cwd: string, path: string): Promise<FileViewDto>;
    /**
     * 파일을 저장한다. expectedMtimeMs 가 있고 디스크의 mtime 이 다르면(밖에서 바뀜) force 없이는 conflict 로 거부한다.
     */
    write(
      cwd: string,
      path: string,
      content: string,
      opts: { expectedMtimeMs: number | null; expectedSize?: number | null; force?: boolean },
    ): Promise<{ ok: true; mtimeMs: number } | { ok: false; error: string; conflict?: boolean }>;
    /** 새 파일(빈 내용) 또는 폴더. 저장소 안에서만, 이미 있으면 거부. */
    create(cwd: string, path: string, kind: "file" | "dir"): Promise<FileOpResultDto>;
    /** 이름 변경/이동. 덮어쓰기 없음. */
    rename(cwd: string, from: string, to: string): Promise<FileOpResultDto>;
    /** 휴지통으로 보낸다(되돌릴 수 있음). */
    remove(cwd: string, path: string): Promise<FileOpResultDto>;
    /** 디렉토리 항목 목록 (폴더 먼저, 이름순). */
    list(dir: string): Promise<DirEntryDto[]>;
    /** 답변에 적힌 파일 참조("Foo.kt", "src/a.ts")에 맞는 실제 파일들(절대 경로). cwd 기준 상대 경로 → 저장소 안 뒤쪽 경로 일치 순. 없으면 []. */
    locate(cwd: string, ref: string): Promise<string[]>;
  };
  mcp: {
    /** cwd 기준으로 Claude CLI 를 잠깐 띄워 MCP 서버 상태를 받는다. 연결 대기 때문에 최대 10초쯤 걸릴 수 있다. */
    status(cwd: string): Promise<McpServerStatusDto[]>;
  };
  dialog: {
    pickDirectory(): Promise<string | null>;
  };
  /** 예약 실행. 정해진 시각에 프롬프트를 보내고, 회차마다 결과를 남긴다. */
  schedules: {
    list(): Promise<ScheduleListDto>;
    save(input: Record<string, unknown>): Promise<ScheduleListDto>;
    remove(id: string): Promise<ScheduleListDto>;
    runNow(id: string): Promise<ScheduleListDto>;
    onChanged(cb: (s: ScheduleListDto) => void): () => void;
  };
  /** 턴이 끝난 뒤에도 도는 작업(백그라운드 Codex 등). 탭은 놀고 있어도 일이 남았음을 보여 준다. */
  jobs: {
    list(): Promise<BackgroundJobDto[]>;
    onChanged(cb: (jobs: BackgroundJobDto[]) => void): () => void;
  };
  browser: {
    /** 기본 브라우저로 연다(http/https/mailto 만). 인앱 브라우저 탭은 렌더러의 <webview> 가 맡는다. */
    openExternal(url: string): Promise<boolean>;
    /** 에디터의 HTML 을 인앱 브라우저로 볼 로컬 미리보기 URL(저장소 루트를 서비스하는 127.0.0.1 서버). 루트 밖이면 error. */
    previewUrl(cwd: string, path: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
    /** 이 브라우저 탭(webview 의 webContents id)에서 최근 실패한 요청. 진단 첨부가 읽고 비운다. */
    /** 이 채팅 탭에서 지금 보고 있는 브라우저를 main 에 알린다(에이전트 조작용). 없어지면 null. */
    register(tabId: string, webContentsId: number | null, url: string): void;
    /** 파비콘을 main 이 받아 data URL 로 준다(렌더러 CSP 가 원격 이미지를 막는다). 못 받으면 null. */
    favicon(url: string): Promise<string | null>;
    netFailures(webContentsId: number, clear?: boolean): Promise<NetFailure[]>;
  };
}

/** 제어 소켓(sudal CLI)이 렌더러에 요청하는 화면 동작. */
export type ControlOpenDto =
  | { kind: "file"; tabId: string; path: string; line?: number }
  | { kind: "browser"; tabId: string; url: string };

/** 설정 > 일반의 "CLI와 에이전트 스킬" 설치 상태. */
export interface InstallStatusDto {
  cli: {
    path: string;
    installed: boolean;
    /** 설치된 스크립트가 지금 실행 중인 이 앱(경로)을 가리키면 true. 앱을 옮겼으면 false. */
    current: boolean;
    /** 로그인 셸 PATH 에 ~/.local/bin 이 있으면 true. */
    onPath: boolean;
  };
  /** 에이전트별 스킬 스텁. Claude Code 는 ~/.claude/skills, Codex CLI 는 $CODEX_HOME/skills(기본 ~/.codex/skills). */
  skills: SkillInstallDto[];
}

export interface SkillInstallDto {
  agent: "claude" | "codex";
  label: string;
  path: string;
  /** 그 에이전트가 이 PC 에 있는지(홈 디렉토리 존재). 없으면 설치를 건너뛴다. */
  available: boolean;
  installed: boolean;
  /** 설치된 스텁이 이 앱에 동봉된 것과 같으면 true. */
  current: boolean;
}
