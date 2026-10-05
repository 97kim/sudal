import { dirname, isAbsolute, join, resolve } from "node:path";
import { isWithin } from "./path-within";
import { existsSync, rmSync, mkdirSync, readdirSync, realpathSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import {
  nativeTheme,
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  session,
  shell,
  webContents,
  type MenuItemConstructorOptions,
} from "electron";
import type { PermissionAnswer } from "@shared/chat-events";
import { isThemeMode } from "@shared/theme";
import { intlLocale, isLanguageSetting, resolveLocale, LANGUAGE_SETTING_DEFAULT, LOCALES, type Locale } from "@shared/i18n/locale";
import { appMsg, mainI18n, mt, setMainLocale } from "./i18n";
import { legacyWorktreeDir, migrateUserData, removeLegacyInstall, type UserDataMigration } from "./legacy-name";
import { msgText, type Msg, type MsgKey } from "@shared/i18n/msg";
import { NOTIFY_ON_DONE_DEFAULT, isNotifyOnDone, shouldNotifyDone, PROVIDERS, IPC, MAX_CONCURRENT_DEFAULT, MAX_CONCURRENT_MAX, MAX_CONCURRENT_MIN, SESSION_IDLE_MINUTES_DEFAULT, SESSION_IDLE_MINUTES_MAX, SESSION_IDLE_MINUTES_MIN, type AppSettingsDto, type AppInfoDto, type UpdateCheckDto, type UpdateRunResult, type UpdateStatusDto, type ChatEventEnvelope, type ChatSendDto, type ChatSendResult, type CompactResult, type ControlOpenDto, type InstallStatusDto, type CliCandidateDto, type CliDiagnosticsDto, type CliStatusDto, type OverrideSetResultDto, type Provider, type RendererErrorDto, type SessionConfigDto, type ShortcutName, type SwitchProviderDto, type UsageSettingsDto, type VerifyStartResult, type FanoutStartDto, type FanoutStartResult, type FanoutCompareDto, type FanoutAdoptResult, type RateLimitWindowDto, type UsageStatusDto, type WorkspaceStateDto, type ManagedWorktreeDto, SearchResultDto } from "@shared/ipc";
import {
  DEFAULT_PRICING,
  periodRange,
  summarizeUsage,
  usageCsv,
  type PricingEntry,
  type UsageFilter,
} from "@shared/usage";
import { tabTitle, tabsUsingPath, type WorktreeMeta } from "@shared/workspace-model";
import {
  prepareChatImages,
  saveChatImages,
  toHistoryImages,
} from "./chat-attachments";
import { forkClaudeSession, setClaudeSessionIdleMs, type ClaudeRuntime } from "./claude-adapter";
import { buildCliDiscovery, type CliDiscovery } from "./cli-discovery";
import { sanitizeCliEnv } from "./cli-env";
import { ShellCliMonitor } from "./cli-watch";
import { SlashCommandCache } from "./claude-commands";
import { fetchMcpStatus } from "./claude-mcp";
import { forkCodexThread, setCodexSessionIdleMs, type CodexRuntime } from "./codex-adapter";
import { buildReviewPrompt, otherProvider, reviewPermissionDecision, reviewScopeParams, reviewTabTitle } from "@shared/cross-review";
import { handoffBriefPrompt, handoffNotePermission, NOTE_FILE } from "@shared/handoff";
import { lastReplyText } from "@shared/session-state";
import { parseCron } from "@shared/cron";
import { PreviewServer } from "./preview-server";
import { browserNetFailures, clearBrowserNetFailures, watchBrowserNetwork } from "./browser-net";
import { fetchFavicon } from "./browser-favicon";
import { forgetSessionCookies, restoreSessionCookies, saveSessionCookies } from "./browser-cookies";
import { BROWSER_PARTITION } from "./browser-net";
import { BackgroundJobWatcher } from "./background-jobs";
import type { BackgroundJobDto } from "@shared/background-jobs";
import { BackgroundTaskRegistry } from "./bg-tasks";
import { VerifyRunner, suggestForCwd } from "./verify";
import { invalidateModels, listModels } from "./models";
import { OrchError, Orchestrator, workerSnapshotFrom } from "./orchestration";
import { runSettled, runSummary } from "@shared/orchestration";
import { parseVerifyCommands } from "@shared/verify";
import { FANOUT_PROMPT_EXCERPT, FANOUT_SUMMARY_EXCERPT, allSettled, changeStats, excerpt, fanoutTabTitle, validateFanoutRequest, variantLabel } from "@shared/fanout";
import type { FanoutEvent, FanoutVariant } from "@shared/chat-events";
import { ControlServer } from "./control-server";
import { writeFileView, listDirectory, locateFiles, readFileView, createPath, renamePath, resolveDeletable, repoRoot } from "./files";
import { gitChanges, gitCommit, gitDiffFor, gitInfo, gitRevert } from "./git";
import {
  applyPatch,
  listManagedWorktrees,
  worktreeCreate,
  worktreeMerge,
  worktreePatch,
  worktreeRemove,
  worktreeSnapshot,
  worktreeSlug,
  worktreeStatus,
} from "./worktree";
import { draftCommitMessage } from "./git-draft";
import { ScheduleStore } from "./schedule-store";
import { ScheduleEngine } from "./schedule-engine";
import { runPrecheckCommand } from "./precheck";
import { isScheduleWorkspace, runReason, type Run, type Schedule, type ScheduleTarget } from "@shared/schedules";
import { createFileLogger, type FileLogger } from "./logger";
import { brewUpgrade, caskVersion, compareVersions, fetchLatestRelease, type UpdateProgress } from "./app-update";
import { Store } from "./persistence";
import { RendererState } from "./renderer-state";
import { claudeHookSettings, shellQuote } from "./transcript-mirror";
import { AttentionTracker } from "./attention";
import { SnippetStore } from "./snippets";
import { LspManager } from "./lsp";
import { isLspServerId } from "@shared/lsp-servers";
import { SearchIndex } from "./search-index";
import { readCliDefaultModel } from "./cli-defaults";
import {
  eventsToMarkdown,
  exportFileName,
} from "@shared/transcript-search";
import { PROVIDER_LABEL, SessionManager, summarizeToolInput } from "./session-manager";
import { UsageScanner } from "./transcripts";
import { TerminalManager } from "./terminals";
import { fetchUsageText } from "./claude-control";
import { mergeRateLimit, parseUsageText } from "./claude-events";
import { WorkspaceService } from "./workspaces";

// ===== userData 이관: 앱 이름이 바뀌면(ai-workbench → Atelier → Sudal) 폴더도 바뀐다 =====
// 세션 기록·설정·사용량 캐시를 옛 폴더에서 넘겨받는다(legacy-name.ts). userData 를 읽는 어떤 코드보다 먼저 한다.
{
  let migration: UserDataMigration = { kind: "none" };
  try {
    migration = migrateUserData(app.getPath("userData"), app.getPath("appData"));
  } catch (e) {
    console.error("[app] userData 이관 실패:", e);
  }
  if (migration.kind === "running") {
    // 옛 앱이 쓰는 폴더를 빼낼 수 없다. 빈 상태로 시작하면 다음에는 이관하지 않으므로 여기서 멈춘다.
    setMainLocale(resolveLocale(LANGUAGE_SETTING_DEFAULT, app.getPreferredSystemLanguages()));
    dialog.showErrorBox(mt("main.legacy.runningTitle"), mt("main.legacy.runningBody"));
    app.exit(0);
  }
}

// ===== 크래시 로그: main 콘솔 → userData/logs/main.log =====
// app.getPath("userData") 는 ready 전에도 쓸 수 있으므로 가장 먼저 붙인다.

const logger: FileLogger = createFileLogger(
  join(app.getPath("userData"), "logs"),
);
logger.patchConsole();
console.log(
  `[app] sudal ${app.getVersion()} start (electron ${process.versions.electron}, ${process.platform}/${process.arch}${app.isPackaged ? "" : ", dev"})`,
);

process.on("uncaughtException", (e) =>
  console.error("[main] uncaughtException:", e),
);
process.on("unhandledRejection", (reason) =>
  console.error("[main] unhandledRejection:", reason),
);
// 정상 종료(clean-exit)와 외부 kill(SIGTERM 등)은 크래시가 아니므로 로그에 남기지 않는다.
const benignExit = (reason: string) =>
  reason === "clean-exit" || reason === "killed";
app.on("render-process-gone", (_e, contents, details) => {
  if (benignExit(details.reason)) return;
  console.error(
    `[main] render-process-gone: ${details.reason} (exit ${details.exitCode}) url=${contents.getURL()}`,
  );
});
app.on("child-process-gone", (_e, details) => {
  if (benignExit(details.reason)) return;
  console.error(
    `[main] child-process-gone: ${details.type} ${details.reason} (exit ${details.exitCode}) ${details.name ?? ""}`,
  );
});

// ===== CLI discovery (lazy singleton) =====

let discovery: CliDiscovery | null = null;
function cliDiscovery(): CliDiscovery {
  discovery ??= buildCliDiscovery({
    overrideFilePath: join(app.getPath("userData"), "cli-overrides.json"),
  });
  return discovery;
}

async function cliStatus(provider: Provider): Promise<CliStatusDto> {
  const status = await cliDiscovery().find(provider);
  // "기본 (CLI 설정)" 항목에 실제 모델 이름을 붙이기 위해 CLI 설정 파일의 기본 모델도 함께 준다.
  const defaultModel = readCliDefaultModel(provider, app.getPath("home")) ?? undefined;
  if (!status.installed || !status.path) return { ...status, defaultModel };
  // 설정 화면에 버전을 같이 보여주기 위해 후보 목록에서 같은 경로의 --version 결과를 꺼낸다.
  const candidates = await cliDiscovery().listCandidates(provider);
  const hit = candidates.find((c) => c.path === status.path);
  return { ...status, version: hit?.versionOutput, defaultModel };
}

// SDK 가 띄우는 CLI 에 줄 env — 사용자 셸 PATH 를 반영하고 HOME/SHELL 을 보정한다.
// 두 SDK 모두 env 를 지정하면 process.env 를 상속하지 않으므로 완전한 env 를 만들어 넘긴다.
async function sdkEnv(tabId?: string): Promise<Record<string, string>> {
  const baseEnv = await cliDiscovery().buildEnv();
  const home = app.getPath("home");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv))
    if (typeof v === "string") env[k] = v;
  // 앱이 Claude Code·Codex 안의 셸에서 실행됐을 때 상속되는 세션 표식을 뺀다 — CLI 가 중첩 세션으로 여겨 기록 저장을 끄면 터미널 모드 미러가 깨진다.
  const clean = sanitizeCliEnv(env);
  for (const k of Object.keys(env)) if (!(k in clean)) delete env[k];
  env.HOME = env.HOME || home;
  env.USERPROFILE = env.USERPROFILE || home;
  env.SHELL = env.SHELL || process.env.SHELL || "/bin/zsh";
  // 탭 안에서 부르는 `sudal` CLI 가 이 인스턴스(이 userData)에 붙게 — 개발·테스트 인스턴스가 사용자 앱을 건드리지 않게
  env.SUDAL_USERDATA = app.getPath("userData");
  // 탭의 에이전트가 자기 탭을 알 수 있게 — `active` 는 화면에서 고른 탭이지 호출한 에이전트의 탭이 아니다.
  // 탭 없이 띄우는 프로세스에는 남기지 않는다(앱이 다른 Sudal 탭의 셸에서 실행됐을 때 그 값이 새지 않게).
  if (tabId) env.SUDAL_TAB_ID = tabId;
  else delete env.SUDAL_TAB_ID;
  return env;
}

async function claudeRuntime(tabId?: string): Promise<ClaudeRuntime> {
  const cli = await cliDiscovery().find("claude");
  if (!cli.installed || !cli.path)
    throw new Error(cli.error || mt("main.error.claudeCliMissing"));
  const env = await sdkEnv(tabId);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `sudal/${app.getVersion()}`;
  return { pathToClaudeCodeExecutable: cli.path, env };
}

async function codexRuntime(tabId?: string): Promise<CodexRuntime> {
  const cli = await cliDiscovery().find("codex");
  if (!cli.installed || !cli.path)
    throw new Error(cli.error || mt("main.error.codexCliMissing"));
  return { codexPath: cli.path, env: await sdkEnv(tabId) };
}

async function cliDiagnostics(): Promise<CliDiagnosticsDto> {
  const env = await cliDiscovery().buildEnv();
  const shellPathDirs = (env.PATH || "").split(":").filter(Boolean);
  const appPathDirs = (process.env.PATH || "").split(":").filter(Boolean);
  const appSet = new Set(appPathDirs);
  const missingInApp: CliDiagnosticsDto["missingInApp"] = [];
  for (const provider of ["claude", "codex"] as const) {
    const status = await cliDiscovery().find(provider);
    if (!status.path) continue;
    const dir = status.path.slice(0, status.path.lastIndexOf("/"));
    if (!appSet.has(dir) && !missingInApp.some((m) => m.dir === dir))
      missingInApp.push({ dir, provider });
  }
  return {
    loginShell: process.env.SHELL || "/bin/zsh",
    shellPathDirs,
    appPathDirs,
    missingInApp,
  };
}

// ===== Broadcast helpers =====

let mainWindow: BrowserWindow | null = null;
let jobWatcher: BackgroundJobWatcher | null = null;
/** Claude Code 가 백그라운드로 돌리는 일(명령·하위 에이전트). SDK 가 살아 있는 전체 집합을 준다. */
const bgTasks = new BackgroundTaskRegistry();

/** 사용자에게 "아직 도는 일" 은 한 종류다 — 플러그인 작업과 백그라운드 명령을 합쳐 한 목록으로 보낸다. */
function allBackgroundJobs(): BackgroundJobDto[] {
  return [...(jobWatcher?.current() ?? []), ...bgTasks.current()];
}

function sendBackgroundJobs() {
  const jobs = allBackgroundJobs();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.backgroundJobsChanged, jobs);
}

function onBackgroundJobFinished(job: BackgroundJobDto) {
  const tabId = sessions.tabForSessionId(job.sessionId);
  // 이 앱이 시킨 작업이 아니면(다른 터미널의 Claude Code) 알리지 않는다
  if (!tabId) return;
  const ok = job.status === "completed";
  attention.backgroundJob(tabId, !ok);
  notify(
    `${ok ? mt("main.notify.bgDone") : mt("main.notify.bgFailed")} · ${tabTitleOf(tabId)}`,
    `${job.label} — ${job.summary || job.title}`,
    tabId,
  );
}

/**
 * 턴이 끝난 뒤에도 도는 작업을 지켜본다. 두 갈래다 —
 * 플러그인 작업(백그라운드 Codex 등)은 프로세스가 앱에서 떨어져 나가 작업 목록 파일이 유일한 단서고,
 * Claude Code 가 백그라운드로 돌린 명령은 대화 이벤트로 시작을 알고 출력 파일 꼬리로 끝을 안다.
 */
let scheduleStore: ScheduleStore | null = null;
let scheduleEngine: ScheduleEngine | null = null;

/** 예약의 작업 경로. 격리 세션을 만들기 전 단계(precheck)는 여기서 돈다. */
/**
 * 예약 결과가 모이는 워크스페이스. 없으면 만든다 — 앱을 처음 깐 사람도 이 칸을 갖고 시작한다.
 * 예약마다 어디에 둘지 묻지 않는다. 결과는 언제나 한곳에 모이는 편이 찾기 쉽다.
 */
/**
 * 예약 워크스페이스의 이름을 지금 언어에 맞춘다. 앱이 만든 자리라 사람이 지은 이름이 아니다 —
 * 다만 사용자가 직접 바꾼 이름(어느 언어의 기본 이름도 아닌 것)은 건드리지 않는다.
 */
function syncScheduleWorkspaceName(): void {
  const ws = workspaces.state().model.workspaces.find((w) => w.builtin === "schedules");
  if (!ws) return;
  const name = mt("schedules.workspaceName");
  if (ws.name === name) return;
  const defaults = LOCALES.map((l) => mainI18n().getFixedT(l)("schedules.workspaceName"));
  if (defaults.includes(ws.name)) workspaces.updateWorkspace(ws.id, { name });
}

function scheduleWorkspaceId(): string | null {
  const found = workspaces.state().model.workspaces.find(isScheduleWorkspace);
  if (found) {
    // 표식이 생기기 전에 만든 것(이름으로 찾은 것)에는 표식을 붙여 둔다 — 그 뒤로는 이름을 바꿔도 찾는다
    if (!found.builtin) workspaces.updateWorkspace(found.id, { builtin: "schedules" });
    syncScheduleWorkspaceName();
    return found.id;
  }
  const made = workspaces.createWorkspace(mt("schedules.workspaceName"), "schedules");
  // 워크스페이스를 만들면 빈 탭이 따라온다. 예약은 제 탭을 따로 만드니 그건 치운다.
  if (made.tabId) workspaces.deleteTab(made.tabId);
  return made.workspaceId;
}

/** 예약이 돌 폴더. 예약에 적힌 것이 먼저고, 없으면(옛 예약) 워크스페이스 기본 경로로 읽는다. */
function cwdForTarget(target: ScheduleTarget): string | null {
  return target.cwd || null;
}

/** 예약 실행을 시작한다. 켜질 때 끝을 못 본 회차부터 정리한다. */
/** 예약 API. CLI 와 화면이 같은 구현을 쓴다 — 둘이 어긋나면 사용자가 본 것과 실제가 달라진다. */
function schedulesApi() {
      const store = scheduleStore;
      const engine = scheduleEngine;
      if (!store || !engine) throw new Error(mt("schedules.error.notReady"));
      return {
        list: () => scheduleSnapshot() as { schedules: (Schedule & { nextRunAt: number | null })[]; runs: Run[] },
        save: (input: Partial<Schedule> & { id?: string }) => {
          const now = Date.now();
          const existing = input.id ? store.schedule(input.id) : null;
          const enabled = input.enabled ?? existing?.enabled ?? true;
          const next: Schedule = {
            id: existing?.id ?? randomUUID(),
            name: input.name ?? existing?.name ?? mt("schedules.defaultName"),
            cron: input.cron ?? existing?.cron ?? "0 9 * * *",
            timezone: input.timezone ?? existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            prompt: input.prompt ?? existing?.prompt ?? "",
            provider: input.provider ?? existing?.provider ?? "claude",
            ...(input.model ?? existing?.model ? { model: input.model ?? existing?.model } : {}),
            policy: input.policy ?? existing?.policy ?? "ask",
            target: input.target ?? existing?.target ?? { kind: "fresh", worktree: false },
            ...(input.precheck ?? existing?.precheck ? { precheck: (input.precheck ?? existing?.precheck)! } : {}),
            enabled,
            missedRunGraceMinutes: input.missedRunGraceMinutes ?? existing?.missedRunGraceMinutes ?? 120,
            createdAt: existing?.createdAt ?? now,
            // 껐다 다시 켜면 그 시점부터 센다 — 꺼 둔 동안의 회차를 만회하지 않는다.
            activeSince: existing && existing.enabled === enabled ? existing.activeSince : now,
          };
          // 화면과 CLI 가 같은 문을 쓰므로 검증도 여기 둔다. 못 도는 예약을 그대로 저장하면
          // 목록에는 있는데 영영 안 도는 것이 되고, 사용자는 기다리다가 알게 된다.
          if (!next.name.trim()) throw new Error(mt("schedules.error.nameRequired"));
          if (!next.prompt.trim()) throw new Error(mt("schedules.error.promptRequired"));
          if (!parseCron(next.cron)) throw new Error(mt("schedules.error.cronInvalid"));
          if (!cwdForTarget(next.target)) throw new Error(mt("schedules.error.folderRequired"));
          store.upsertSchedule(next);
          sendAll(IPC.schedulesChanged, scheduleSnapshot());
          return next;
        },
        remove: (id: string) => {
          const had = store.schedule(id) !== null;
          store.removeSchedule(id);
          sendAll(IPC.schedulesChanged, scheduleSnapshot());
          return had;
        },
        runNow: (id: string) => engine.runNow(id),
        runs: (id: string) => store.runs(id),
      };
    
}

function startSchedules() {
  // 예약을 만들기 전에 칸을 먼저 둔다 — 처음 깐 사람도 사이드바에서 이 자리를 보고 시작한다.
  scheduleWorkspaceId();
  if (scheduleEngine) return;
  scheduleStore = new ScheduleStore(app.getPath("userData"));
  const store = scheduleStore;
  scheduleEngine = new ScheduleEngine({
    store,
    checkTarget: (target) => (cwdForTarget(target) ? null : runReason(mt, "schedules.msg.noFolder")),
    checkBudget: () => {
      const settings = usageSettings();
      if (!settings.monthlyBudgetUsd || settings.monthlyBudgetUsd <= 0) return null;
      const sum = querySummary({ ...periodRange("month", Date.now()), provider: "all" });
      // 예약은 사람이 안 보는 사이에 돈다 — 예산을 넘겼으면 조용히 멈추는 편이 낫다.
      return sum.totals.costUsd >= settings.monthlyBudgetUsd
        ? runReason(mt, "schedules.msg.budgetExceeded", { spent: sum.totals.costUsd.toFixed(2), budget: settings.monthlyBudgetUsd.toFixed(2) })
        : null;
    },
    // 선조건은 예약에 적힌 폴더에서 돈다. 격리 회차의 worktree 는 이 시점에 아직 없다 —
    // "무엇을 할 일이 있나" 는 원본을 보고 판단하는 것이 맞다.
    runPrecheck: async ({ command, timeoutMs, target }) =>
      runPrecheckCommand({ command, timeoutMs, cwd: cwdForTarget(target), env: await cliDiscovery().buildEnv() }),
    dispatch: async ({ schedule, run }) => dispatchSchedule(schedule, run),
    onRunChanged: (run) => {
      sendAll(IPC.schedulesChanged, scheduleSnapshot());
      notifyScheduleRun(run);
    },
    log: (line) => console.log(line),
  });
  scheduleEngine.start();
}

/** 격리 회차의 worktree를 몇 개까지 남길지. 결과를 되돌아볼 만큼은 남기되 무한히 쌓이지는 않게. */
const KEEP_ISOLATED_RUNS = 3;

/**
 * 오래된 격리 회차가 남긴 worktree와 탭을 치운다. 새 격리 회차를 띄우기 직전에 한 번 돈다 —
 * 격리를 안 쓰는 예약에는 아무 일도 일어나지 않는다.
 *
 * 강제로 지운다. 격리 폴더는 거의 항상 더럽다 — 예약이 만든 파일뿐 아니라 도구가 작업 디렉터리에
 * 쓰는 상태(.omc 등)가 매번 남는다. "더러우면 안 치운다" 로 두면 실기기에서 아무것도 치우지 못했다.
 *
 * 커밋된 작업은 그래도 남는다. 폴더만 지우고 브랜치는 `branch -d` 로 지우므로, 회차가 제 결과를
 * 커밋해 뒀으면 병합되지 않은 브랜치라 거부되어 살아남는다 — `git switch sudal/<이름>` 으로 꺼낸다.
 * 잃는 것은 커밋하지 않은 찌꺼기뿐이고, 그것도 최근 세 회차는 손대지 않는다.
 *
 * 돌고 있는 탭은 건드리지 않는다.
 */
async function sweepIsolatedRuns(scheduleId: string): Promise<void> {
  const store = scheduleStore;
  if (!store) return;
  const withTree = store.runs(scheduleId).filter((r) => r.worktree);
  const old = withTree.slice(KEEP_ISOLATED_RUNS);
  if (old.length === 0) return;
  const env = await cliDiscovery().buildEnv();
  for (const r of old) {
    if (r.tabId && sessions.isBusy(r.tabId)) continue;
    const removed = await worktreeRemove(env, r.worktree!, { force: true }).catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!removed.ok) {
      console.log(`[schedule] worktree를 그대로 둡니다(${r.worktree!.path}): ${removed.error}`);
      continue;
    }
    // 폴더가 없어진 탭은 열어 둘 이유가 없다.
    if (r.tabId) workspaces.deleteTab(r.tabId);
    store.updateRun(r.id, { worktree: undefined });
  }
}

/** 예약 한 회차를 실제로 띄운다. 격리 세션이면 worktree 를 만들고, 아니면 정해 둔 탭에 보낸다. */
async function dispatchSchedule(schedule: Schedule, run: Run): Promise<{ tabId: string }> {
  const wsId = scheduleWorkspaceId();
  if (!wsId) throw new Error(mt("schedules.error.workspaceFailed"));
  const base = cwdForTarget(schedule.target);
  if (!base) throw new Error(mt("schedules.msg.noFolder"));
  let tabId: string;
  // 실제로 돌 경로. 격리면 worktree 안, 아니면 예약에 적힌 폴더다.
  // 이걸 안 들고 다니면 configure 가 원본 경로로 덮어써 격리가 풀린다(실제로 그랬다).
  let runCwd = base;
  if (schedule.target.worktree) {
    await sweepIsolatedRuns(schedule.id);
    const env = await cliDiscovery().buildEnv();
    const r = await worktreeCreate(base, env, {
      rootDir: worktreeRootDir(),
      slug: worktreeSlug(schedule.name),
    });
    if (!r.ok) throw new Error(r.error);
    // 제목에 "· 예약" 을 붙이지 않는다. 이 탭은 "예약" 워크스페이스 안에 있어 사이드바에서
    // "예약 > 아침 브리핑 · 예약" 으로 두 번 읽힌다.
    const made = workspaces.createTab(wsId, { cwd: r.worktree.path, worktree: r.worktree, title: schedule.name });
    if (!made) {
      // 탭을 못 만들면 방금 만든 worktree 는 아무도 모르는 디렉터리로 남는다. 되돌린다.
      // 되돌리기까지 실패하면 경로를 사유에 적는다. 조용히 삼키면 사람이 모르는 폴더가 계속 쌓인다.
      const undo = await worktreeRemove(env, r.worktree, { force: true }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      throw new Error(
        undo.ok
          ? mt("schedules.error.sessionFailed")
          : mt("schedules.error.sessionFailedUndo", { path: r.worktree.path, detail: undo.error }),
      );
    }
    tabId = made;
    runCwd = r.worktree.path;
    scheduleStore?.updateRun(run.id, { worktree: r.worktree });
  } else {
    // 예약이 잡아 둔 제 탭에 회차를 쌓는다. 사용자가 닫았으면 다시 만든다.
    const pinned = schedule.pinnedTabId && workspaces.tab(schedule.pinnedTabId) ? schedule.pinnedTabId : null;
    if (pinned) {
      tabId = pinned;
      // 맥락은 이어 가지 않는다 — 회차마다 쌓이면 비용이 매일 오르고 결국 한도에 부딪힌다.
      // 지난 회차는 탭 기록에 그대로 남으므로 스크롤해서 비교할 수 있다.
      sessions.resetSession(tabId);
    } else {
      // cwd 를 명시한다. 그냥 만들면 활성 탭의 작업 경로를 물려받아,
      // 선조건은 워크스페이스 기본 경로에서 검사하고 실제 작업은 사용자가 보고 있던
      // 다른 worktree 에서 하는 일이 생긴다.
      const made = workspaces.createTab(wsId, { cwd: base, title: schedule.name });
      if (!made) throw new Error(mt("schedules.error.sessionFailed"));
      tabId = made;
      scheduleStore?.upsertSchedule({ ...schedule, pinnedTabId: made });
    }
  }
  // 어디서 돌았는지 먼저 남긴다. 보내기가 실패해도 만들어 둔 세션을 이력에서 찾아갈 수 있어야 한다.
  scheduleStore?.updateRun(run.id, { tabId });
  // 권한·provider 는 예약에 박아 둔 것을 강제한다. 새로 만든 세션이라 남의 작업에 닿지 않는다.
  // 모델도 예약에 적힌 것으로 못박는다. 비워 두면 활성 탭에서 물려받은 모델로 돈다.
  sessions.configure(tabId, { provider: schedule.provider, policy: schedule.policy, cwd: runCwd, model: schedule.model ?? "" });
  const sent = await handleChatSend(tabId, { text: schedule.prompt, images: [] });
  if (!sent.ok) throw new Error(sent.error);
  return { tabId };
}

/** 화면에 줄 예약 목록(다음 실행 시각과 최근 회차 포함). */
function scheduleSnapshot() {
  const store = scheduleStore;
  const engine = scheduleEngine;
  if (!store || !engine) return { schedules: [], runs: [] };
  return {
    schedules: store.schedules().map((s) => ({ ...s, nextRunAt: engine.nextRunAt(s) })),
    runs: store.schedules().flatMap((s) => store.runs(s.id).slice(0, 10)),
  };
}

/** 끝난 회차를 알린다. 사람이 안 보는 사이에 도는 일이라 결과는 알려 줘야 한다. */
function notifyScheduleRun(run: Run) {
  if (run.status === "completed" || run.status === "pending" || run.status === "running") return;
  const store = scheduleStore;
  const name = store?.schedule(run.scheduleId)?.name ?? mt("schedules.defaultName");
  if (run.status === "needs_action") {
    notify(mt("schedules.notify.needsAction", { name }), run.snapshot.prompt.slice(0, 80), run.tabId ?? undefined);
    return;
  }
  if (run.status.startsWith("skipped_")) return; // 건너뜀은 조용히 — 이력에 남는다
  notify(mt("schedules.notify.failed", { name }), run.reason ? msgText(mainI18n(), run.reasonMsg, run.reason) : run.status, run.tabId ?? undefined);
}

function startBackgroundJobWatcher() {
  if (jobWatcher) return;
  jobWatcher = new BackgroundJobWatcher({ onChanged: () => sendBackgroundJobs(), onFinished: onBackgroundJobFinished });
  void jobWatcher.start();
}

function sendAll(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

function notifyIfUnfocused(title: string, body: string, tabId?: string) {
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
  if (focused) return;
  notify(title, body, tabId);
}

/** macOS 알림. 클릭하면 창을 앞으로 가져오고(탭이 있으면 그 탭으로) 간다. */
function notify(title: string, body: string, tabId?: string) {
  if (!Notification.isSupported()) {
    console.log(`[notify] 이 환경은 알림을 지원하지 않습니다: ${title}`);
    return;
  }
  console.log(`[notify] ${title} — ${body.slice(0, 60)}`);
  const n = new Notification({ title, body: body.slice(0, 200), silent: false });
  n.on("click", () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (tabId && workspaces.tab(tabId)) workspaces.activateTab(tabId);
  });
  n.show();
}

// ===== Persistence + workspaces + sessions =====
// app.getPath 는 ready 전에도 userData 를 돌려주지만, 안전하게 whenReady 뒤에 만든다.

let store: Store;
let rendererState: RendererState;
let workspaces: WorkspaceService;
let sessions: SessionManager;
let usage: UsageScanner;
let terminals: TerminalManager;
let slashCommands: SlashCommandCache;
let attention: AttentionTracker;
let snippets: SnippetStore;
let lsp: LspManager;
let searchIndex: SearchIndex;

const unknownCwd = () => mt("main.error.unknownCwd");

/** 외부 브라우저로 넘겨도 되는 URL(http/https/mailto). file:·javascript: 등은 거부. */
function isExternalUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url);
}

/**
 * <webview> 보안: 렌더러가 무엇을 요청하든 preload 없이, node 없이, 샌드박스로, http(s) 만 붙인다.
 * 웹뷰가 새 창을 열려 하면 같은 웹뷰에서 이동시킨다(팝업 없음).
 */
function hardenWebviews() {
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event, prefs, params) => {
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      if (!/^https?:\/\//i.test(params.src ?? "")) event.preventDefault();
    });
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void contents.loadURL(url);
        return { action: "deny" };
      });
      contents.on("will-navigate", (event, url) => {
        if (!/^https?:\/\//i.test(url)) event.preventDefault();
      });
    }
  });
}
const unapprovedDir = () => mt("main.error.unapprovedDir");

/**
 * 사용자가 실제로 고른 루트 디렉토리들(네이티브 디렉토리 선택 창) + 시작 시 모델에 이미 있던 경로 + 앱이 만드는 worktree 루트.
 * 탭 cwd·워크스페이스 경로를 바꾸는 IPC 는 이 안의 경로만 받는다 — 그래야 knownCwds() 가 렌더러 마음대로 늘어나지 않는다.
 */
const approvedRoots = new Set<string>();
/** 에디터의 HTML 을 인앱 브라우저로 보여 주는 로컬 정적 서버(처음 쓸 때 뜬다). */
const previewServer = new PreviewServer();
/** 검증 실행기 — 결과는 verify 이벤트로 탭 기록에 남는다(sessions 가 준비된 뒤 note 로 이어진다). */
const verifyRunner = new VerifyRunner((tabId, event) => sessions?.note(tabId, event));
/** 오케스트레이션(Run/Task/Dispatch). registerIpc 에서 세션·워크스페이스가 준비된 뒤 만든다. */
let orchestrator: Orchestrator | null = null;
/** 완료 알림을 이미 보낸 Run. */
const notifiedRuns = new Set<string>();
/** `sudal` CLI 가 붙는 제어 소켓. registerIpc 뒤(세션·워크스페이스가 준비된 뒤) startControlServer 로 띄운다. */
let controlServer: ControlServer | null = null;

/** 동봉된 CLI 디렉토리(sudal.cjs·skill-guide.md·skill-stub.md). 패키지면 Contents/Resources/cli, 개발 실행이면 저장소의 cli/. */
function cliDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "cli") : join(app.getAppPath(), "cli");
}

async function startControlServer() {
  // 지난 실행이 비정상 종료해 남긴 tmp 소켓: control.json 이 가리키는 것이 소켓 파일이고 아무도 안 받으면 지운다.
  try {
    const old = JSON.parse(readFileSync(join(app.getPath("userData"), "control.json"), "utf8")) as { socket?: string };
    if (old.socket && old.socket !== join(app.getPath("userData"), "control.sock") && existsSync(old.socket) && statSync(old.socket).isSocket()) {
      await new Promise<void>((done) => {
        const c = createConnection(old.socket!);
        c.once("connect", () => {
          c.destroy();
          done();
        });
        c.once("error", () => {
          rmSync(old.socket!, { force: true });
          done();
        });
      });
    }
  } catch {
    /* 없거나 못 읽음 */
  }
  const server = new ControlServer(
    {
      version: app.getVersion(),
      state: () => workspaces.state(),
      addWorkspace: (path) => workspaces.addWorkspace(path),
      createTab: (workspaceId) => workspaces.createTab(workspaceId),
      configure: (tabId, patch) => void sessions.configure(tabId, patch),
      renameTab: (tabId, title) => workspaces.renameTab(tabId, title),
      activateTab: (tabId) => workspaces.activateTab(tabId),
      closeTab: (tabId) => workspaces.closeTab(tabId),
      snapshot: (tabId) => {
        const s = sessions.snapshot(tabId);
        return { status: s.status, provider: s.provider, cwd: s.cwd, sessionId: s.sessionId, controller: s.controller, pending: s.pendingPrompts.length, limitWait: s.limitWait !== null };
      },
      events: (tabId) => sessions.events(tabId),
      send: (tabId, text) => handleChatSend(tabId, { text }),
      abort: (tabId) => void sessions.abort(tabId),
      verify: (tabId, commands) => startVerify(tabId, commands),
      verifyAbort: (tabId) => verifyRunner.abort(tabId),
      fanout: (tabId, req) => startFanout(tabId, req),
      orchestrator: () => orchestrator!,
      approveRoot: (path) => approveRoot(path),
      openFile: (tabId, path, line) => deliverControlOpen({ kind: "file", tabId, path, line }),
      openBrowser: (tabId, url) => deliverControlOpen({ kind: "browser", tabId, url }),
      runInBrowser: (tabId, script) => runInBrowser(tabId, script),
      guide: (name) => {
        if (name !== "sudal-cli") return null;
        try {
          return readFileSync(join(cliDir(), "skill-guide.md"), "utf8");
        } catch {
          return null;
        }
      },
      schedules: () => schedulesApi(),
    },
    join(app.getPath("userData"), "control.sock"),
    join(tmpdir(), `sudal-${process.pid}.sock`),
  );
  try {
    await server.start();
    controlServer = server;
    // CLI 는 userData 의 control.json 으로 소켓을 찾는다(소켓이 tmp 로 밀려났을 때·userData 가 다른 인스턴스일 때).
    writeFileSync(join(app.getPath("userData"), "control.json"), JSON.stringify({ socket: server.socketPath, pid: process.pid, version: app.getVersion() }, null, 2));
    console.log("[control] 제어 소켓:", server.socketPath);
  } catch (e) {
    console.error("[control] 제어 소켓을 열지 못했습니다:", e);
  }
}

/** 리뷰 카드에 저장하는 앱 문구: 문장(text)과 사전 키(textMsg)를 함께. */
function reviewText(key: MsgKey): { text: string; textMsg: Msg } {
  const m = appMsg(key);
  return { text: m.message, textMsg: m.msg };
}

/** 팬아웃 세션 카드에 저장하는 앱 문구: 문장(error)과 사전 키(errorMsg)를 함께. */
function fanoutError(key: MsgKey): { error: string; errorMsg: Msg } {
  const m = appMsg(key);
  return { error: m.message, errorMsg: m.msg };
}

/**
 * 교차 리뷰: 이 탭의 작업 트리 diff 를 다른 provider 의 새 탭에 보내고, 그 탭의 첫 답이 오면 이 탭에 review 카드로 남긴다.
 * 리뷰 탭은 화면을 빼앗지 않고(활성 탭 복원) 정책은 ask(읽기 전용에 가깝게). 결과 대기는 main 이 하므로 사용자가 탭을 옮겨도 이어진다.
 */
async function startCrossReview(tabId: string): Promise<{ ok: true; reviewTabId: string; scope: string } | { ok: false; error: string }> {
  const tab = workspaces.tab(tabId);
  if (!tab) return { ok: false, error: mt("main.error.tabNotFound") };
  const snap = sessions.snapshot(tabId);
  if (!snap.cwd) return { ok: false, error: mt("main.error.cwdRequired") };
  const cwd = snap.cwd;
  const env = await cliDiscovery().buildEnv();
  const changes = await gitChanges(cwd, env);
  if (changes.length === 0) return { ok: false, error: mt("main.review.noChanges") };
  const diff = await gitDiffFor(cwd, env, changes.map((c) => c.path));
  if (!diff.trim()) return { ok: false, error: mt("main.review.diffUnreadable") };
  const reviewer = otherProvider(snap.provider);
  const originTitle = tabTitleOf(tabId);
  const prevActive = workspaces.state().model.activeTabId;
  const reviewTabId = workspaces.createTab(tab.workspaceId);
  if (!reviewTabId) return { ok: false, error: mt("main.review.tabCreateFailed") };
  // model 은 명시적으로 비운다 — 새 탭이 활성 탭의(다른 provider 의) 모델명을 물려받지 않게
  sessions.configure(reviewTabId, { cwd, provider: reviewer, policy: "ask", model: undefined });
  workspaces.renameTab(reviewTabId, reviewTabTitle(mt, originTitle));
  if (prevActive && prevActive !== reviewTabId) workspaces.activateTab(prevActive);
  const scopeParams = reviewScopeParams(changes);
  const scope = mt("main.msg.reviewScope", scopeParams);
  const scopeMsg: Msg = { key: "main.msg.reviewScope", params: scopeParams };
  sessions.note(tabId, { type: "review", ts: Date.now(), reviewer, reviewTabId, status: "requested", text: "", scope, scopeMsg });
  const since = sessions.events(reviewTabId).length;
  const sent = await handleChatSend(reviewTabId, { text: buildReviewPrompt(mt, { originTitle, author: snap.provider, changes: changes.map((c) => ({ path: c.path, kind: c.kind })), diff }) });
  if (!sent.ok) {
    sessions.note(tabId, { type: "review", ts: Date.now(), reviewer, reviewTabId, status: "failed", text: sent.error, scope, scopeMsg });
    return { ok: false, error: sent.error };
  }
  void (async () => {
    // 리뷰 탭의 턴이 끝날 때까지(최대 30분) 기다렸다가 답을 옮겨 적는다
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      // 리뷰 탭은 사람이 안 본다: 읽기만 하는 요청은 허용하고 나머지는 거부해 리뷰가 멈추지 않게 한다
      for (const req of sessions.pendingPermissions(reviewTabId)) {
        const decision = reviewPermissionDecision(req.tool, req.input);
        console.log(`[review] ${reviewTabId} 권한 자동 판정 ${decision}: ${req.tool} ${JSON.stringify(req.input).slice(0, 120)}`);
        sessions.answerPermission(reviewTabId, req.requestId, { behavior: decision });
      }
      const st = sessions.snapshot(reviewTabId);
      // 사용 한도로 재시도를 기다리는 중(limitWait)도 아직 끝난 게 아니다
      const busy = st.status === "running" || st.status === "queued" || st.status === "waiting_permission" || st.limitWait !== null;
      const turned = sessions.events(reviewTabId).slice(since).some((e) => e.type === "turn_result");
      if (!busy && turned) {
        const text = lastReplyText(sessions.events(reviewTabId));
        const failed = st.status === "error" && !text;
        sessions.note(tabId, { type: "review", ts: Date.now(), reviewer, reviewTabId, status: failed ? "failed" : "done", ...(text ? { text } : reviewText("main.msg.reviewNoReply")), scope, scopeMsg });
        return;
      }
      if (!busy && st.status === "error") {
        sessions.note(tabId, { type: "review", ts: Date.now(), reviewer, reviewTabId, status: "failed", ...reviewText("main.msg.reviewTabError"), scope, scopeMsg });
        return;
      }
      if (Date.now() - started > 30 * 60_000) {
        sessions.note(tabId, { type: "review", ts: Date.now(), reviewer, reviewTabId, status: "failed", ...reviewText("main.msg.reviewTimeout"), scope, scopeMsg });
        return;
      }
    }
  })();
  return { ok: true, reviewTabId, scope };
}

/**
 * 검증: 워크스페이스에 저장한 명령(없으면 commands 인자)을 탭의 cwd 에서 순서대로 돌린다. 결과는 verify 카드로 탭에 남는다.
 * commands 를 주면 그것을 저장하지는 않는다 — 저장은 렌더러가 ws.update 로 따로 한다.
 */
async function startVerify(tabId: string, commands?: string[]): Promise<VerifyStartResult> {
  const tab = workspaces.tab(tabId);
  if (!tab) return { ok: false, error: mt("main.error.tabNotFound") };
  const cwd = sessions.snapshot(tabId).cwd;
  if (!cwd) return { ok: false, error: mt("main.error.cwdRequired") };
  if (!existsSync(cwd)) return { ok: false, error: mt("main.verify.cwdMissing", { cwd }) };
  const ws = workspaces.state().model.workspaces.find((w) => w.id === tab.workspaceId);
  const list = commands && commands.length > 0 ? commands : (ws?.verifyCommands ?? []);
  if (list.length === 0) return { ok: false, error: mt("main.verify.noCommands") };
  const env = await cliDiscovery().buildEnv();
  return verifyRunner.start({ tabId, cwd, commands: list, env });
}

/** 원래 탭 기록에서 fanout 블록(최신 상태)을 찾는다. */
function fanoutBlock(tabId: string, fanoutId: string): FanoutEvent | null {
  const events = sessions.events(tabId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "fanout" && e.fanoutId === fanoutId) return e;
  }
  return null;
}

function noteFanout(tabId: string, e: FanoutEvent, patch: Partial<Omit<FanoutEvent, "type" | "ts">>): FanoutEvent {
  const next: FanoutEvent = { ...e, ...patch, ts: Date.now() };
  sessions.note(tabId, next);
  return next;
}

/**
 * 팬아웃: 지시 하나를 격리 세션(worktree) N개에 동시에 보낸다. 각 탭은 화면을 빼앗지 않고(활성 탭 복원), 결과는 원래 탭의 fanout 카드에.
 * 각 세션이 끝나면 worktree 의 변경 통계와 답변 앞부분을 카드에 적는다. 권한 대기(ask 정책)는 waiting 으로 표시만 한다 — 사람이 그 탭에서 답한다.
 */
async function startFanout(tabId: string, req: FanoutStartDto): Promise<FanoutStartResult> {
  const v = validateFanoutRequest(mt, req);
  if (!v.ok) return v;
  const tab = workspaces.tab(tabId);
  if (!tab) return { ok: false, error: mt("main.error.tabNotFound") };
  const cwd = sessions.snapshot(tabId).cwd;
  if (!cwd) return { ok: false, error: mt("main.error.cwdRequired") };
  const env = await cliDiscovery().buildEnv();
  const prevActive = workspaces.state().model.activeTabId;
  const fanoutId = randomUUID();
  const variants: FanoutVariant[] = [];
  const meta: { tabId: string; since: number }[] = [];
  for (let i = 0; i < v.variants.length; i++) {
    const spec = v.variants[i];
    const label = variantLabel(i);
    const wt = await worktreeCreate(cwd, env, { rootDir: worktreeRootDir(), slug: worktreeSlug(`fanout-${label.toLowerCase()}-${spec.provider}`) });
    if (!wt.ok) {
      // 이미 만든 세션은 되돌린다
      for (const m of meta) {
        const t = workspaces.tab(m.tabId)?.worktree;
        if (t) await worktreeRemove(env, t, { force: true });
        workspaces.deleteTab(m.tabId);
      }
      return { ok: false, error: mt("main.fanout.worktreeFailed", { label, detail: wt.error }) };
    }
    const vTab = workspaces.createTab(tab.workspaceId, { cwd: wt.worktree.path, worktree: wt.worktree, title: fanoutTabTitle(mt, label, spec.provider, tab.title?.trim() || null) });
    if (!vTab) return { ok: false, error: mt("main.fanout.tabCreateFailed") };
    // model 은 항상 명시(없으면 비움) — 활성 탭의 다른 provider 모델명이 물려지지 않게
    sessions.configure(vTab, { cwd: wt.worktree.path, provider: spec.provider, policy: v.policy, model: spec.model });
    variants.push({ tabId: vTab, label, provider: spec.provider, ...(spec.model ? { model: spec.model } : {}), status: "running" });
    meta.push({ tabId: vTab, since: sessions.events(vTab).length });
  }
  if (prevActive && prevActive !== tabId) workspaces.activateTab(prevActive);
  else workspaces.activateTab(tabId);
  let ev: FanoutEvent = { type: "fanout", ts: Date.now(), fanoutId, status: "running", prompt: excerpt(v.prompt, FANOUT_PROMPT_EXCERPT), policy: v.policy, variants };
  sessions.note(tabId, ev);
  for (const m of meta) {
    const sent = await handleChatSend(m.tabId, { text: v.prompt });
    if (!sent.ok) ev = noteFanout(tabId, ev, { variants: ev.variants.map((x) => (x.tabId === m.tabId ? { ...x, status: "failed", error: sent.error } : x)) });
  }
  const started = Date.now();
  void (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = fanoutBlock(tabId, fanoutId) ?? ev;
      if (cur.status !== "running") return;
      let changed = false;
      const next = cur.variants.slice();
      for (let i = 0; i < next.length; i++) {
        const x = next[i];
        if (x.status !== "running" && x.status !== "waiting") continue;
        const m = meta.find((mm) => mm.tabId === x.tabId);
        if (!m) continue;
        const st = sessions.snapshot(x.tabId);
        const busy = st.status === "running" || st.status === "queued" || st.status === "waiting_permission" || st.limitWait !== null;
        const turned = sessions.events(x.tabId).slice(m.since).some((e) => e.type === "turn_result");
        if (st.status === "waiting_permission" && x.status !== "waiting") {
          next[i] = { ...x, status: "waiting" };
          changed = true;
        } else if (busy && st.status !== "waiting_permission" && x.status === "waiting") {
          next[i] = { ...x, status: "running" };
          changed = true;
        } else if (!busy && (turned || st.status === "error")) {
          const wt = workspaces.tab(x.tabId)?.worktree;
          const snap = wt ? await worktreeSnapshot(env, wt) : null;
          const changes = snap?.ok ? snap.changes : [];
          const text = lastReplyText(sessions.events(x.tabId));
          const failed = st.status === "error" && !text;
          next[i] = { ...x, status: failed ? "failed" : "done", ...changeStats(changes), summary: excerpt(text, FANOUT_SUMMARY_EXCERPT), durationMs: Date.now() - started, ...(failed ? fanoutError("main.msg.fanoutSessionError") : {}) };
          changed = true;
        } else if (Date.now() - started > 90 * 60_000) {
          next[i] = { ...x, status: "failed", ...fanoutError("main.msg.fanoutTimeout") };
          changed = true;
        }
      }
      if (!changed) continue;
      // 위의 await 동안 정리(cleanup)·채택이 끝났을 수 있다 — 최신 기록 위에 "아직 진행 중이던" 세션만 덮어쓴다
      const latest = fanoutBlock(tabId, fanoutId) ?? cur;
      if (latest.status !== "running") return;
      const merged = latest.variants.map((lv) => {
        const nv = next.find((n) => n.tabId === lv.tabId);
        return nv && (lv.status === "running" || lv.status === "waiting") ? nv : lv;
      });
      ev = noteFanout(tabId, latest, { variants: merged, ...(allSettled(merged) ? { status: "done" } : {}) });
    }
  })();
  return { ok: true, fanoutId, tabIds: meta.map((m) => m.tabId) };
}

async function fanoutCompare(tabId: string, fanoutId: string): Promise<FanoutCompareDto> {
  const ev = fanoutBlock(tabId, fanoutId);
  if (!ev) throw new Error(mt("main.fanout.recordNotFound"));
  const env = await cliDiscovery().buildEnv();
  const variants: FanoutCompareDto["variants"] = [];
  for (const x of ev.variants) {
    const wt = workspaces.tab(x.tabId)?.worktree;
    const exists = !!wt && existsSync(wt.path);
    // 채택 패치와 같은 기준(merge-base 이후 전부: 커밋 + 작업 트리 + 새 파일). 파일이 아주 많으면 앞의 것만 diff 를 만든다
    const snap = exists ? await worktreeSnapshot(env, wt, { diffs: true, maxDiffFiles: 60 }) : null;
    variants.push({ tabId: x.tabId, label: x.label, provider: x.provider, status: x.status, summary: x.summary, exists, changes: snap?.ok ? snap.changes : [], diffs: snap?.ok ? snap.diffs : {} });
  }
  return { fanoutId, variants };
}

async function fanoutAdopt(tabId: string, fanoutId: string, variantTabId: string): Promise<FanoutAdoptResult> {
  const ev = fanoutBlock(tabId, fanoutId);
  if (!ev) return { ok: false, error: mt("main.fanout.recordNotFound") };
  const x = ev.variants.find((v) => v.tabId === variantTabId);
  if (!x) return { ok: false, error: mt("main.fanout.variantNotFound") };
  if (x.status === "running" || x.status === "waiting") return { ok: false, error: mt("main.fanout.variantBusy") };
  const wt = workspaces.tab(variantTabId)?.worktree;
  if (!wt || !existsSync(wt.path)) return { ok: false, error: mt("main.fanout.variantNoWorktree") };
  const cwd = sessions.snapshot(tabId).cwd;
  if (!cwd) return { ok: false, error: mt("main.fanout.originNoCwd") };
  if (sessions.isBusy(tabId)) return { ok: false, error: mt("main.fanout.originBusy") };
  const env = await cliDiscovery().buildEnv();
  // 팬아웃을 만든 저장소에만 적용한다 — 그 사이 탭의 작업 경로가 다른 저장소로 바뀌었으면 거부
  const top = (await gitInfo(cwd, env))?.root ?? null;
  const same = (a: string | null, b: string) => {
    try {
      return !!a && realpathSync(a) === realpathSync(b);
    } catch {
      return false;
    }
  };
  if (!same(top, wt.repo)) return { ok: false, error: mt("main.fanout.wrongRepo", { repo: wt.repo, cwd }) };
  const p = await worktreePatch(env, wt);
  if (!p.ok) return p;
  const a = await applyPatch(env, cwd, p.patch);
  if (!a.ok) return a;
  noteFanout(tabId, ev, { adoptedTabId: variantTabId });
  return a;
}

async function fanoutCleanup(tabId: string, fanoutId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ev = fanoutBlock(tabId, fanoutId);
  if (!ev) return { ok: false, error: mt("main.fanout.recordNotFound") };
  const env = await cliDiscovery().buildEnv();
  const errors: string[] = [];
  const variants = ev.variants.slice();
  for (let i = 0; i < variants.length; i++) {
    const x = variants[i];
    if (x.status === "cleaned") continue;
    if (sessions.isBusy(x.tabId)) sessions.abort(x.tabId);
    const wt = workspaces.tab(x.tabId)?.worktree;
    if (wt) {
      const r = await worktreeRemove(env, wt, { force: true });
      if (!r.ok) {
        errors.push(`${x.label}: ${r.error}`);
        continue;
      }
      workspaces.clearWorktree(x.tabId);
      sessions.configure(x.tabId, { cwd: wt.repo });
    }
    workspaces.closeTab(x.tabId);
    variants[i] = { ...x, status: "cleaned" };
  }
  noteFanout(tabId, ev, { variants, ...(variants.every((v) => v.status === "cleaned") ? { status: "cleaned" } : {}) });
  return errors.length ? { ok: false, error: errors.join(" / ") } : { ok: true };
}

/** 저장한 명령이 없을 때 탭 cwd 의 매니페스트에서 추천. */
function verifySuggestions(tabId: string): string[] {
  const cwd = sessions.snapshot(tabId).cwd;
  return cwd && existsSync(cwd) ? suggestForCwd(cwd) : [];
}

/** 렌더러에 화면 동작을 전달한다. macOS 에서 창을 다 닫아 둔 상태면 창을 만든 뒤 렌더러가 준비되면 보낸다. */
function deliverControlOpen(req: ControlOpenDto) {
  if (BrowserWindow.getAllWindows().length > 0) {
    sendAll(IPC.controlOpen, req);
    return;
  }
  mainWindow = createWindow();
  const win = mainWindow;
  win.webContents.once("did-finish-load", () => {
    // 렌더러는 상태를 hydrate 한 뒤 App 을 그리고 그때 리스너를 단다 — 잠깐 뒤에 보낸다
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send(IPC.controlOpen, req);
    }, 1500);
  });
}


/** ~/.local/bin/sudal — 앱의 Electron 을 node 로 써서 동봉 CLI 를 실행하는 셸 스크립트. */
async function installCliShim(): Promise<{ ok: true; path: string; onPath: boolean; hint?: string } | { ok: false; error: string }> {
  try {
    const dir = join(app.getPath("home"), ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "sudal");
    const script = [
      "#!/bin/sh",
      mt("main.cli.shimComment"),
      // 이 앱의 userData(개발 실행은 이름이 달라 경로도 다르다). 이미 정해 두었으면 그것을 존중한다.
      // 큰따옴표 안의 기본값이라 큰따옴표 규칙으로 감싼다(작은따옴표로 감쌌다 떼면 $ · 백틱이 그대로 풀린다).
      `: "\${SUDAL_USERDATA:=${app.getPath("userData").replace(/[\\"$`]/g, "\\$&")}}"`,
      "export SUDAL_USERDATA",
      `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(join(cliDir(), "sudal.cjs"))} "$@"`,
      "",
    ].join("\n");
    writeFileSync(target, script, { mode: 0o755 });
    chmodSync(target, 0o755);
    // 설치는 됐어도 로그인 셸 PATH 에 ~/.local/bin 이 없으면 터미널에서 못 찾는다 — 그 자리에서 알려 준다
    const shellPath = (await cliDiscovery().buildEnv()).PATH ?? "";
    const onPath = shellPath.split(":").some((p) => p.replace(/\/+$/, "") === dir);
    return {
      ok: true,
      path: target,
      onPath,
      ...(onPath ? {} : { hint: mt("main.cli.pathHint", { dir }) }),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 옛 이름(Atelier)으로 설치해 둔 CLI·스킬을 새 이름으로 바꾸고, 이미 만든 worktree 를 계속 쓰게 한다.
 * 옛 것이 남아 있을 때만 일하므로 매번 불러도 된다. 개발 실행과 userData 를 따로 지정한 검증용 인스턴스는
 * 설치본의 것을 건드리지 않는다.
 */
function adoptLegacyInstall(): void {
  if (!app.isPackaged || dirname(app.getPath("userData")) !== app.getPath("appData")) return;
  try {
    const home = app.getPath("home");
    const found = removeLegacyInstall(home, process.env.CODEX_HOME || join(home, ".codex"));
    if (found.cli) void installCliShim();
    for (const agent of found.skills) installSkillStub(agent);
    const settings = store.loadSettings<Record<string, unknown>>({});
    const worktreeDir = legacyWorktreeDir(home);
    if (settings.worktreeDir === undefined && worktreeDir) store.saveSettings({ ...settings, worktreeDir });
  } catch (e) {
    console.error("[app] 옛 이름 설치 정리 실패:", e);
  }
}

/** 설치 상태: 파일이 있는지, 셸 스크립트가 이 앱을 가리키는지, PATH 에 있는지, 스텁이 동봉본과 같은지. */
async function installStatus(): Promise<InstallStatusDto> {
  const dir = join(app.getPath("home"), ".local", "bin");
  const cliPath = join(dir, "sudal");

  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const cliText = read(cliPath);
  const shellPath = (await cliDiscovery().buildEnv()).PATH ?? "";
  const bundledStub = read(join(cliDir(), "skill-stub.md"));
  return {
    cli: {
      path: cliPath,
      installed: cliText !== null,
      current: cliText !== null && cliText.includes(shellQuote(process.execPath)) && cliText.includes(shellQuote(join(cliDir(), "sudal.cjs"))),
      onPath: shellPath.split(":").some((p) => p.replace(/\/+$/, "") === dir),
    },
    skills: skillTargets().map((t) => {
      const text = read(t.path);
      return { agent: t.agent, label: t.label, path: t.path, available: existsSync(t.home), installed: text !== null, current: text !== null && bundledStub !== null && text === bundledStub };
    }),
  };
}

/** 스킬 스텁을 둘 곳: 에이전트마다 자기 홈의 skills 디렉토리. 그 에이전트 홈이 없으면(설치 안 됨) 건너뛴다. */
function skillTargets(): { agent: "claude" | "codex"; label: string; home: string; path: string }[] {
  const home = app.getPath("home");
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  return [
    { agent: "claude", label: "Claude Code", home: join(home, ".claude"), path: join(home, ".claude", "skills", "sudal-cli", "SKILL.md") },
    { agent: "codex", label: "Codex CLI", home: codexHome, path: join(codexHome, "skills", "sudal-cli", "SKILL.md") },
  ];
}

function installSkillStub(agent?: "claude" | "codex"): { ok: true; paths: string[]; skipped: string[] } | { ok: false; error: string } {
  try {
    const stub = readFileSync(join(cliDir(), "skill-stub.md"), "utf8");
    const paths: string[] = [];
    const skipped: string[] = [];
    for (const t of skillTargets().filter((x) => !agent || x.agent === agent)) {
      if (!existsSync(t.home)) {
        skipped.push(t.label);
        continue;
      }
      mkdirSync(join(t.path, ".."), { recursive: true });
      writeFileSync(t.path, stub);
      paths.push(t.path);
    }
    if (paths.length === 0) return { ok: false, error: mt("main.cli.noAgents") };
    return { ok: true, paths, skipped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
function approveRoot(dir: string) {
  approvedRoots.add(resolve(dir));
}
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
/** 승인된 루트이거나 그 안의 경로인지(심링크는 실제 경로로도 비교). */
function isApprovedDir(dir: string): boolean {
  const p = resolve(dir);
  const pr = realOrSelf(p);
  for (const root of approvedRoots) {
    if (isWithin(root, p) || isWithin(realOrSelf(root), pr)) return true;
  }
  return false;
}

/**
 * 렌더러가 보낸 cwd 가 실제 탭·워크스페이스의 것인지. 파일 쓰기·조작과 언어 서버는 이 cwd 의 저장소를 경계로 삼으므로,
 * 렌더러가 임의의 cwd(예: "/")로 경계를 넓히지 못하게 한다. (탭 cwd 자체는 isApprovedDir 로 걸러 넣는다.)
 */
function isKnownCwd(cwd: string): boolean {
  return workspaces.knownCwds().has(cwd);
}
/** 알려진 cwd 이거나 그 안의 디렉토리인지(파일 트리는 하위 디렉토리를 나열한다). */
function isInsideKnownCwd(dir: string): boolean {
  const p = resolve(dir);
  const pr = realOrSelf(p);
  for (const k of workspaces.knownCwds()) if (isWithin(k, p) || isWithin(realOrSelf(k), pr)) return true;
  return false;
}

/** 지난 실행이 남긴 훅 로그(비정상 종료 등)를 시작 시 비운다. 디렉토리 경로를 그대로 돌려준다. */
function cleanHookLogDir(dir: string): string {
  try {
    if (existsSync(dir)) for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  } catch {
    /* 무시 */
  }
  return dir;
}

/** 응답 필요 세션 수를 Dock 배지로. 0 이면 지운다. */
function updateDockBadge() {
  const n = attention.count();
  app.dock?.setBadge(n > 0 ? String(n) : "");
}

// ===== 사용량 =====

function pricing(): PricingEntry[] {
  return store.loadPricing<PricingEntry[]>() ?? DEFAULT_PRICING;
}

function usageStatus(): UsageStatusDto {
  const { codexRateLimit, ...scan } = usage.getStatus();
  return {
    ...scan,
    rateLimits: {
      claude: store.loadRateLimits().claude ?? null,
      codex: codexRateLimit,
    },
    customPricing: store.loadPricing() !== null,
    pricing: pricing(),
  };
}

function usageSettings(): UsageSettingsDto & { budgetAlertedMonth?: string } {
  return store.loadSettings<UsageSettingsDto & { budgetAlertedMonth?: string }>(
    { monthlyBudgetUsd: null },
  );
}

/** 앱 동작 설정. 파일의 값이 이상하면(범위 밖·모르는 값) 기본값으로 읽는다. */
/** 격리 세션·팬아웃·워커·예약이 worktree 를 만드는 곳. 사용자가 보고 에디터로 여는 코드라 보이는 곳에 둔다(설정에서 바꿀 수 있다). */
function worktreeRootDir(): string {
  const v = store.loadSettings<{ worktreeDir?: unknown }>({}).worktreeDir;
  return typeof v === "string" && isAbsolute(v) ? v : defaultWorktreeRootDir();
}
function defaultWorktreeRootDir(): string {
  return join(homedir(), "sudal", "worktrees");
}

function appSettings(): AppSettingsDto {
  const raw = store.loadSettings<Partial<AppSettingsDto>>({});
  const clamp = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const language = isLanguageSetting(raw.language) ? raw.language : LANGUAGE_SETTING_DEFAULT;
  return {
    theme: isThemeMode(raw.theme) ? raw.theme : "system",
    language,
    // "시스템 따라가기"는 앱 로케일(app.getLocale)이 아니라 macOS 의 선호 언어 목록을 본다
    resolvedLocale: resolveLocale(language, app.getPreferredSystemLanguages()),
    warmTarget: raw.warmTarget === "off" ? "off" : "active",
    sessionIdleMinutes: clamp(raw.sessionIdleMinutes, SESSION_IDLE_MINUTES_MIN, SESSION_IDLE_MINUTES_MAX, SESSION_IDLE_MINUTES_DEFAULT),
    // 환경변수는 설정 파일에 값이 없을 때의 기본값으로만 쓴다.
    maxConcurrent: clamp(raw.maxConcurrent, MAX_CONCURRENT_MIN, MAX_CONCURRENT_MAX, Number(process.env.WORKBENCH_MAX_CONCURRENT) || MAX_CONCURRENT_DEFAULT),
    notifyOnDone: isNotifyOnDone(raw.notifyOnDone) ? raw.notifyOnDone : NOTIFY_ON_DONE_DEFAULT,
    keepBrowserLogin: raw.keepBrowserLogin !== false,
    worktreeDir: worktreeRootDir(),
    worktreeDirCustom: typeof raw.worktreeDir === "string" && isAbsolute(raw.worktreeDir),
    dataDir: app.getPath("userData"),
  };
}

function applyAppSettings(s: AppSettingsDto) {
  // 네이티브 UI(다이얼로그·컨텍스트 메뉴·스크롤바)도 같은 테마로. 렌더러는 자기 설정값으로 따로 칠한다.
  nativeTheme.themeSource = s.theme;
  const prevLanguage = mainI18n().language;
  setMainLocale(s.resolvedLocale);
  // 메뉴는 만들 때의 언어로 굳는다 — 언어가 바뀌면 다시 만든다(앱 시작 전 첫 호출에서는 아직 메뉴가 없다)
  if (mainI18n().language !== prevLanguage) {
    if (menuBuilt) {
      buildMenu();
      syncScheduleWorkspaceName();
    }
    // CLI 탐색 결과에는 번역된 오류 문구가 들어 있다 — 다음 조회에서 지금 언어로 다시 만든다
    discovery?.invalidate();
  }
  setClaudeSessionIdleMs(s.sessionIdleMinutes * 60_000);
  setCodexSessionIdleMs(s.sessionIdleMinutes * 60_000);
  sessions.setMaxConcurrent(s.maxConcurrent);
}

function querySummary(filter: UsageFilter) {
  // 인앱 세션 = 마킹 파일 + 현재 모델의 탭 sessionId (마킹 도입 전 세션도 포함되게).
  const inApp = store.loadInAppSessions();
  for (const t of workspaces.state().model.tabs)
    if (t.sessionId) inApp.add(t.sessionId);
  return summarizeUsage(usage.records(), filter, {
    pricing: pricing(),
    inAppSessionIds: inApp,
  });
}

/** 스캔이 끝날 때마다: 이번 달 추정 비용이 예산의 80% 를 넘으면 한 달에 한 번 알린다. */
function checkBudget() {
  const settings = usageSettings();
  if (!settings.monthlyBudgetUsd || settings.monthlyBudgetUsd <= 0) return;
  const now = Date.now();
  const month = new Date(now).toISOString().slice(0, 7);
  if (settings.budgetAlertedMonth === month) return;
  const s = querySummary({ ...periodRange("month", now), provider: "all" });
  const ratio = s.totals.costUsd / settings.monthlyBudgetUsd;
  if (ratio < 0.8) return;
  store.saveSettings({ ...settings, budgetAlertedMonth: month });
  if (Notification.isSupported()) {
    new Notification({
      title: mt("main.notify.budgetTitle"),
      body: mt("main.notify.budgetBody", { cost: s.totals.costUsd.toFixed(2), budget: settings.monthlyBudgetUsd.toFixed(2) }),
    }).show();
  }
}

function bootstrap() {
  store = new Store(app.getPath("userData"));
  adoptLegacyInstall();
  workspaces = new WorkspaceService(store, (state: WorkspaceStateDto) =>
    sendAll(IPC.wsChanged, state),
  );
  slashCommands = new SlashCommandCache(
    join(app.getPath("userData"), "slash-commands.json"),
    (cwd) => sendAll(IPC.chatCommandsChanged, cwd),
    (line) => console.log(`[commands] ${line}`),
  );
  searchIndex = new SearchIndex(store);
  // 지난 실행에서 사용자가 골랐던 경로들은 이미 승인된 것. worktree 는 앱이 그 루트 아래에 만든다.
  for (const c of workspaces.knownCwds()) approveRoot(c);
  // 예전(1.0 전)엔 worktree 를 앱 데이터 폴더 안에 만들었다 — 이미 만든 것도 계속 쓸 수 있게 옛 위치도 승인한다
  approveRoot(join(app.getPath("userData"), "worktrees"));
  approveRoot(worktreeRootDir());
  // 검증·개발용: 콜론으로 구분한 추가 루트(선택 창 없이 스크립트로 탭 cwd 를 정할 때)
  for (const r of (process.env.SUDAL_APPROVED_ROOTS ?? "").split(":")) if (r) approveRoot(r);
  lsp = new LspManager({
    env: () => sdkEnv(),
    resolveRoot: async (cwd) => repoRoot(cwd, await cliDiscovery().buildEnv()),
    // 설정: lspServerPaths[serverId]. 옛 단일 키 lspServerPath 는 typescript 것으로 읽는다.
    loadOverride: (serverId) => {
      const st = store.loadSettings<{ lspServerPath?: string | null; lspServerPaths?: Record<string, string | null> }>({});
      return st.lspServerPaths?.[serverId] ?? (serverId === "typescript" ? (st.lspServerPath ?? null) : null);
    },
    saveOverride: (serverId, path) => {
      const st = store.loadSettings<{ lspServerPath?: string | null; lspServerPaths?: Record<string, string | null> }>({});
      const { lspServerPath: _legacy, ...rest } = st;
      store.saveSettings({ ...rest, lspServerPaths: { ...(st.lspServerPaths ?? {}), [serverId]: path } });
    },
    onMessage: (id, message) => sendAll(IPC.lspMessage, id, message),
    onExit: (id) => sendAll(IPC.lspExit, id),
    log: (line) => console.log(line),
    // 검증용: 유휴 종료 대기 시간을 줄일 수 있다(기본 3분)
    idleMs: Number(process.env.SUDAL_LSP_IDLE_MS) > 0 ? Number(process.env.SUDAL_LSP_IDLE_MS) : undefined,
  });
  snippets = new SnippetStore(
    join(app.getPath("userData"), "snippets.json"),
    (items) => sendAll(IPC.snippetsChanged, items),
  );
  attention = new AttentionTracker({
    isViewing: (tabId) =>
      workspaces.isVisible(tabId) &&
      BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    onChange: (map) => {
      workspaces.onAttention();
      updateDockBadge();
      // 껐다 켜도 남게. "안 본 응답" 표시가 업데이트 한 번에 사라지면 믿을 수 없는 표시가 된다.
      store.saveAttention(map);
    },
  });
  attention.restore(store.loadAttention());
  workspaces.attentionSource = () => attention.snapshot();
  workspaces.attentionHooks = {
    viewed: (tabId) => attention.viewed(tabId),
    forget: (tabId) => attention.forget(tabId),
  };
  sessions = new SessionManager({
    emit(tabId, event) {
      sendAll(IPC.chatEvent, { tabId, event } satisfies ChatEventEnvelope);
      attention.event(tabId, event);
      if (scheduleEngine?.watches(tabId)) {
        // 회차의 끝은 이 신호들로만 판정한다(실측으로 고정한 규칙).
        if (event.type === "session") scheduleEngine.onSignal(tabId, { kind: "turn_started" });
        else if (event.type === "turn_result") scheduleEngine.onSignal(tabId, { kind: "result", isError: event.isError });
        else if (event.type === "permission_request") scheduleEngine.onSignal(tabId, { kind: "awaiting", count: 1 });
        else if (event.type === "permission_resolved") scheduleEngine.onSignal(tabId, { kind: "awaiting", count: 0 });
        // 오류는 원칙적으로 회차의 끝이다(대기열 취소도 fatal:false 로 온다 — 무시하면 영영 도는 중이 된다).
        // 다만 "재시도 예정" 은 예외다. 그걸 끝으로 읽으면 일은 계속 도는데 감시와 겹침 방지만 풀린다.
        else if (event.type === "error" && event.willRetry !== true)
          scheduleEngine.onSignal(tabId, { kind: "stream_ended", reason: event.message, expected: false, reasonMsg: event.msg });
      }
      // 어댑터가 직접 흘린 status(waiting_permission 등)도 사이드바 상태에 반영한다.
      if (event.type === "status") workspaces.onStatus(tabId, event.status);
      const title = tabTitleOf(tabId);
      // 권한 대기/완료는 창이 포커스를 잃었을 때 알림으로 알린다 (턴이 멈춰 있는 함정 대비).
      if (event.type === "permission_request") {
        const question = event.tool === "AskUserQuestion";
        notifyIfUnfocused(
          question ? mt("main.notify.questionWaiting", { title }) : mt("main.notify.permissionWaiting", { title }),
          question ? summarizeToolInput(event.tool, event.input) || mt("main.notify.questionBody") : (event.title ?? mt("main.notify.permissionBody", { tool: event.tool })),
          tabId,
        );
      } else if (event.type === "turn_result") {
        // 응답 완료 알림: 설정에 따라 항상 / 창이 포커스 밖이거나 다른 탭을 볼 때 / 끔
        const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
        const isActive = workspaces.isVisible(tabId);
        // 오케스트레이션 워커 탭의 턴은 알리지 않는다 — Run 의 완료·응답 필요는 Run 단위로 따로 알린다
        const supervised = orchestrator?.isSupervisedTab(tabId) ?? false;
        if (!supervised && shouldNotifyDone(appSettings().notifyOnDone, focused, isActive)) {
          const reply = lastReplyText(sessions.events(tabId)).replace(/\s+/g, " ").trim();
          notify(
            `${event.isError ? mt("main.notify.replyFailed") : mt("main.notify.replyDone")} · ${title}`,
            event.isError ? (event.errorText ? msgText(mainI18n(), event.errorMsg, event.errorText) : mt("main.notify.errorFallback")) : mt("main.notify.replyBody", { seconds: (event.durationMs / 1000).toFixed(0), reply: reply.slice(0, 140) || mt("main.notify.replyArrived") }),
            tabId,
          );
        }
      }
    },
    claudeRuntime,
    codexRuntime,
    store,
    warmEnabled: () => appSettings().warmTarget !== "off",
    resolveConfig: (tabId) => workspaces.resolveConfig(tabId),
    onMeta: (tabId, patch) => {
      // 앱에서 시작한 provider 세션은 트랜스크립트 스캔에서 "인앱" 으로 구분한다.
      if (patch.sessionId) store.markInAppSession(patch.sessionId);
      workspaces.onMeta(tabId, patch);
    },
    onStatus: (tabId, status) => {
      attention.status(tabId, status);
      workspaces.onStatus(tabId, status);
    },
    maxConcurrent: appSettings().maxConcurrent,
    log(tabId, line) {
      if (process.env.WORKBENCH_DEBUG_SDK)
        console.log(`[sdk:${tabId}] ${line}`);
    },
    onBackgroundTasks(tabId, sessionId, tasks, source) {
      if (process.env.WORKBENCH_DEBUG_SDK) console.log(`[bgtasks ${tabId.slice(0, 6)}] ${tasks.length}개 출처=${source}`);
      scheduleEngine?.onSignal(tabId, { kind: "tasks", count: tasks.length, source });
      // 늘 "살아 있는 전체" 라 갈아 끼운다. 턴이 끝난 뒤에도 오므로, 노는 것처럼 보이던 구간이 채워진다.
      bgTasks.replace(tabId, sessionId, sessions.snapshot(tabId).cwd ?? "", tasks);
      sendBackgroundJobs();
    },
    onStreamEnded(tabId, reason, expected) {
      scheduleEngine?.onSignal(tabId, { kind: "stream_ended", reason, expected });
    },
    onTaskFinished(tabId, note) {
      // 사용자가 세운 것(stopped)은 알리지 않는다 — 자기가 한 일이다. 시간 제한에 걸려 멈춘 것은 실패처럼 알린다.
      if (note.status === "stopped" && !note.timedOut) return;
      const job = bgTasks.recall(note.id);
      const ok = note.status === "completed";
      // 배너는 잠깐이다. 보고 있지 않았다면 탭에도 표시를 남긴다 — 자리를 비웠다 와도 알아보게.
      attention.backgroundJob(tabId, !ok);
      const what = job?.summary || job?.title || mt("main.notify.bgJob");
      notify(
        `${ok ? mt("main.notify.bgDone") : note.timedOut ? mt("main.notify.bgTimedOut") : mt("main.notify.bgFailed")} · ${tabTitleOf(tabId)}`,
        note.timedOut ? mt("main.notify.bgTimedOutBody", { what }) : note.summary || what,
        tabId,
      );
    },
    onSlashCommands: (cwd, patch) => slashCommands.apply(cwd, patch),
    onRateLimit: (provider, limit) => {
      // 이벤트는 걸린 창만 알려 주므로 이전 관측값과 합쳐 다른 창이 사라지지 않게 한다.
      const merged = mergeRateLimit(store.loadRateLimits()[provider], limit);
      if (merged) store.saveRateLimit(provider, merged);
      sendAll(IPC.usageChanged, null);
    },
    // 하이브리드 터미널 모드: 같은 세션 id 로 CLI 를 이 탭의 pty 에 띄운다.
    terminalCli: {
      async spawn(tabId, provider, cwd, sessionId, isNew, hookLog) {
        const env = await sdkEnv(tabId);
        if (provider === "claude") {
          const cli = await cliDiscovery().find("claude");
          if (!cli.installed || !cli.path)
            throw new Error(cli.error || mt("main.error.claudeCliMissing"));
          const args = sessionId
            ? isNew
              ? ["--session-id", sessionId]
              : ["--resume", sessionId]
            : [];
          if (hookLog) {
            // 권한 다이얼로그 등을 파일로 알려 주는 훅. 사용자 설정의 훅에 더해진다(덮어쓰지 않음).
            // 경로는 env 가 아니라 명령에 직접 박는다 — CLI 가 띄우는 자식 프로세스에 노출되지 않게.
            args.push(
              "--settings",
              claudeHookSettings(`cat >> ${shellQuote(hookLog)}`),
            );
          }
          const r = terminals.openCommand(
            `${tabId}:cli`,
            cwd,
            env,
            cli.path,
            args,
          );
          if (!r.ok) throw new Error(r.error ?? mt("main.error.cliLaunchFailed"));
        } else {
          const cli = await cliDiscovery().find("codex");
          if (!cli.installed || !cli.path)
            throw new Error(cli.error || mt("main.error.codexCliMissing"));
          const args = sessionId && !isNew ? ["resume", sessionId] : [];
          const r = terminals.openCommand(
            `${tabId}:cli`,
            cwd,
            env,
            cli.path,
            args,
          );
          if (!r.ok) throw new Error(r.error ?? mt("main.error.cliLaunchFailed"));
        }
      },
      kill(tabId) {
        terminals.close(`${tabId}:cli`);
      },
    },
    transcriptRoots: {
      claude: join(app.getPath("home"), ".claude", "projects"),
      codex: join(app.getPath("home"), ".codex", "sessions"),
    },
    hookLogDir: cleanHookLogDir(join(app.getPath("userData"), "hooks")),
    onSnapshot: (tabId, snapshot) => {
      sendAll(IPC.chatSnapshotChanged, snapshot);
      // 터미널 모드의 권한 대기(훅 감지)도 응답 필요 표시·알림에 태운다.
      // 터미널 모드 스냅샷만 본다 — 앱 모드에서 온 스냅샷이 열려 있는 앱 권한 표시를 지우지 않게.
      const waiting =
        snapshot.controller === "terminal" ? snapshot.terminalAttention : null;
      if (snapshot.controller === "terminal")
        attention.terminalPermission(tabId, !!waiting);
      if (waiting)
        notifyIfUnfocused(
          mt("main.notify.terminalPermissionWaiting", { title: tabTitleOf(tabId) }),
          `${waiting.tool} ${waiting.summary}`.trim(),
          tabId,
        );
    },
  });
  workspaces.attach(sessions);

  terminals = new TerminalManager({
    onData: (termId, data) => {
      sendAll(IPC.termData, termId, data);
      // 하이브리드 CLI("<tabId>:cli") 출력은 Codex 승인 프롬프트 감지에도 쓴다.
      if (termId.endsWith(":cli")) sessions.terminalOutput(termId.slice(0, -4), data);
    },
    onExit: (termId, exitCode, kind) => {
      sendAll(IPC.termExit, termId, exitCode);
      // 하이브리드 CLI("<tabId>:cli")가 끝나면 세션 제어를 앱으로 돌린다.
      if (kind === "command") sessions.terminalExited(termId.split(":")[0]);
    },
    onOpen: (info) => sendAll(IPC.termOpened, info),
    log: (line) => console.log(`[term] ${line}`),
  });

  // 통합 터미널(사용자 셸)에서 직접 띄운 claude/codex 를 알아채 채팅에 연결한다.
  const cliMonitor = new ShellCliMonitor({
    shells: () => terminals.shells(),
    onStart: (tabId, cli) => {
      console.log(`[term] ${tabId} 셸에서 ${cli.provider} 감지 pid=${cli.pid} cwd=${cli.cwd}${cli.resumeId ? ` resume=${cli.resumeId}` : ""}`);
      sessions.externalCliStarted(tabId, cli.provider, cli.cwd, cli.pid, cli.resumeId);
    },
    onExit: (tabId, pid) => {
      console.log(`[term] ${tabId} 셸의 CLI 종료 pid=${pid}`);
      sessions.externalCliExited(tabId);
    },
  });
  cliMonitor.start();

  usage = new UsageScanner({
    claudeDir: join(app.getPath("home"), ".claude", "projects"),
    codexDir: join(app.getPath("home"), ".codex", "sessions"),
    cachePath: join(app.getPath("userData"), "usage-cache.json"),
    onChange() {
      sendAll(IPC.usageChanged, null);
      checkBudget();
    },
  });
  // 시작 시 전체 1회(증분 캐시) + 이후 파일 변경 감시. 터미널에서 쓴 사용량도 30초 안에 반영.
  void usage.scan().then(() => usage.watch());

  // 개발 편의: 워크스페이스를 환경변수로 미리 추가 (디렉토리 선택 다이얼로그 생략).
  if (!app.isPackaged && process.env.WORKBENCH_DEV_CWD) {
    workspaces.addWorkspace(process.env.WORKBENCH_DEV_CWD);
  }
}

/**
 * "이 턴에서 분기": provider 세션을 그 턴까지 복사한 새 세션을 만들고, 그것을 이어 가는 새 탭을 연다. 원래 탭은 그대로다.
 * 새 탭은 분기가 성공한 뒤에만 만든다(실패하면 빈 탭이 남지 않게). worktree 정보는 넘기지 않는다 —
 * 새 탭을 닫을 때 원래 탭이 쓰는 worktree 를 지우자고 묻지 않게.
 */
async function forkTab(tabId: string, pointId: string): Promise<{ ok: true; tabId: string } | { ok: false; error: string }> {
  const src = sessions.forkSource(tabId, pointId);
  if (!src.ok) return src;
  const tab = workspaces.state().model.tabs.find((t) => t.id === tabId);
  if (!tab) return { ok: false, error: mt("main.error.tabNotFound") };
  let sessionId: string;
  try {
    sessionId =
      src.provider === "claude"
        ? await forkClaudeSession(await claudeRuntime(), src.point.sessionId, src.cwd, src.point.pointId)
        : await forkCodexThread(await codexRuntime(), {
            threadId: src.point.sessionId,
            lastTurnId: src.point.pointId,
            cwd: src.cwd,
            model: src.model,
            policy: src.policy,
            log: (l) => console.log(l),
          });
  } catch (e) {
    return { ok: false, error: mt("main.error.forkFailed", { detail: e instanceof Error ? e.message : String(e) }) };
  }
  const newTabId = workspaces.createTab(tab.workspaceId, { cwd: src.cwd, title: mt("main.tab.forkTitle", { title: tabTitleOf(tabId) }) });
  if (!newTabId) return { ok: false, error: mt("main.error.tabCreateFailed") };
  sessions.adoptFork(newTabId, { provider: src.provider, cwd: src.cwd, model: src.model, policy: src.policy, sessionId }, src.prefix);
  workspaces.activateTab(newTabId);
  return { ok: true, tabId: newTabId };
}

function tabTitleOf(tabId: string): string {
  const tab = workspaces.state().model.tabs.find((t) => t.id === tabId);
  return tab ? tabTitle(tab, mt("shared.untitledTab")) : mt("main.tab.fallbackTitle");
}

function attachmentsDir(): string {
  return join(app.getPath("userData"), "attachments");
}

/**
 * 떠나는 provider 에게 인계서를 쓰게 하고 그 답을 돌려준다.
 * 실패하면 빈 문자열 — 부르는 쪽이 기존 요약으로 조용히 돌아간다. 전환 자체를 막지는 않는다.
 */
async function askHandoffBrief(tabId: string): Promise<string> {
  const snap = sessions.snapshot(tabId);
  if (!snap.sessionId || snap.controller === "terminal") return "";
  if (sessions.events(tabId).length === 0) return "";
  const cwd = snap.cwd;
  if (!cwd) return "";
  const note = NOTE_FILE[snap.provider] ?? "AGENTS.md";
  const since = sessions.events(tabId).length;
  const sent = await handleChatSend(tabId, { text: handoffBriefPrompt(mt, snap.provider) });
  if (!sent.ok) return "";
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    // 이 턴은 사람이 보고 있지 않다 — 노트 파일에 덧붙이는 것만 열고 나머지는 거절해서 멈추지 않게 한다.
    for (const req of sessions.pendingPermissions(tabId)) {
      const decision = handoffNotePermission(req.tool, req.input, { cwd, note, exists: (p) => existsSync(p) });
      if (decision === "allow") console.log(`[handoff] ${tabId} ${note} 쓰기 허용: ${req.tool}`);
      sessions.answerPermission(tabId, req.requestId, { behavior: decision });
    }
    const st = sessions.snapshot(tabId);
    const busy = st.status === "running" || st.status === "queued" || st.status === "waiting_permission" || st.limitWait !== null;
    const turned = sessions.events(tabId).slice(since).some((e) => e.type === "turn_result");
    if (!busy && turned) return lastReplyText(sessions.events(tabId).slice(since)).trim();
    if (!busy && st.status === "error") return "";
    if (Date.now() - started > 3 * 60_000) return "";
  }
}

/**
 * 채팅 탭마다 지금 보고 있는 브라우저 웹뷰. 렌더러가 알려 준다 —
 * 어느 웹뷰가 어느 탭의 것인지는 화면 쪽만 안다. 에이전트의 browser.read/click/fill 이 이걸 쓴다.
 */
const browserViews = new Map<string, { id: number; url: string }>();

/** 등록된 브라우저에서 스크립트를 돌리고 결과를 받는다. 없거나 죽었으면 뚜렷하게 알린다. */
async function runInBrowser(tabId: string, script: string): Promise<Record<string, unknown>> {
  const reg = browserViews.get(tabId);
  if (!reg) throw new Error(mt("main.error.browserNotOpen"));
  const wc = webContents.fromId(reg.id);
  if (!wc || wc.isDestroyed()) {
    browserViews.delete(tabId);
    throw new Error(mt("main.error.browserClosed"));
  }
  const out = await wc.executeJavaScript(script, true);
  if (!out || typeof out !== "object") throw new Error(mt("main.error.browserNoResult"));
  const r = out as Record<string, unknown>;
  if (typeof r.error === "string") throw new Error(r.error);
  return r;
}

async function handleChatSend(
  tabId: string,
  payload: ChatSendDto,
): Promise<ChatSendResult> {
  const text = (payload?.text ?? "").trim();
  const prepared = prepareChatImages(payload?.images);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  if (!text && prepared.prepared.length === 0)
    return { ok: false, error: mt("main.error.emptyContent") };

  const saved = saveChatImages({
    baseDir: attachmentsDir(),
    threadId: tabId,
    images: prepared.prepared,
  });
  if (!saved.ok) return { ok: false, error: saved.error };

  const ts = Date.now();
  return sessions.send(tabId, text || mt("main.chat.imageOnly"), saved.stored, {
    type: "user_message",
    ts,
    id: `u-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    images: saved.stored.length > 0 ? toHistoryImages(saved.stored) : undefined,
  });
}

async function pickDirectory(
  sender: Electron.WebContents,
): Promise<string | null> {
  const dir = await pickDirectoryRaw(sender);
  if (dir) approveRoot(dir); // 사용자가 직접 고른 경로 — 이후 탭 cwd·워크스페이스 경로로 쓸 수 있다
  return dir;
}

async function pickDirectoryRaw(
  sender: Electron.WebContents,
): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender);
  const opts: Electron.OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
  };
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function registerIpc() {
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfoDto => ({
      version: app.getVersion(),
      platform: process.platform,
      userDataPath: app.getPath("userData"),
      userName: userInfo().username,
      logPath: logger.file,
    }),
  );
  // cask 가 깔려 있어도 지금 띄운 것이 그 앱이어야 한다 — 다른 곳의 빌드에서 누르면 /Applications 의 앱이 바뀐다.
  const fromCask = () => app.isPackaged && /^\/Applications\/Sudal\.app\//.test(realpathSync(process.execPath));
  // 업데이트 상태는 main 이 들고 있다 — 설정 카드와 사이드바가 같은 것을 보고, 화면을 옮겼다 돌아와도 이어 보이게.
  let lastCheck: UpdateCheckDto | null = null;
  let dmgSize: number | undefined;
  let update: { target: string; job: Promise<UpdateRunResult>; progress: UpdateProgress } | null = null;
  let installed: string | null = null;
  let updateError: string | undefined;
  const updateStatus = (): UpdateStatusDto => ({
    running: update?.target ?? null,
    installed,
    ...(update ? { phase: update.progress.phase, ...(update.progress.percent !== undefined ? { percent: update.progress.percent } : {}) } : {}),
    check: lastCheck,
    ...(updateError ? { error: updateError } : {}),
  });
  const announceUpdate = () => sendAll(IPC.appUpdateChanged, updateStatus());
  // 확인은 한 번에 하나만 — 자동 확인과 수동 확인이 겹치면 같은 요청의 결과를 나눠 받는다(응답이 뒤바뀌어 옛 결과가 덮지 않게).
  let checking: Promise<UpdateCheckDto> | null = null;
  let lastCheckAt = 0;
  const checkUpdate = (): Promise<UpdateCheckDto> => {
    checking ??= (async () => {
      const current = app.getVersion();
      const [latest, cask] = await Promise.all([fetchLatestRelease(), fromCask() ? caskVersion(await cliDiscovery().buildEnv()) : null]);
      dmgSize = latest.dmgSize;
      lastCheck = { current, latest: latest.version, available: compareVersions(latest.version, current) > 0, releaseUrl: latest.url, brew: cask !== null };
      lastCheckAt = Date.now();
      announceUpdate();
      return lastCheck;
    })().finally(() => (checking = null));
    return checking;
  };
  ipcMain.handle(IPC.appUpdateCheck, checkUpdate);
  // 새 버전은 앱이 스스로 알아본다 — 설정에 들어가 확인을 누르지 않아도 사이드바에 보이게. 네트워크가 없으면 조용히 넘어간다.
  // 6시간에 한 번이면 충분하다(GitHub 는 로그인 없는 요청을 IP 마다 시간당 60회로 묶는다). 맥이 잠든 동안에는 타이머가
  // 가지 않으므로 고정 간격 대신 지난 시간을 보고, 잠에서 깰 때도 본다.
  const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
  const autoCheck = () => {
    if (update || installed || Date.now() - lastCheckAt < AUTO_CHECK_EVERY_MS) return;
    checkUpdate().catch((e) => console.log(`[update] 자동 확인 실패: ${e instanceof Error ? e.message : String(e)}`));
  };
  setTimeout(autoCheck, 10_000);
  setInterval(autoCheck, 30 * 60 * 1000);
  // 깨어난 직후에는 네트워크가 아직 없을 수 있어 조금 기다린다
  powerMonitor.on("resume", () => setTimeout(autoCheck, 30_000));
  ipcMain.handle(IPC.appUpdateStatus, updateStatus);
  ipcMain.handle(IPC.appUpdateRun, (): Promise<UpdateRunResult> => {
    if (update) return update.job;
    // 진행 상태를 본 뒤 다시 붙기 전에 끝났을 수 있다 — 다시 돌리지 않고 결과를 준다
    if (installed) return Promise.resolve({ ok: true, version: installed });
    if (!fromCask()) return Promise.resolve({ ok: false, error: mt("main.update.caskOnly") });
    const target = lastCheck?.latest;
    if (!target) return Promise.resolve({ ok: false, error: mt("main.update.checkFirst") });
    const job = cliDiscovery()
      .buildEnv()
      .then((env) =>
        brewUpgrade(env, target, {
          dmgSize,
          onProgress: (p) => {
            if (!update) return;
            update.progress = p;
            announceUpdate();
          },
        }),
      )
      .then((r) => {
        console.log(r.ok ? `[update] brew upgrade 완료 (${r.version})` : `[update] ${r.error}`);
        if (r.ok) installed = r.version;
        else updateError = r.error;
        return r;
      })
      .finally(() => {
        update = null;
        announceUpdate();
      });
    updateError = undefined;
    update = { target, job, progress: { phase: "checking" } };
    announceUpdate();
    return job;
  });
  ipcMain.handle(IPC.appRelaunch, () => {
    app.relaunch();
    app.quit();
  });
  applyAppSettings(appSettings());
  ipcMain.handle(IPC.appSettingsGet, (): AppSettingsDto => appSettings());
  ipcMain.handle(IPC.appSettingsSet, (_e, patch: Partial<AppSettingsDto>): AppSettingsDto => {
    if (!patch || typeof patch !== "object") throw new Error(mt("main.error.badArgs"));
    const cur = store.loadSettings<Record<string, unknown>>({});
    const next = { ...cur };
    if (patch.theme !== undefined) {
      if (!isThemeMode(patch.theme)) throw new Error(mt("main.error.badTheme"));
      next.theme = patch.theme;
    }
    if (patch.language !== undefined) {
      if (!isLanguageSetting(patch.language)) throw new Error(mt("main.error.badLanguage"));
      next.language = patch.language;
    }
    if (patch.warmTarget !== undefined) {
      if (patch.warmTarget !== "active" && patch.warmTarget !== "off") throw new Error(mt("main.error.badWarmTarget"));
      next.warmTarget = patch.warmTarget;
    }
    if (patch.sessionIdleMinutes !== undefined) {
      const n = Number(patch.sessionIdleMinutes);
      if (!Number.isFinite(n) || n < SESSION_IDLE_MINUTES_MIN || n > SESSION_IDLE_MINUTES_MAX) throw new Error(mt("main.error.idleMinutesRange", { min: SESSION_IDLE_MINUTES_MIN, max: SESSION_IDLE_MINUTES_MAX }));
      next.sessionIdleMinutes = Math.round(n);
    }
    if (patch.keepBrowserLogin !== undefined) {
      next.keepBrowserLogin = patch.keepBrowserLogin === true;
      // 끄면 적어 둔 것을 지운다 — 설정만 바꾸고 파일이 남아 있으면 끈 게 아니다.
      if (!next.keepBrowserLogin) forgetSessionCookies(app.getPath("userData"));
    }
    if (patch.notifyOnDone !== undefined) {
      if (!isNotifyOnDone(patch.notifyOnDone)) throw new Error(mt("main.error.badNotifySetting"));
      next.notifyOnDone = patch.notifyOnDone;
    }
    // 경로를 고르는 건 main 의 선택 창(app:pick-worktree-dir)만 한다 — 여기서는 기본값으로 되돌리기만 받는다
    if (patch.worktreeDirCustom === false) delete next.worktreeDir;
    if (patch.maxConcurrent !== undefined) {
      const n = Number(patch.maxConcurrent);
      if (!Number.isFinite(n) || n < MAX_CONCURRENT_MIN || n > MAX_CONCURRENT_MAX) throw new Error(mt("main.error.maxConcurrentRange", { min: MAX_CONCURRENT_MIN, max: MAX_CONCURRENT_MAX }));
      next.maxConcurrent = Math.round(n);
    }
    store.saveSettings(next);
    const applied = appSettings();
    applyAppSettings(applied);
    // 다른 창과 설정 화면 밖의 화면도 새 값을 받는다(표시 언어를 따라가게)
    sendAll(IPC.appSettingsChanged, applied);
    // 예열을 켰으면 보고 있는 탭을 지금 띄워 둔다
    if (patch.warmTarget === "active") {
      const active = workspaces.state().model.activeTabId;
      if (active) void sessions.warm(active);
    }
    return applied;
  });
  ipcMain.handle(IPC.appPickWorktreeDir, async (e): Promise<AppSettingsDto> => {
    const dir = await pickDirectoryRaw(e.sender);
    if (dir) {
      store.saveSettings({ ...store.loadSettings<Record<string, unknown>>({}), worktreeDir: resolve(dir) });
      approveRoot(dir);
    }
    return appSettings();
  });
  ipcMain.handle(IPC.appOpenPath, async (_e, which: "data" | "worktrees") => {
    const dir = which === "worktrees" ? worktreeRootDir() : app.getPath("userData");
    // 아직 worktree 를 하나도 안 만들었으면 폴더가 없다 — 열 수 있게 만들어 둔다
    if (which === "worktrees") mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  ipcMain.handle(IPC.appOpenLogs, () =>
    shell.openPath(logger.dir).then(() => undefined),
  );
  rendererState = new RendererState(app.getPath("userData"));
  ipcMain.handle(IPC.stateLoad, () => rendererState.load());
  ipcMain.on(IPC.stateSet, (_e, key: unknown, value: unknown) => {
    if (typeof key === "string" && (typeof value === "string" || value === null)) rendererState.set(key, value);
  });
  ipcMain.on(IPC.rendererError, (_e, err: RendererErrorDto) => {
    console.error(
      `[renderer] ${err.kind}: ${err.message}${err.source ? ` (${err.source})` : ""}`,
      err.stack ?? "",
    );
  });
  ipcMain.handle(IPC.cliStatus, (_e, provider: Provider) =>
    cliStatus(provider),
  );
  ipcMain.handle(IPC.appModels, (_e, provider: Provider, opts?: { force?: boolean }) => {
    if (!PROVIDERS.includes(provider)) return { models: [], source: "static" as const };
    if (opts?.force) invalidateModels(provider);
    return listModels(provider, { claude: () => claudeRuntime(), codex: () => codexRuntime(), log: (l) => console.log(l) });
  });
  ipcMain.handle(
    IPC.cliCandidates,
    (_e, provider: Provider): Promise<CliCandidateDto[]> =>
      cliDiscovery().listCandidates(provider),
  );
  ipcMain.handle(
    IPC.cliSetOverride,
    (_e, provider: Provider, binPath: string | null): OverrideSetResultDto =>
      cliDiscovery().setOverride(provider, binPath),
  );
  ipcMain.handle(IPC.cliRefresh, () => {
    cliDiscovery().invalidate();
  });
  ipcMain.handle(IPC.cliDiagnostics, () => cliDiagnostics());

  ipcMain.handle(IPC.chatSend, (_e, tabId: string, payload: ChatSendDto) =>
    handleChatSend(tabId, payload),
  );
  ipcMain.handle(IPC.chatVerify, (_e, tabId: string, opts?: { commands?: unknown }) => {
    if (typeof tabId !== "string") return { ok: false, error: mt("main.error.tabIdMissing") } satisfies VerifyStartResult;
    // commands 를 줬는데 모양이 틀리면(문자열·빈 배열·잘못된 원소) 저장된 명령으로 대체하지 않고 거절한다
    if (opts && "commands" in opts && opts.commands !== undefined) {
      if (!Array.isArray(opts.commands) || opts.commands.length === 0 || !opts.commands.every((c) => typeof c === "string" && c.trim())) return { ok: false, error: mt("main.verify.commandsInvalid") } satisfies VerifyStartResult;
      const commands = parseVerifyCommands((opts.commands as string[]).join("\n"));
      if (commands.length === 0) return { ok: false, error: mt("main.verify.noCommandsToRun") } satisfies VerifyStartResult;
      return startVerify(tabId, commands);
    }
    return startVerify(tabId);
  });
  ipcMain.handle(IPC.chatVerifyAbort, (_e, tabId: string) => (typeof tabId === "string" ? verifyRunner.abort(tabId) : false));
  ipcMain.handle(IPC.chatVerifySuggest, (_e, tabId: string) => (typeof tabId === "string" ? verifySuggestions(tabId) : []));
  orchestrator = new Orchestrator({
    dir: join(app.getPath("userData"), "orchestration"),
    cliCommand: () => {
      const shim = join(app.getPath("home"), ".local", "bin", "sudal");
      return existsSync(shim) ? "sudal" : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(join(cliDir(), "sudal.cjs"))}`;
    },
    log: (line) => console.log(line),
    createWorkerTab: async (o) => {
      const model = workspaces.state().model;
      const norm = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      const ws = model.workspaces.find((w) => w.path && norm(w.path) === norm(o.cwd)) ?? model.workspaces.find((w) => w.id === model.tabs.find((t) => t.id === model.activeTabId)?.workspaceId) ?? model.workspaces[0];
      if (!ws) return { ok: false, error: mt("main.error.noWorkspace"), stage: "creating_tab" };
      const prevActive = model.activeTabId;
      const env = await cliDiscovery().buildEnv();
      let tabId: string | null;
      let cwd = o.cwd;
      let worktree: WorktreeMeta | undefined;
      if (o.worktree) {
        const wt = await worktreeCreate(o.cwd, env, { rootDir: worktreeRootDir(), slug: worktreeSlug(`worker-${o.provider}`) });
        if (!wt.ok) return { ok: false, error: wt.error, stage: "creating_workspace" };
        worktree = wt.worktree;
        cwd = wt.worktree.path;
        tabId = workspaces.createTab(ws.id, { cwd, worktree, title: o.title });
      } else {
        tabId = workspaces.createTab(ws.id);
        if (tabId) workspaces.renameTab(tabId, o.title);
      }
      if (!tabId) return { ok: false, error: mt("main.error.tabMakeFailed"), stage: "creating_tab" };
      sessions.configure(tabId, { cwd, provider: o.provider, policy: o.policy, model: o.model });
      // 워커는 화면을 빼앗지 않는다
      if (prevActive && prevActive !== tabId) workspaces.activateTab(prevActive);
      return { ok: true, tabId, cwd, worktree };
    },
    send: (tabId, text) => handleChatSend(tabId, { text }),
    snapshot: (tabId) => {
      if (!workspaces.tab(tabId)) return null;
      const s = sessions.snapshot(tabId);
      return workerSnapshotFrom(s.status, s.limitWait !== null, sessions.pendingPermissions(tabId).length, sessions.events(tabId));
    },
    abort: (tabId) => void sessions.abort(tabId),
    tabCwd: (tabId) => (workspaces.tab(tabId) ? sessions.snapshot(tabId).cwd : null),
    tabInfo: (tabId) => {
      const tab = workspaces.tab(tabId);
      if (!tab) return null;
      const s = sessions.snapshot(tabId);
      return { provider: s.provider, cwd: s.cwd, worktree: tab.worktree, model: s.model, policy: s.policy };
    },
    configureTab: (tabId, patch) => void sessions.configure(tabId, { policy: patch.policy, model: patch.model }),
    tabsUsingCwd: (p, exceptTabId) => {
      const norm = (x: string) => {
        try {
          return realpathSync(x);
        } catch {
          return x;
        }
      };
      const target = norm(p);
      return workspaces
        .state()
        .model.tabs.filter((t) => t.open && t.id !== exceptTabId)
        .filter((t) => {
          const cwd = sessions.snapshot(t.id).cwd;
          return !!cwd && (norm(cwd) === target || norm(cwd).startsWith(target + "/"));
        })
        .map((t) => t.id);
    },
    cleanupWorker: async (tabId, worktree) => {
      const tab = workspaces.tab(tabId);
      if (!tab) return { tabClosed: false, worktreeRemoved: false };
      if (sessions.isBusy(tabId)) return { tabClosed: false, worktreeRemoved: false, error: mt("main.error.tabStillRunning") };
      let worktreeRemoved = false;
      const wt = tab.worktree ?? worktree;
      if (wt) {
        const env = await cliDiscovery().buildEnv();
        // 환경을 읽는 사이에 사용자가 그 탭에 지시를 보냈을 수 있다 — 지우기 직전에 다시 본다
        if (sessions.isBusy(tabId)) return { tabClosed: false, worktreeRemoved: false, error: mt("main.error.tabStartedStopCleanup") };
        const r = await worktreeRemove(env, wt, { force: true });
        if (!r.ok) return { tabClosed: false, worktreeRemoved: false, error: r.error };
        worktreeRemoved = true;
        workspaces.clearWorktree(tabId);
        sessions.configure(tabId, { cwd: wt.repo });
      }
      if (sessions.isBusy(tabId)) return { tabClosed: false, worktreeRemoved, error: mt("main.error.tabStartedNotClosed") };
      workspaces.closeTab(tabId);
      return { tabClosed: true, worktreeRemoved };
    },
    maxConcurrent: () => sessions.getMaxConcurrent(),
    setCoordinatorTabs: (ids) => sessions.setExemptTabs(ids),
    onChanged: (runId, state, event) => {
      sendAll(IPC.orchChanged, runId);
      // Run 단위 알림: 사람이 봐야 하는 질문/에스컬레이션/탭 소실, 그리고 모든 Task 가 끝났을 때
      if (event.type === "message" && event.message.to === "run" && (event.message.type === "question" || event.message.type === "escalation" || event.message.noteKind === "worker_tab_missing" || event.message.noteKind === "turn_ended_without_report")) {
        const kind = event.message.type === "question" ? mt("cli.notify.workerQuestion") : event.message.type === "escalation" ? mt("cli.notify.workerEscalation") : mt("cli.notify.needsAttention");
        notifyIfUnfocused(`${kind} · ${state.run.objective.slice(0, 40)}`, event.message.body, state.run.coordinator.kind === "tab" ? state.run.coordinator.tabId : undefined);
      }
      if ((event.type === "dispatch_settled" || event.type === "dispatch_abandoned") && runSettled(state) && !notifiedRuns.has(runId)) {
        notifiedRuns.add(runId);
        if (appSettings().notifyOnDone !== "off") notify(`${mt("cli.notify.runDone")} · ${state.run.objective.slice(0, 40)}`, runSummary(mt, state), state.run.createdBy.kind === "tab" ? state.run.createdBy.tabId : undefined);
      }
      // 카드는 Run 을 만든 탭에 남긴다(사람이 인수해도 그 탭의 카드가 계속 따라간다)
      const cardTab = state.run.createdBy.kind === "tab" ? state.run.createdBy.tabId : null;
      if (cardTab && Orchestrator.isCardEvent(event) && workspaces.tab(cardTab)) sessions.note(cardTab, { type: "orchestration", ts: Date.now(), ...orchestrator!.cardView(runId) });
    },
  });
  const orchOk = (fn: () => unknown): { ok: true } | { ok: false; error: string } => {
    try {
      fn();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof OrchError || e instanceof Error ? e.message : String(e) };
    }
  };
  ipcMain.handle(IPC.orchList, () => orchestrator!.list());
  ipcMain.handle(IPC.orchReply, (_e, runId: string, questionId: string, body: string) => orchOk(() => orchestrator!.reply({ runId: String(runId), actor: { kind: "user" }, questionId: String(questionId), body: String(body) })));
  ipcMain.handle(IPC.orchFollowup, (_e, runId: string, dispatchId: string, body: string) => orchOk(() => orchestrator!.send({ runId: String(runId), actor: { kind: "user" }, type: "followup", to: `dispatch:${String(dispatchId)}`, body: String(body) })));
  ipcMain.handle(IPC.orchTakeover, (_e, runId: string) => orchOk(() => orchestrator!.takeover(String(runId))));
  ipcMain.handle(IPC.orchWorker, async (_e, runId: string, dispatchId: string, action: "retain" | "release" | "stop" | "abandon" | "cleanup") => {
    if (action === "cleanup") {
      try {
        await orchestrator!.workerCleanup({ runId: String(runId), actor: { kind: "user" }, dispatchId: String(dispatchId) });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return orchOk(() => orchestrator!.workerAction({ runId: String(runId), actor: { kind: "user" }, dispatchId: String(dispatchId), action }));
  });
  ipcMain.handle(IPC.orchGate, (_e, runId: string, gateId: string, resolution: string) => orchOk(() => orchestrator!.gateResolve({ runId: String(runId), actor: { kind: "user" }, gateId: String(gateId), resolution: String(resolution) })));
  ipcMain.handle(IPC.orchClose, (_e, runId: string) => orchOk(() => orchestrator!.close(String(runId), { kind: "user" })));
  ipcMain.handle(IPC.chatFanout, (_e, tabId: string, req: FanoutStartDto) => (typeof tabId === "string" && req && typeof req === "object" ? startFanout(tabId, req) : ({ ok: false, error: mt("main.error.badRequest") } satisfies FanoutStartResult)));
  ipcMain.handle(IPC.chatFanoutCompare, (_e, tabId: string, fanoutId: string) => fanoutCompare(String(tabId), String(fanoutId)));
  ipcMain.handle(IPC.chatFanoutAdopt, (_e, tabId: string, fanoutId: string, variantTabId: string) => fanoutAdopt(String(tabId), String(fanoutId), String(variantTabId)));
  ipcMain.handle(IPC.chatFanoutCleanup, (_e, tabId: string, fanoutId: string) => fanoutCleanup(String(tabId), String(fanoutId)));
  ipcMain.handle(IPC.chatCrossReview, (_e, tabId: string) => {
    if (typeof tabId !== "string") throw new Error(mt("main.error.badArgs"));
    return startCrossReview(tabId);
  });
  ipcMain.handle(IPC.chatAttachTerminal, (_e, tabId: string) =>
    sessions.attachTerminal(tabId),
  );
  ipcMain.handle(IPC.chatDetachTerminal, (_e, tabId: string) =>
    sessions.detachTerminal(tabId),
  );
  ipcMain.handle(IPC.chatAbort, (_e, tabId: string) => sessions.abort(tabId));
  ipcMain.handle(IPC.chatLimitRetry, (_e, tabId: string) => sessions.limitRetryNow(tabId));
  ipcMain.handle(IPC.chatLimitCancel, (_e, tabId: string) => sessions.limitCancel(tabId));
  ipcMain.handle(IPC.chatQueueRemove, (_e, tabId: string, id: string) => {
    if (typeof tabId !== "string" || typeof id !== "string") throw new Error(mt("main.error.badArgs"));
    return sessions.queueRemove(tabId, id);
  });
  ipcMain.handle(IPC.chatQueueSendNext, (_e, tabId: string) => sessions.queueSendNext(tabId));
  ipcMain.handle(IPC.chatFork, (_e, tabId: string, pointId: string) => {
    if (typeof tabId !== "string" || typeof pointId !== "string") throw new Error(mt("main.error.badArgs"));
    return forkTab(tabId, pointId);
  });
  ipcMain.handle(IPC.chatQueueSteer, (_e, tabId: string, id: string) => {
    if (typeof tabId !== "string" || typeof id !== "string") throw new Error(mt("main.error.badArgs"));
    return sessions.queueSteer(tabId, id);
  });
  ipcMain.handle(IPC.chatQueueUpdate, (_e, tabId: string, id: string, text: string) => {
    if (typeof tabId !== "string" || typeof id !== "string" || typeof text !== "string") throw new Error(mt("main.error.badArgs"));
    return sessions.queueUpdate(tabId, id, text.slice(0, 20_000));
  });
  ipcMain.handle(
    IPC.chatPermission,
    (_e, tabId: string, requestId: string, answer: PermissionAnswer) =>
      sessions.answerPermission(tabId, requestId, answer),
  );
  ipcMain.handle(
    IPC.chatConfigure,
    (_e, tabId: string, patch: Partial<SessionConfigDto>) => {
      if (typeof tabId !== "string" || !patch || typeof patch !== "object") throw new Error(mt("main.error.badArgs"));
      const clean: Partial<SessionConfigDto> = {};
      if ("cwd" in patch) {
        // 탭 cwd 는 파일 조작·git·언어 서버의 경계가 된다 — 사용자가 디렉토리 선택 창으로 고른 루트 안만 받는다.
        if (patch.cwd === null || patch.cwd === "") clean.cwd = null;
        else if (typeof patch.cwd === "string" && isApprovedDir(patch.cwd)) clean.cwd = patch.cwd;
        else throw new Error(unapprovedDir());
      }
      if (patch.provider !== undefined) {
        if (!PROVIDERS.includes(patch.provider)) throw new Error(mt("main.error.badProvider"));
        clean.provider = patch.provider;
      }
      if (patch.policy !== undefined) {
        if (typeof patch.policy !== "string") throw new Error(mt("main.error.badPolicy"));
        clean.policy = patch.policy;
      }
      if ("model" in patch) {
        if (patch.model !== undefined && typeof patch.model !== "string") throw new Error(mt("main.error.badModel"));
        clean.model = patch.model?.slice(0, 200);
      }
      const snap = sessions.configure(tabId, clean);
      if (clean.cwd || clean.provider || clean.policy) void sessions.warm(tabId);
      return snap;
    },
  );
  ipcMain.handle(IPC.chatSnapshot, (_e, tabId: string) =>
    sessions.snapshot(tabId),
  );
  ipcMain.handle(IPC.chatEvents, (_e, tabId: string) => sessions.events(tabId));
  ipcMain.handle(IPC.chatClear, (_e, tabId: string) => sessions.clear(tabId));
  // 압축은 되도록 provider 에게 맡긴다 — 모델이 무엇을 남길지 정하고 세션도 끊기지 않는다.
  ipcMain.handle(
    IPC.chatCompact,
    async (_e, tabId: string, focus?: string): Promise<CompactResult> => {
      if (typeof tabId !== "string") return { ok: false, error: mt("main.error.tabIdMissing") };
      if (sessions.canCompactNatively(tabId)) {
        const f = typeof focus === "string" ? focus.trim() : "";
        const r = await handleChatSend(tabId, { text: f ? `/compact ${f}` : "/compact" });
        return r.ok ? { ok: true, native: true } : { ok: false, error: r.error };
      }
      return { ok: true, native: false, config: sessions.compactFallback(tabId) };
    },
  );
  ipcMain.handle(IPC.chatHandoffPreview, (_e, tabId: string) =>
    sessions.handoffPreview(tabId),
  );
  ipcMain.handle(
    IPC.chatSwitchProvider,
    async (_e, tabId: string, opts: SwitchProviderDto) => {
      // Claude 와 Codex 는 세션을 이어받을 수 없어 텍스트로 넘길 수밖에 없다. 그 텍스트는
      // 우리가 기록을 잘라 만드는 것보다 떠나는 쪽이 직접 쓴 것이 낫다 — 무엇이 중요한지 아는 쪽이니까.
      const summary =
        opts.preserveContext && opts.askSummary
          ? await askHandoffBrief(tabId)
          : undefined;
      return sessions.switchProvider(tabId, { ...opts, summary });
    },
  );
  ipcMain.handle(IPC.chatCommands, async (_e, tabId: string) => {
    const snap = sessions.snapshot(tabId);
    if (snap.provider !== "claude" || !snap.cwd) return [];
    return slashCommands.get(snap.cwd, () => claudeRuntime());
  });

  ipcMain.handle(IPC.mcpStatus, async (_e, cwd: string) => {
    if (typeof cwd !== "string" || !isKnownCwd(cwd)) throw new Error(unknownCwd());
    return fetchMcpStatus(await claudeRuntime(), cwd, (line) => console.log(`[mcp] ${line}`));
  });
  ipcMain.handle(IPC.chatSearch, (_e, query: string): SearchResultDto[] => {
    const q = query.trim();
    if (!q) return [];
    const model = workspaces.state().model;
    const out: SearchResultDto[] = [];
    // 인덱스는 store 파일을 stat 해 바뀐 탭만 다시 읽는다(sessions.events() 는 닫힌 탭까지 Session 객체를 만들어 붙들기 때문에 안 쓴다).
    const tabs = model.tabs.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    searchIndex.retain(tabs.map((t) => t.id)); // 삭제된 탭의 캐시는 여기서 떨어진다
    for (const tab of tabs) {
      const hits = searchIndex.search(tab.id, q, 20);
      if (hits.length === 0) continue;
      out.push({
        tabId: tab.id,
        title: tabTitleOf(tab.id),
        workspaceName:
          model.workspaces.find((w) => w.id === tab.workspaceId)?.name ?? "",
        provider: tab.provider,
        open: tab.open,
        updatedAt: tab.updatedAt,
        hits,
      });
      if (out.length >= 60) break;
    }
    return out;
  });
  ipcMain.handle(IPC.chatExport, async (e, tabId: string) => {
    const model = workspaces.state().model;
    const tab = model.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const title = tabTitleOf(tabId);
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath("downloads"), exportFileName(title, Date.now())),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    const md = eventsToMarkdown(mt, store.readEvents(tabId), {
      title,
      workspace: model.workspaces.find((w) => w.id === tab.workspaceId)?.name ?? null,
      provider: PROVIDER_LABEL[tab.provider],
      cwd: workspaces.resolveConfig(tabId)?.cwd ?? null,
      exportedAt: Date.now(),
      locale: intlLocale(mainI18n().language as Locale),
    });
    try {
      writeFileSync(r.filePath, md, "utf8");
    } catch (e) {
      throw new Error(mt("main.export.failed", { detail: e instanceof Error ? e.message : String(e) }));
    }
    return r.filePath;
  });

  ipcMain.handle(IPC.lspStatus, () => lsp.status());
  ipcMain.handle(IPC.lspSetPath, (_e, serverId: unknown, path: string | null) =>
    isLspServerId(serverId) ? lsp.setOverride(serverId, typeof path === "string" ? path : null) : { ok: false, error: mt("main.error.unknownLsp") },
  );
  ipcMain.handle(IPC.lspStart, (_e, cwd: string, serverId: unknown) => {
    if (!isLspServerId(serverId)) return { ok: false, error: mt("main.error.unknownLsp") };
    return typeof cwd === "string" && isKnownCwd(cwd) ? lsp.start(cwd, serverId) : { ok: false, error: mt("main.error.unknownCwdShort") };
  });
  ipcMain.on(IPC.lspSend, (_e, id: string, message: string) => {
    if (typeof id === "string" && typeof message === "string") lsp.send(id, message);
  });

  ipcMain.handle(IPC.snippetsList, () => snippets.list());
  ipcMain.handle(
    IPC.snippetsSave,
    (_e, input: { id?: string; name: string; text: string; workspaceId: string | null }) =>
      snippets.save(input),
  );
  ipcMain.handle(IPC.snippetsRemove, (_e, id: string) => snippets.remove(id));

  // 읽기 전용이라도 git 은 그 디렉토리의 저장소 설정(core.fsmonitor 등)을 실행할 수 있어 알려진 cwd 에서만 돈다.
  ipcMain.handle(IPC.gitInfo, async (_e, cwd: string) =>
    typeof cwd === "string" && isKnownCwd(cwd) ? gitInfo(cwd, await cliDiscovery().buildEnv()) : null,
  );
  ipcMain.handle(IPC.gitChanges, async (_e, cwd: string) =>
    typeof cwd === "string" && isKnownCwd(cwd) ? gitChanges(cwd, await cliDiscovery().buildEnv()) : [],
  );
  ipcMain.handle(
    IPC.gitCommit,
    async (_e, cwd: string, paths: string[], message: string) => {
      if (typeof cwd !== "string" || !Array.isArray(paths) || typeof message !== "string") return { ok: false, error: mt("main.error.badArgs") };
      if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
      return gitCommit(cwd, await cliDiscovery().buildEnv(), paths, message);
    },
  );
  ipcMain.handle(IPC.gitRevert, async (_e, cwd: string, path: string) => {
    if (typeof cwd !== "string" || typeof path !== "string") return { ok: false, error: mt("main.error.badArgs") };
    if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
    return gitRevert(cwd, await cliDiscovery().buildEnv(), path);
  });
  ipcMain.handle(IPC.gitDraftMessage, async (_e, cwd: string, paths: string[]) => {
    if (typeof cwd !== "string" || !Array.isArray(paths)) return { ok: false, error: mt("main.error.badArgs") };
    if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
    try {
      return await draftCommitMessage(await claudeRuntime(), cwd, paths);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(
    IPC.fileWrite,
    async (
      _e,
      cwd: string,
      path: string,
      content: string,
      opts: { expectedMtimeMs: number | null; expectedSize?: number | null; force?: boolean },
    ) => {
      if (typeof cwd !== "string" || typeof path !== "string" || typeof content !== "string" || !opts || typeof opts !== "object")
        return { ok: false, error: mt("main.error.badArgs") };
      if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
      return writeFileView(cwd, path, content, opts, await cliDiscovery().buildEnv());
    },
  );
  ipcMain.handle(IPC.fileCreate, async (_e, cwd: string, path: string, kind: "file" | "dir") => {
    if (typeof cwd !== "string" || typeof path !== "string" || (kind !== "file" && kind !== "dir"))
      return { ok: false, error: mt("main.error.badArgs") };
    if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
    return createPath(cwd, path, kind, await cliDiscovery().buildEnv());
  });
  ipcMain.handle(IPC.fileRename, async (_e, cwd: string, from: string, to: string) => {
    if (typeof cwd !== "string" || typeof from !== "string" || typeof to !== "string")
      return { ok: false, error: mt("main.error.badArgs") };
    if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
    return renamePath(cwd, from, to, await cliDiscovery().buildEnv());
  });
  ipcMain.handle(IPC.fileDelete, async (_e, cwd: string, path: string) => {
    if (typeof cwd !== "string" || typeof path !== "string") return { ok: false, error: mt("main.error.badArgs") };
    if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
    const r = await resolveDeletable(cwd, path, await cliDiscovery().buildEnv());
    if (!r.ok) return r;
    try {
      await shell.trashItem(r.path); // 휴지통 — 되돌릴 수 있다
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.fileRead, async (_e, cwd: string, path: string) => {
    if (typeof cwd !== "string" || typeof path !== "string") throw new Error(mt("main.error.badArgs"));
    if (!isKnownCwd(cwd)) throw new Error(unknownCwd());
    return readFileView(cwd, path, await cliDiscovery().buildEnv());
  });
  ipcMain.handle(IPC.fileList, (_e, dir: string) => {
    if (typeof dir !== "string" || !isInsideKnownCwd(dir)) return [];
    return listDirectory(dir);
  });
  ipcMain.handle(IPC.fileLocate, async (_e, cwd: string, ref: string) => {
    if (typeof cwd !== "string" || typeof ref !== "string" || ref.length > 1024) return [];
    if (!isKnownCwd(cwd)) return [];
    return locateFiles(cwd, ref, await cliDiscovery().buildEnv());
  });

  ipcMain.handle(IPC.pickDirectory, (e) => pickDirectory(e.sender));
  ipcMain.handle(IPC.controlInstallCli, () => installCliShim());
  ipcMain.handle(IPC.controlInstallSkill, (_e, agent?: unknown) => installSkillStub(agent === "claude" || agent === "codex" ? agent : undefined));
  ipcMain.handle(IPC.controlInstallStatus, () => installStatus());
  ipcMain.handle(IPC.previewUrl, async (_e, cwd: string, path: string) => {
    if (typeof cwd !== "string" || typeof path !== "string") return { ok: false, error: mt("main.error.badArgs") };
    if (!isKnownCwd(cwd)) return { ok: false, error: unknownCwd() };
    const root = await repoRoot(cwd, await cliDiscovery().buildEnv());
    const url = await previewServer.urlFor(root, isAbsolute(path) ? path : resolve(cwd, path));
    return url ? { ok: true, url } : { ok: false, error: mt("main.error.previewRepoOnly") };
  });
  ipcMain.handle(IPC.backgroundJobs, () => allBackgroundJobs());

  // 예약. CLI 와 같은 구현을 쓴다 — 화면과 CLI 가 어긋나지 않게.
  ipcMain.handle(IPC.schedulesList, () => scheduleSnapshot());
  ipcMain.handle(IPC.schedulesSave, (_e, input: Record<string, unknown>) => {
    schedulesApi().save(input as never);
    return scheduleSnapshot();
  });
  ipcMain.handle(IPC.schedulesRemove, (_e, id: string) => {
    schedulesApi().remove(id);
    return scheduleSnapshot();
  });
  ipcMain.handle(IPC.schedulesRunNow, async (_e, id: string) => {
    await schedulesApi().runNow(id);
    return scheduleSnapshot();
  });
  ipcMain.on(IPC.browserRegister, (_e, tabId: unknown, webContentsId: unknown, url: unknown) => {
    if (typeof tabId !== "string") return;
    if (typeof webContentsId === "number" && Number.isInteger(webContentsId))
      browserViews.set(tabId, { id: webContentsId, url: typeof url === "string" ? url : "" });
    else browserViews.delete(tabId);
  });
  ipcMain.handle(IPC.browserFavicon, (_e, url: unknown) =>
    typeof url === "string" ? fetchFavicon(url) : null,
  );
  ipcMain.handle(IPC.browserNetFailures, (_e, webContentsId: unknown, clear: unknown) => {
    if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId)) return [];
    const out = browserNetFailures(webContentsId);
    if (clear === true) clearBrowserNetFailures(webContentsId);
    return out;
  });
  ipcMain.handle(IPC.openExternal, async (_e, url: unknown) => {
    if (typeof url !== "string" || !isExternalUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle(
    IPC.termOpen,
    async (_e, tabId: string, cwd: string, cols: number, rows: number) =>
      terminals.open(tabId, cwd, await sdkEnv(), cols, rows),
  );
  ipcMain.on(IPC.termWrite, (_e, termId: string, data: string) => {
    terminals.write(termId, data);
    // 하이브리드 CLI 에 친 키는 권한 대기 힌트 판단에도 쓴다.
    if (termId.endsWith(":cli"))
      sessions.terminalInput(termId.slice(0, -4), data);
  });
  ipcMain.on(IPC.termResize, (_e, tabId: string, cols: number, rows: number) =>
    terminals.resize(tabId, cols, rows),
  );
  ipcMain.handle(IPC.termClose, (_e, tabId: string) => terminals.close(tabId));
  ipcMain.on(IPC.termClear, (_e, tabId: string) => terminals.clearBacklog(tabId));
  ipcMain.handle(IPC.termList, (_e, tabId: string) =>
    terminals.list(`${tabId}:`),
  );

  ipcMain.handle(IPC.wsState, () => workspaces.state());
  ipcMain.handle(IPC.wsAdd, async (e, path?: string) => {
    // 렌더러가 경로를 직접 주면 승인된 루트 안일 때만, 아니면 선택 창을 연다
    const dir = typeof path === "string" && path && isApprovedDir(path) ? path : await pickDirectory(e.sender);
    return dir ? workspaces.addWorkspace(dir) : null;
  });
  ipcMain.handle(IPC.wsCreate, (_e, name: string) =>
    workspaces.createWorkspace(name.trim() || mt("main.workspace.defaultName")),
  );
  ipcMain.handle(
    IPC.wsUpdate,
    (_e, id: string, patch: { name?: string; path?: string; verifyCommands?: string[] }) => {
      if (typeof id !== "string" || !patch || typeof patch !== "object") return;
      const clean: { name?: string; path?: string; verifyCommands?: string[] } = {};
      if (typeof patch.name === "string") clean.name = patch.name.slice(0, 200);
      if (Array.isArray(patch.verifyCommands)) clean.verifyCommands = parseVerifyCommands(patch.verifyCommands.filter((c): c is string => typeof c === "string").join("\n"));
      if (patch.path !== undefined) {
        if (patch.path === "") clean.path = "";
        else if (typeof patch.path === "string" && isApprovedDir(patch.path)) clean.path = patch.path;
        else throw new Error(unapprovedDir());
      }
      workspaces.updateWorkspace(id, clean);
    },
  );
  ipcMain.handle(IPC.wsRemove, (_e, id: string) => {
    workspaces.removeWorkspace(id);
    snippets.removeWorkspace(id);
  });
  ipcMain.handle(IPC.tabCreate, (_e, workspaceId?: string) =>
    workspaces.createTab(workspaceId),
  );
  ipcMain.handle(IPC.tabClose, (_e, tabId: string) => {
    terminals.closePrefix(`${tabId}:`);
    return workspaces.closeTab(tabId);
  });
  ipcMain.handle(IPC.tabReopen, (_e, tabId: string) =>
    workspaces.reopenTab(tabId),
  );
  // ===== 격리 세션 (git worktree) =====
  ipcMain.handle(
    IPC.wtCreate,
    async (_e, workspaceId: string, fromTabId: string | null) => {
      const model = workspaces.state().model;
      const ws = model.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return { ok: false, error: mt("main.error.noWorkspace") };
      const from = fromTabId ? model.tabs.find((t) => t.id === fromTabId) : null;
      const repo = (from ? workspaces.resolveConfig(from.id)?.cwd : null) ?? ws.path ?? null;
      if (!repo)
        return { ok: false, error: mt("main.error.repoPathMissing") };
      const env = await cliDiscovery().buildEnv();
      const r = await worktreeCreate(repo, env, {
        rootDir: worktreeRootDir(),
        // 제목이 아직 없는 새 탭에서 만들면 "새 세션" 대신 워크스페이스 이름을 쓴다.
        slug: worktreeSlug(from?.title ? tabTitleOf(from.id) : ws.name),
      });
      if (!r.ok) return r;
      const tabId = workspaces.createTab(workspaceId, { cwd: r.worktree.path, worktree: r.worktree });
      if (!tabId) return { ok: false, error: mt("main.error.tabMakeFailed") };
      return { ok: true, tabId };
    },
  );
  ipcMain.handle(IPC.wtStatus, async (_e, tabId: string) => {
    const wt = workspaces.tab(tabId)?.worktree;
    return wt ? worktreeStatus(await cliDiscovery().buildEnv(), wt) : null;
  });
  ipcMain.handle(IPC.wtMerge, async (_e, tabId: string) => {
    const wt = workspaces.tab(tabId)?.worktree;
    if (!wt) return { ok: false, error: mt("repo.worktree.notIsolated") };
    return worktreeMerge(await cliDiscovery().buildEnv(), wt);
  });
  // 설정의 worktree 정리 목록. 지금 위치와 예전(앱 데이터 폴더 안) 위치를 함께 본다.
  const managedWorktrees = async (): Promise<ManagedWorktreeDto[]> => {
    const env = await cliDiscovery().buildEnv();
    const list = await listManagedWorktrees(env, [worktreeRootDir(), join(app.getPath("userData"), "worktrees")]);
    const model = workspaces.state().model;
    return list.map((w) => {
      const users = tabsUsingPath(model, w.path);
      const t = users[0];
      return { ...w, tab: t ? { id: t.id, title: tabTitle(t, mt("shared.untitledTab")), open: t.open !== false } : null, openTabs: users.filter((x) => x.open !== false).length };
    });
  };
  ipcMain.handle(IPC.wtListManaged, () => managedWorktrees());
  ipcMain.handle(IPC.wtRemoveManaged, async (_e, path: string) => {
    if (typeof path !== "string") throw new Error(mt("main.error.badArgs"));
    // 렌더러가 준 경로를 그대로 지우지 않는다 — 지금 목록에 있는 것만
    const w = (await managedWorktrees()).find((x) => x.path === path);
    if (!w) return { ok: false, error: mt("repo.worktree.notManaged") };
    if (w.openTabs > 0)
      return { ok: false, error: mt(w.openTabs > 1 ? "repo.worktree.inUseMany" : "repo.worktree.inUse", { count: w.openTabs, title: w.tab?.title ?? "" }) };
    return worktreeRemove(await cliDiscovery().buildEnv(), { repo: w.repo, path: w.path, branch: w.branch, base: "" }, { force: true });
  });
  ipcMain.handle(IPC.wtRemove, async (_e, tabId: string, opts: { force?: boolean }) => {
    const wt = workspaces.tab(tabId)?.worktree;
    if (!wt) return { ok: false, error: mt("repo.worktree.notIsolated") };
    // 세션이 그 경로에서 돌고 있으면 먼저 멈춘다 (경로가 사라진다).
    if (sessions.isBusy(tabId)) return { ok: false, error: mt("repo.worktree.busy") };
    const r = await worktreeRemove(await cliDiscovery().buildEnv(), wt, opts);
    if (!r.ok) return r;
    // 탭은 원본 저장소로 돌아가고 provider 세션은 새로 시작한다 (경로가 바뀌므로).
    workspaces.clearWorktree(tabId);
    sessions.configure(tabId, { cwd: wt.repo });
    return r;
  });

  ipcMain.handle(IPC.tabDelete, async (_e, tabId: string) => {
    if (typeof tabId !== "string") return { ok: false, error: mt("main.error.badTabId") };
    // 격리 세션 탭: 먼저 턴과 터미널을 멈춘 뒤 worktree 를 정리한다(실행 중인 CLI 발밑에서 디렉토리가 사라지지 않게).
    // 커밋되지 않은 변경이 있으면 worktree 와 탭을 그대로 두고 알린다(데이터 보호).
    const wt = workspaces.tab(tabId)?.worktree;
    if (wt) {
      sessions.abort(tabId);
      terminals.closePrefix(`${tabId}:`);
      const r = await worktreeRemove(await cliDiscovery().buildEnv(), wt);
      if (!r.ok)
        return {
          ok: false,
          error: mt("repo.worktree.tabKept", { error: r.error }),
        };
    }
    terminals.closePrefix(`${tabId}:`);
    workspaces.deleteTab(tabId);
    return { ok: true };
  });
  ipcMain.on(IPC.tabSetVisible, (_e, tabIds: unknown) => {
    if (Array.isArray(tabIds)) workspaces.setVisibleTabs(tabIds.filter((x): x is string => typeof x === "string"));
  });
  ipcMain.handle(IPC.tabActivate, (_e, tabId: string) => {
    const r = workspaces.activateTab(tabId);
    if (typeof tabId === "string") void sessions.warm(tabId); // 보고 있는 탭은 첫 메시지 전에 프로세스를 띄워 둔다
    return r;
  });
  ipcMain.handle(IPC.tabRename, (_e, tabId: string, title: string) =>
    workspaces.renameTab(tabId, title),
  );
  ipcMain.handle(IPC.tabReorder, (_e, ids: string[]) =>
    workspaces.reorderTabs(ids),
  );
  ipcMain.handle(IPC.workspaceReorder, (_e, ids: string[]) =>
    workspaces.reorderWorkspaces(ids),
  );

  ipcMain.handle(IPC.usageQuery, (_e, filter: UsageFilter) =>
    querySummary(filter),
  );
  ipcMain.handle(IPC.usageStatus, () => usageStatus());
  ipcMain.handle(IPC.usageRefreshLimits, async () => {
    const [claude] = await Promise.all([
      (async () => {
        try {
          const runtime = await claudeRuntime();
          const text = await fetchUsageText(runtime, app.getPath("home"), (l) =>
            console.log(`[usage-probe] ${l}`),
          );
          const parsed = parseUsageText(text, Date.now());
          const lines = text.split("\n").filter((l) => l.startsWith("Current"));
          console.log(
            `[usage] /usage: ${lines.join(" | ") || text.slice(0, 200).replace(/\n/g, " ")}`,
          );
          if (!parsed)
            console.warn("[usage] /usage 출력을 해석하지 못했습니다.");
          return parsed;
        } catch (e) {
          console.warn("[usage] Claude 한도 새로고침 실패:", e);
          return null;
        }
      })(),
      usage.scan(),
    ]);
    if (claude) {
      // /usage 텍스트에 초기화 시각이 없으면 이전 관측값의 시각을 유지한다.
      const prev = store.loadRateLimits().claude ?? null;
      const keep = (
        w: RateLimitWindowDto | null,
        old: RateLimitWindowDto | null | undefined,
      ) =>
        w && w.resetsAt === 0 && old?.resetsAt
          ? { ...w, resetsAt: old.resetsAt }
          : w;
      store.saveRateLimit("claude", {
        ...claude,
        session: keep(claude.session, prev?.session),
        weekly: keep(claude.weekly, prev?.weekly),
        modelWeekly: claude.modelWeekly
          ? {
              ...claude.modelWeekly,
              ...keep(claude.modelWeekly, prev?.modelWeekly),
            }
          : null,
      });
    }
    sendAll(IPC.usageChanged, null);
    return usageStatus();
  });
  ipcMain.handle(IPC.usageRescan, async () => {
    await usage.scan();
    return usageStatus();
  });
  ipcMain.handle(IPC.usageExport, async (e, filter: UsageFilter) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: join(
        app.getPath("downloads"),
        `sudal-usage-${new Date().toISOString().slice(0, 10)}.csv`,
      ),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeFileSync(
      r.filePath,
      usageCsv(usage.records(), filter, pricing()),
      "utf8",
    );
    return r.filePath;
  });
  ipcMain.handle(IPC.usageSettingsGet, (): UsageSettingsDto => {
    const { monthlyBudgetUsd } = usageSettings();
    return { monthlyBudgetUsd };
  });
  ipcMain.handle(
    IPC.usageSettingsSet,
    (_e, patch: Partial<UsageSettingsDto>): UsageSettingsDto => {
      const cur = usageSettings();
      const next = { ...cur, ...patch };
      // 예산을 바꾸면 이번 달 알림을 다시 허용한다.
      if ("monthlyBudgetUsd" in patch) delete next.budgetAlertedMonth;
      store.saveSettings(next);
      checkBudget();
      return { monthlyBudgetUsd: next.monthlyBudgetUsd };
    },
  );
}

// ===== Menu (단축키는 메뉴가 받아 renderer 로 넘긴다 — ⌘W 가 창을 닫지 않게 하기 위해서도 필요) =====

function shortcut(
  label: string,
  accelerator: string,
  name: ShortcutName,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, win) => {
      const target = (win as BrowserWindow | undefined) ?? mainWindow;
      if (target && !target.isDestroyed())
        target.webContents.send(IPC.shortcut, name);
    },
  };
}

let menuBuilt = false;

function buildMenu() {
  const tabItems: MenuItemConstructorOptions[] = [];
  for (let n = 1; n <= 9; n++) {
    tabItems.push(shortcut(mt("main.menu.tabN", { n }), `CmdOrCtrl+${n}`, `tab-${n as 1}`));
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: mt("main.menu.file"),
      submenu: [
        shortcut(mt("main.menu.newSession"), "CmdOrCtrl+T", "new-tab"),
        shortcut(mt("main.menu.reopenTab"), "CmdOrCtrl+Shift+T", "reopen-tab"),
        shortcut(mt("main.menu.closeTab"), "CmdOrCtrl+W", "close-tab"),
        { type: "separator" },
        shortcut(mt("main.menu.switchWorkspace"), "CmdOrCtrl+K", "switch-workspace"),
        shortcut(mt("main.menu.searchChat"), "CmdOrCtrl+F", "search"),
      ],
    },
    { role: "editMenu" },
    {
      label: mt("main.menu.view"),
      submenu: [
        // ⌘R 은 브라우저 탭 새로고침에 준다 — 창 새로고침은 개발용이라 메뉴에서만 쓴다
        { role: "reload", accelerator: "" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        shortcut(mt("main.menu.sidebar"), "CmdOrCtrl+B", "toggle-sidebar"),
        shortcut(mt("main.menu.terminalPanel"), "CmdOrCtrl+J", "toggle-terminal"),
        shortcut(mt("main.menu.widenEditor"), "CmdOrCtrl+Shift+E", "toggle-editor-maximize"),
        { type: "separator" },
        shortcut(mt("main.menu.browserAddress"), "CmdOrCtrl+L", "browser-address"),
        shortcut(mt("main.menu.browserReload"), "CmdOrCtrl+R", "browser-reload"),
        shortcut(mt("main.menu.browserHardReload"), "CmdOrCtrl+Shift+R", "browser-hard-reload"),
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: mt("main.menu.tab"),
      submenu: [
        shortcut(mt("main.menu.nextTab"), "Ctrl+Tab", "next-tab"),
        shortcut(mt("main.menu.prevTab"), "Ctrl+Shift+Tab", "prev-tab"),
        { type: "separator" },
        shortcut(mt("main.menu.nextAttention"), "CmdOrCtrl+Shift+Down", "next-attention"),
        shortcut(mt("main.menu.prevAttention"), "CmdOrCtrl+Shift+Up", "prev-attention"),
        { type: "separator" },
        ...tabItems,
      ],
    },
    {
      label: mt("main.menu.window"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  menuBuilt = true;
}

// ===== Window =====

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // 첫 페인트 전 흰 화면이 번쩍이지 않게 테마 배경색으로 시작한다(값은 styles.css 의 --color-bg 와 같다).
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1216" : "#f6f7fb",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 인앱 브라우저 탭(<webview>). 붙을 때의 제한은 아래 web-contents-created 의 will-attach-webview 에서 건다.
      webviewTag: true,
    },
  });
  // 채팅의 링크 등으로 메인 창 자체가 다른 페이지로 가면 안 된다 — 외부 브라우저로 돌린다.
  win.webContents.on("will-navigate", (e, url) => {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return;
    e.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url);
  });

  win.on("ready-to-show", () => {
    win.show();
    // 시작 직후 보고 있는 탭을 예열한다(창이 뜬 뒤라 체감 지연이 없다)
    setTimeout(() => {
      const active = workspaces?.state().model.activeTabId;
      if (active) void sessions?.warm(active);
    }, 1500);
  });
  // 창에 포커스가 돌아오면 보고 있던 탭의 완료/오류 표시를 지운다.
  win.on("focus", () => {
    for (const id of workspaces?.visibleTabIds() ?? []) attention?.viewed(id);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return win;
}

hardenWebviews();
// 한 번에 한 인스턴스만: 두 개가 같은 userData(workspaces.json·threads·localStorage)를 번갈아 쓰면 서로의 저장분을 덮어쓴다.
// 두 번째로 켜면 먼저 떠 있는 창을 앞으로 가져온다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}
app.whenReady().then(async () => {
  bootstrap();
  registerIpc();
  buildMenu();
  // 브라우저 탭의 실패한 요청 수집 — webRequest 는 세션에 한 번만 걸 수 있어 창보다 먼저 건다
  watchBrowserNetwork();
  // 세션 쿠키 되돌리기도 창보다 먼저 — 첫 페이지부터 로그인 상태여야 한다.
  if (appSettings().keepBrowserLogin) {
    const n = await restoreSessionCookies(session.fromPartition(BROWSER_PARTITION), app.getPath("userData"));
    if (n > 0) console.log(`[browser] 세션 쿠키 ${n}개 복원`);
  }
  startBackgroundJobWatcher();
  startSchedules();
  void startControlServer();
  mainWindow = createWindow();
  // 자동 업데이트는 붙이지 않는다 — 새 버전은 GitHub Releases 의 DMG 를 다시 받아 덮어쓴다(scripts/release.sh).
  // 붙이려면 electron-updater 를 다시 넣고 electron-builder 의 publish 를 GitHub provider 로 바꾼다.
  // 다만 서명·공증이 없으면 자동 설치는 Gatekeeper 에 막혀 알림까지만 된다.

  // 시작 시 탐지 결과를 콘솔에 남긴다 — 설정 화면과 별개로 로그만으로 진단 가능.
  for (const provider of ["claude", "codex"] as const) {
    void cliStatus(provider).then((s) =>
      console.log(
        `[cli] ${provider}:`,
        s.installed ? `${s.path} (${s.version ?? "?"})` : s.error,
      ),
    );
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

// 창 닫힘 ≠ 세션 종료. 앱이 실제로 끝날 때 모든 SDK 프로세스를 abort 하고 버퍼를 디스크에 내린다.
/** 세션 쿠키 저장은 비동기다 — 종료를 한 번만 미루고, 두 번째 호출에서 원래 정리를 한다. */
let sessionCookiesSaved = false;
app.on("before-quit", (e) => {
  if (!sessionCookiesSaved && appSettings().keepBrowserLogin) {
    sessionCookiesSaved = true;
    e.preventDefault();
    void saveSessionCookies(session.fromPartition(BROWSER_PARTITION), app.getPath("userData"))
      .then((n) => console.log(`[browser] 세션 쿠키 ${n}개 저장`))
      .catch(() => {})
      .finally(() => app.quit());
    return;
  }
  orchestrator?.stop();
  verifyRunner.dispose();
  previewServer.close();
  controlServer?.close();
  try {
    rmSync(join(app.getPath("userData"), "control.json"), { force: true });
  } catch {
    /* 무시 */
  }
  lsp?.stopAll();
  sessions?.shutdown();
  terminals?.closeAll();
  usage?.unwatch();
  store?.flush();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
