import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { intlLocale, LANGUAGE_SETTINGS, type Locale } from "@shared/i18n/locale";
import {
  MAX_CONCURRENT_MAX,
  MAX_CONCURRENT_MIN,
  NEW_TAB_POLICIES,
  PROVIDERS,
  SESSION_IDLE_MINUTES_MAX,
  SESSION_IDLE_MINUTES_MIN,
  type AppInfoDto,
  type AppSettingsDto,
  type ManagedWorktreeDto,
  type InstallStatusDto,
  type CliCandidateDto,
  type CliDiagnosticsDto,
  type CliStatusDto,
  type LspStatusDto,
  type McpServerStatusDto,
  type Provider,
  type UpdateCheckDto,
  type WarmTarget,
} from "@shared/ipc";
import type { NotifyOnDone } from "@shared/ipc";
import { THEME_MODES } from "@shared/theme";
import { applyThemeMode } from "../theme";
import { Icon } from "../components/Icon";
import { SchedulesSection } from "../components/SchedulesSection";
import { ProviderLogo } from "../components/ProviderLogo";
import sudari from "../assets/otter/idle-0.png";
import { OTTER_ROAM, OTTER_ROAM_RANGE, type OtterRoamTuning } from "@shared/otter";
import { shortenHome } from "@shared/path-display";
import { IS_WIN } from "../platform";
import { getLinkOpenMode, setLinkOpenMode, type LinkOpenMode } from "../link-open";
import { useSnippets } from "../hooks/useSnippets";
import { updatePhaseLabel, useUpdateStatus } from "../hooks/useUpdate";
import { snippetSummary, type SnippetDto } from "@shared/snippets";
import { Logo } from "../components/Logo";

export type SettingsSection = "general" | "cli" | "mcp" | "snippets" | "schedules";

const LABEL: Record<Provider, [string, string]> = {
  claude: ["Claude Code", "Anthropic"],
  codex: ["Codex CLI", "OpenAI"],
};

interface ProviderState {
  status: CliStatusDto | null;
  candidates: CliCandidateDto[];
  loading: boolean;
  /** null 이면 없음. 빈 문자열은 "저장 실패" 를 뜻하며 문구는 그릴 때 번역한다. */
  message: string | null;
}

const initial = (): ProviderState => ({ status: null, candidates: [], loading: true, message: null });

export function SettingsView({
  info,
  workspaces,
  workspacePath,
  section,
  onSection,
}: {
  info: AppInfoDto | null;
  /** 스니펫 범위 표시·선택용 워크스페이스 목록. */
  workspaces: { id: string; name: string }[];
  /** MCP 상태를 조회할 기준 디렉토리(현재 워크스페이스). 없으면 MCP 화면은 안내만. */
  workspacePath: string | null;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<Record<Provider, ProviderState>>({
    claude: initial(),
    codex: initial(),
  });
  const [diag, setDiag] = useState<CliDiagnosticsDto | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [override, setOverride] = useState<{ provider: Provider; path: string }>({ provider: "claude", path: "" });

  const load = useCallback(async (provider: Provider) => {
    setState((s) => ({ ...s, [provider]: { ...s[provider], loading: true } }));
    try {
      const [status, candidates] = await Promise.all([
        window.sudal.cli.status(provider),
        window.sudal.cli.candidates(provider),
      ]);
      setState((s) => ({ ...s, [provider]: { status, candidates, loading: false, message: null } }));
    } catch (e) {
      setState((s) => ({
        ...s,
        [provider]: { ...s[provider], loading: false, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  const loadAll = useCallback(async () => {
    const started = Date.now();
    await Promise.all(PROVIDERS.map(load));
    setDiag(await window.sudal.cli.diagnostics());
    setScannedAt(Date.now() - started);
  }, [load]);

  const rescan = async () => {
    await window.sudal.cli.refresh();
    await loadAll();
  };

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const applyOverride = async (provider: Provider, binPath: string | null) => {
    const result = await window.sudal.cli.setOverride(provider, binPath);
    if (!result.ok) {
      setState((s) => ({ ...s, [provider]: { ...s[provider], message: result.message ?? "" } }));
      return;
    }
    setOverride((o) => ({ ...o, path: "" }));
    await load(provider);
  };

  const detected = PROVIDERS.filter((p) => state[p].status?.installed).length;
  const pathIssues = diag?.missingInApp.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-14 shrink-0 items-center px-6 mac:h-[84px] mac:pt-7">
        <div>
          <div className="text-[15px] font-semibold">{t("settings.nav.title")}</div>
          <div className="text-[11px] text-muted">{t("settings.nav.description")}</div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-[200px] shrink-0 px-3 py-5">
          <div className="label px-3 pb-2">{t("settings.nav.group")}</div>
          {(
            [
              { id: "general", icon: "settings" },
              { id: "cli", icon: "terminal" },
              { id: "mcp", icon: "list" },
              { id: "snippets", icon: "copy" },
              { id: "schedules", icon: "clock" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              onClick={() => onSection(item.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left ${
                section === item.id ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2/60 hover:text-fg"
              }`}
            >
              <Icon name={item.icon} size={13} />
              {t(`settings.nav.${item.id}`)}
            </button>
          ))}
          <div className="px-3 py-2 text-muted-2">
            Git <span className="label ml-1">{t("settings.nav.soon")}</span>
          </div>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-[940px]">
            {section === "general" ? (
              <GeneralSection />
            ) : section === "mcp" ? (
              <McpSection workspacePath={workspacePath} />
            ) : section === "snippets" ? (
              <SnippetsSection workspaces={workspaces} />
            ) : section === "schedules" ? (
              <SchedulesSection defaultCwd={workspacePath} />
            ) : (
              <>
            <div className="mb-5 flex items-start justify-between gap-6">
              <div>
                <h1 className="text-[20px] font-semibold">{t("settings.cli.title")}</h1>
                <p className="mt-1 text-muted">{t("settings.cli.description")}</p>
              </div>
              <button
                onClick={() => void rescan()}
                className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 font-medium text-on-primary hover:bg-primary-hover"
              >
                <Icon name="refresh" size={13} />
                {t("settings.cli.rescan")}
              </button>
            </div>

            <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
              <span className={`h-2 w-2 rounded-full ${scannedAt === null ? "bg-muted animate-pulse" : "bg-ok"}`} />
              <span className="font-medium">{scannedAt === null ? t("settings.cli.scanning") : t("settings.cli.scanned")}</span>
              <span className="text-muted">
                {t("settings.cli.connectable", { count: detected })}{pathIssues > 0 ? ` · ${t("settings.cli.shellFound", { count: pathIssues })}` : ""}
              </span>
              <span className="mono ml-auto text-[10px] text-muted">
                {scannedAt !== null && `${(scannedAt / 1000).toFixed(1)}s`}
              </span>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {PROVIDERS.map((p) => (
                <ProviderCard
                  key={p}
                  provider={p}
                  state={state[p]}
                  onSelect={(path) => void applyOverride(p, path)}
                  onReset={() => void applyOverride(p, null)}
                />
              ))}
            </div>

            <div className="mb-4">
              <LspCard />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-line bg-panel p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Icon name="branch" size={14} className="text-accent" />
                  {t("settings.cli.pathDiag")}
                </div>
                {diag ? (
                  <>
                    {diag.missingInApp.length > 0 ? (
                      // 앱은 셸 PATH 를 항상 합쳐 쓰므로 이건 경고가 아니라 "어디서 찾았는지" 안내다.
                      diag.missingInApp.map((m) => (
                        <div key={m.dir} className="mb-2 rounded-md border border-line bg-panel-2/60 px-3 py-2" data-path-note>
                          <div className="flex items-center gap-2 font-medium">
                            <Icon name="info" size={12} className="shrink-0 text-muted" />
                            {t("settings.cli.foundInShell", { name: LABEL[m.provider][0] })}
                          </div>
                          <div className="mono mt-1 break-all text-[11px] text-muted" title={m.dir}>
                            {m.dir}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted">
                            {t("settings.cli.foundInShellNote")}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className={`mb-2 rounded-md border px-3 py-2 ${detected > 0 ? "border-ok/30 bg-ok-bg text-ok" : "border-line text-muted"}`}>
                        {detected > 0 ? t("settings.cli.pathVerified") : t("settings.cli.pathPending")}
                      </div>
                    )}
                    <dl className="mono mt-3 grid grid-cols-[110px_1fr] gap-y-1.5 text-[10.5px]">
                      <dt className="label">{t("settings.cli.loginShell")}</dt>
                      <dd className="truncate text-right text-ok">{diag.loginShell}</dd>
                      <dt className="label">{t("settings.cli.appPath")}</dt>
                      <dd className="truncate text-right text-muted" title={diag.appPathDirs.join(":")}>
                        {t("settings.cli.dirs", { count: diag.appPathDirs.length })}
                      </dd>
                      <dt className="label">{t("settings.cli.shellPath")}</dt>
                      <dd className="truncate text-right text-muted" title={diag.shellPathDirs.join(":")}>
                        {t("settings.cli.dirs", { count: diag.shellPathDirs.length })}
                      </dd>
                      <dt className="label">{t("settings.cli.method")}</dt>
                      <dd className="truncate text-right text-muted">{t("settings.cli.methodValue")}</dd>
                    </dl>
                  </>
                ) : (
                  <p className="text-muted">{t("settings.cli.diagnosing")}</p>
                )}
              </div>

              <div className="rounded-lg border border-line bg-panel p-4">
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <Icon name="edit" size={14} className="text-accent" />
                  {t("settings.cli.overrideTitle")}
                </div>
                <p className="mb-3 text-[11px] text-muted">
                  {t("settings.cli.overrideDescription")}
                </p>
                <div className="flex gap-2">
                  <select
                    value={override.provider}
                    onChange={(e) => setOverride((o) => ({ ...o, provider: e.target.value as Provider }))}
                    className="rounded-md border border-line bg-bg px-2 py-1.5"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {LABEL[p][0]}
                      </option>
                    ))}
                  </select>
                  <input
                    value={override.path}
                    onChange={(e) => setOverride((o) => ({ ...o, path: e.target.value }))}
                    placeholder="/absolute/path/to/executable"
                    className="mono min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent/50"
                    style={{ userSelect: "text" }}
                  />
                  <button
                    disabled={!override.path.trim()}
                    onClick={() => void applyOverride(override.provider, override.path.trim())}
                    className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40"
                  >
                    {t("common.apply")}
                  </button>
                </div>
              </div>
            </div>

            {info && (
              <div className="mono mt-6 space-y-1 text-[10px] text-muted">
                <p>{t("settings.cli.dataPath", { path: info.userDataPath })}</p>
                <p>
                  {t("settings.cli.logFile", { path: info.logPath })}{" "}
                  <button
                    onClick={() => void window.sudal.app.openLogs()}
                    className="ml-1 rounded border border-line px-1.5 py-0.5 hover:bg-panel-2"
                  >
                    {t("settings.openFolder")}
                  </button>
                </p>
              </div>
            )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== 일반 =====

// 선택지는 값만 든다. 문구는 사전(settings.<카드>.options.<값>)에서 그릴 때 가져온다 — 언어를 바꾸면 따라오게.
const LINK_MODE_OPTIONS: LinkOpenMode[] = ["ask", "app", "external"];
const WARM_OPTIONS: WarmTarget[] = ["active", "off"];
const NOTIFY_OPTIONS: NotifyOnDone[] = ["always", "unfocused", "off"];

// 알림 문구는 state 에 번역해서 담지 않는다. 종류와 값만 두고 그릴 때 번역한다.
type Notice =
  | { ok: boolean; text: string }
  | { ok: true; saved: true }
  | { ok: false; range: "idle" | "concurrent"; min: number; max: number };

function noticeText(t: TFunction, n: Notice): string {
  if ("text" in n) return n.text;
  if ("saved" in n) return t("settings.saved");
  return t(`settings.outOfRange.${n.range}`, { min: n.min, max: n.max });
}

type InstallNotice = { ok: boolean; text: string } | { ok: true; cli: string } | { ok: true; skills: string };

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; r: UpdateCheckDto }
  | { kind: "upgrading"; target: string; r?: UpdateCheckDto }
  | { kind: "done"; version: string }
  | { kind: "error"; text: string; r?: UpdateCheckDto };

/**
 * GitHub 최신 릴리즈와 비교하고, Homebrew 로 설치한 앱이면 brew 로 올린 뒤 다시 시작한다.
 * 진행·완료·실패는 main 이 들고 있는 상태에서 그대로 그린다(사이드바와 같은 것을 본다) — 이 카드가 따로 들고 있는 것은
 * "지금 확인을 눌러 기다리는 중" 과 그 확인이 실패한 내용뿐이다.
 */
function UpdateCard() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const status = useUpdateStatus();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    window.sudal.app.info().then((i) => setVersion(i.version));
  }, []);

  const r = status?.check ?? undefined;
  const st: UpdateState = status?.installed
    ? { kind: "done", version: status.installed }
    : status?.running
      ? { kind: "upgrading", target: status.running, r }
      : checking
        ? { kind: "checking" }
        : status?.error
          ? { kind: "error", text: status.error, r }
          : checkError
            ? { kind: "error", text: checkError, r }
            : r
              ? { kind: "checked", r }
              : { kind: "idle" };

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await window.sudal.app.checkUpdate();
    } catch (e) {
      setCheckError(t("settings.update.checkFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setChecking(false);
    }
  };
  // 결과는 상태 알림으로 온다. 실행 자체가 거절되면(예외) 그 내용만 여기서 보인다.
  const run = () => {
    setCheckError(null);
    window.sudal.app.runUpdate().catch((e: unknown) => setCheckError(e instanceof Error ? e.message : String(e)));
  };
  const openRelease = (url: string) => void window.sudal.browser.openExternal(url);

  const btn = "shrink-0 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40";

  return (
    <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="update">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <Icon name="refresh" size={14} className="text-accent" />
        {t("settings.update.title")}
      </div>
      <p className="mb-3 text-[12px] leading-5 text-muted">{t(IS_WIN ? "settings.update.descriptionWin" : "settings.update.description")}</p>
      <div className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{t("settings.update.currentVersion")}</span>
            <span className="mono text-[11.5px] text-muted">{version ?? "…"}</span>
          </div>
          {/* data-update-state 의 값으로 상태를 본다(e2e 가 문구에 기대지 않게) */}
          <div className="text-[11.5px] text-muted" data-update-state={st.kind}>
            {st.kind === "idle" && t("settings.update.idle")}
            {st.kind === "checking" && t("settings.update.checking")}
            {st.kind === "checked" && (st.r.available ? <span className="text-warn">{t("settings.update.available", { version: st.r.latest })}</span> : <span className="text-ok">{t("settings.update.latest")}</span>)}
            {st.kind === "checked" && st.r.available && !st.r.brew && ` ${t(IS_WIN ? "settings.update.notBrewWin" : "settings.update.notBrew")}`}
            {st.kind === "upgrading" && (
              <span data-update-phase={status?.phase}>
                {t("settings.update.upgrading", { version: st.target })} <span className="text-accent">{status?.running ? updatePhaseLabel(t, status) : ""}</span>
              </span>
            )}
            {st.kind === "done" && <span className="text-ok">{t("settings.update.done", { version: st.version })}</span>}
          </div>
        </div>
        {r?.available && (
          <button onClick={() => openRelease(r.releaseUrl)} className={btn} data-update-notes>
            {r.brew ? t("settings.update.notes") : t("settings.update.releasePage")}
          </button>
        )}
        {st.kind === "done" ? (
          <button onClick={() => void window.sudal.app.relaunch()} className={btn} data-update-relaunch>
            {t("settings.update.relaunch")}
          </button>
        ) : st.kind === "upgrading" || (r?.available && r.brew) ? (
          <button onClick={run} disabled={st.kind === "upgrading"} className={btn} data-update-run>
            {t("settings.update.run")}
          </button>
        ) : (
          <button onClick={() => void check()} disabled={st.kind === "checking"} className={btn} data-update-check>
            {t("settings.update.check")}
          </button>
        )}
      </div>
      {st.kind === "error" && (
        <pre className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-err" data-update-error>
          {st.text}
        </pre>
      )}
    </div>
  );
}

function GeneralSection() {
  const { t } = useTranslation();
  const [linkMode, setLinkModeState] = useState<LinkOpenMode>(() => getLinkOpenMode());
  const [settings, setSettings] = useState<AppSettingsDto | null>(null);
  const [idleDraft, setIdleDraft] = useState("");
  const [concurrentDraft, setConcurrentDraft] = useState("");
  const [msg, setMsg] = useState<Notice | null>(null);

  const adopt = (s: AppSettingsDto) => {
    setSettings(s);
    setIdleDraft(String(s.sessionIdleMinutes));
    setConcurrentDraft(String(s.maxConcurrent));
  };
  useEffect(() => {
    window.sudal.app.getSettings().then(adopt);
  }, []);

  const save = async (patch: Partial<AppSettingsDto>) => {
    try {
      adopt(await window.sudal.app.setSettings(patch));
      setMsg({ ok: true, saved: true });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  /** 숫자 입력 하나를 저장한다. 범위 밖이면 저장하지 않고 이유를 보여 준다. */
  const saveNumber = (key: "sessionIdleMinutes" | "maxConcurrent", draft: string, min: number, max: number, range: "idle" | "concurrent") => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || n > max) {
      setMsg({ ok: false, range, min, max });
      return;
    }
    if (settings && Math.round(n) === settings[key]) return;
    void save({ [key]: Math.round(n) });
  };
  const saveIdle = () => saveNumber("sessionIdleMinutes", idleDraft, SESSION_IDLE_MINUTES_MIN, SESSION_IDLE_MINUTES_MAX, "idle");
  const saveConcurrent = () => saveNumber("maxConcurrent", concurrentDraft, MAX_CONCURRENT_MIN, MAX_CONCURRENT_MAX, "concurrent");
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const [installMsg, setInstallMsg] = useState<InstallNotice | null>(null);
  const [installed, setInstalled] = useState<InstallStatusDto | null>(null);
  const refreshInstalled = () => window.sudal.app.installStatus().then(setInstalled).catch(() => setInstalled(null));
  useEffect(() => {
    void refreshInstalled();
  }, []);
  const installCli = async () => {
    const r = await window.sudal.app.installCli();
    void refreshInstalled();
    if (!r.ok) setInstallMsg({ ok: false, text: r.error });
    else if (r.hint) setInstallMsg({ ok: false, text: r.hint });
    else setInstallMsg({ ok: true, cli: shortenHome(r.path) });
  };
  const installSkill = async (agent: Provider) => {
    const r = await window.sudal.app.installSkill(agent);
    void refreshInstalled();
    if (!r.ok) setInstallMsg({ ok: false, text: r.error });
    else setInstallMsg({ ok: true, skills: r.paths.map(shortenHome).join(", ") });
  };
  /** 설치 항목 행: 상태 점·문구·버튼 글자를 한 곳에서 정한다. */
  const installRows = () => {
    const rows: { key: string; name: string; path: string; state: string; tone: string; dot: string; button: string; disabled: boolean; action: () => Promise<void> }[] = [];
    const cli = installed?.cli;
    rows.push({
      key: "cli",
      name: "sudal CLI",
      // 설치 위치는 운영체제마다 달라 main 이 알려 준 값을 그대로 쓴다
      path: cli?.path ?? "",
      state: !cli ? "" : !cli.installed ? t("settings.install.notInstalled") : !cli.current ? t("settings.install.otherApp") : !cli.onPath ? t(IS_WIN ? "settings.install.needsPathWin" : "settings.install.needsPath") : t("settings.install.installed"),
      tone: !cli || !cli.installed ? "text-muted" : cli.current && cli.onPath ? "text-ok" : "text-warn",
      dot: !cli || !cli.installed ? "bg-muted-2/50" : cli.current && cli.onPath ? "bg-ok" : "bg-warn",
      button: cli?.installed ? t("settings.install.reinstall") : t("settings.install.install"),
      disabled: !installed,
      action: installCli,
    });
    for (const s of installed?.skills ?? []) {
      rows.push({
        key: `skill-${s.agent}`,
        name: t("settings.install.skillName", { label: s.label }),
        path: s.path,
        state: !s.available ? t("settings.install.notFound") : !s.installed ? t("settings.install.notInstalled") : s.current ? t("settings.install.installed") : t("settings.install.outdated"),
        tone: !s.available || !s.installed ? "text-muted" : s.current ? "text-ok" : "text-warn",
        dot: !s.available || !s.installed ? "bg-muted-2/50" : s.current ? "bg-ok" : "bg-warn",
        button: !s.installed ? t("settings.install.install") : s.current ? t("settings.install.reinstall") : t("settings.install.update"),
        disabled: !s.available,
        action: () => installSkill(s.agent),
      });
    }
    return rows;
  };

  const radioCls = (on: boolean) => `flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${on ? "border-accent/50 bg-panel-2" : "border-line hover:bg-panel-2/60"}`;

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[20px] font-semibold">{t("settings.general.title")}</h1>
        <p className="mt-1 text-muted">{t("settings.general.description")}</p>
      </div>

      <UpdateCard />

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="language">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="globe" size={14} className="text-accent" />
          {t("settings.language.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.language.description")}</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {LANGUAGE_SETTINGS.map((v) => (
            <label key={v} className={radioCls(settings?.language === v)}>
              <input type="radio" name="language" value={v} checked={settings?.language === v} disabled={!settings} onChange={() => void save({ language: v })} className="mt-0.5" />
              <span>
                <span className="block font-medium">{t(`settings.language.options.${v}.label`)}</span>
                <span className="block text-[12px] leading-5 text-muted">{t(`settings.language.options.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="theme">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="sparkles" size={14} className="text-accent" />
          {t("settings.theme.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.theme.description")}</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {THEME_MODES.map((v) => (
            <label key={v} className={radioCls(settings?.theme === v)}>
              <input
                type="radio"
                name="theme"
                value={v}
                checked={settings?.theme === v}
                disabled={!settings}
                onChange={() => {
                  applyThemeMode(v); // 저장 응답을 기다리지 않고 바로 칠한다
                  void save({ theme: v });
                }}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{t(`settings.theme.options.${v}.label`)}</span>
                <span className="block text-[12px] leading-5 text-muted">{t(`settings.theme.options.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="notify">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="alert" size={14} className="text-accent" />
          {t("settings.notify.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.notify.description")}</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {NOTIFY_OPTIONS.map((v) => (
            <label key={v} className={radioCls(settings?.notifyOnDone === v)}>
              <input type="radio" name="notifyOnDone" value={v} checked={settings?.notifyOnDone === v} disabled={!settings} onChange={() => void save({ notifyOnDone: v })} className="mt-0.5" />
              <span>
                <span className="block font-medium">{t(`settings.notify.options.${v}.label`)}</span>
                <span className="block text-[12px] leading-5 text-muted">{t(`settings.notify.options.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="otter">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Logo size={14} className="text-accent" />
          {t("settings.otter.title")}
        </div>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.otter.description")}</p>
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                checked={settings?.otter ?? false}
                disabled={!settings}
                onChange={(e) => void save({ otter: e.target.checked })}
                data-otter-toggle
              />
              <span>{t("settings.otter.toggle")}</span>
            </label>
            <label className="mt-2 flex cursor-pointer items-center gap-2 pl-6 text-[12.5px] has-[:disabled]:cursor-default has-[:disabled]:opacity-50">
              <input
                type="checkbox"
                checked={settings?.otterRoam ?? false}
                disabled={!settings?.otter}
                onChange={(e) => void save({ otterRoam: e.target.checked })}
                data-otter-roam
              />
              <span>{t("settings.otter.roam")}</span>
            </label>
            {settings?.otter && settings.otterRoam && <RoamSliders settings={settings} onSave={save} />}
            <p className="mt-2 text-[12px] leading-5 text-muted-2">{t("settings.otter.hint")}</p>
          </div>
          <img src={sudari} alt="" className="h-20 w-20 shrink-0 select-none" draggable={false} data-otter-preview />
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="new-tab-policy">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="check" size={14} className="text-accent" />
          {t("settings.newTabPolicy.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.newTabPolicy.description")}</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {NEW_TAB_POLICIES.map((v) => (
            <label key={v} className={radioCls(settings?.newTabPolicy === v)}>
              <input type="radio" name="newTabPolicy" value={v} checked={settings?.newTabPolicy === v} disabled={!settings} onChange={() => void save({ newTabPolicy: v })} className="mt-0.5" />
              <span>
                <span className="block font-medium">{t(`settings.newTabPolicy.options.${v}.label`)}</span>
                <span className="block text-[12px] leading-5 text-muted">{t(`settings.newTabPolicy.options.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="cli">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="terminal" size={14} className="text-accent" />
          {t("settings.install.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          <Trans i18nKey="settings.install.description" components={{ code: <code /> }} />
        </p>
        <div className="divide-y divide-line rounded-md border border-line" data-install-list>
          {installRows().map((row) => (
            <div key={row.key} className="flex items-center gap-3 px-3 py-2" data-install-row={row.key}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${row.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{row.name}</span>
                  <span className={`text-[11px] ${row.tone}`} data-install-state>
                    {row.state}
                  </span>
                </div>
                <div className="mono truncate text-[10.5px] text-muted-2" title={row.path}>
                  {shortenHome(row.path)}
                </div>
              </div>
              <button
                onClick={() => void row.action()}
                disabled={row.disabled}
                className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                data-install-button={row.key}
              >
                {row.button}
              </button>
            </div>
          ))}
        </div>
        {installMsg && (
          <p className={`mono mt-2 text-[11px] ${installMsg.ok ? "text-ok" : "text-err"}`} data-install-msg>
            {"text" in installMsg
              ? installMsg.text
              : "cli" in installMsg
                ? t("settings.install.doneCli", { path: installMsg.cli })
                : t("settings.install.doneSkill", { paths: installMsg.skills })}
          </p>
        )}
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="keep-browser-login">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="shield" size={14} className="text-accent" />
          {t("settings.browserLogin.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          {t("settings.browserLogin.description1")}
          <br />
          {t("settings.browserLogin.description2")}
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            checked={settings?.keepBrowserLogin ?? true}
            disabled={!settings}
            onChange={(e) => void save({ keepBrowserLogin: e.target.checked })}
            data-keep-browser-login
          />
          <span>{t("settings.browserLogin.checkbox")}</span>
        </label>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="storage">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="folder" size={14} className="text-accent" />
          {t("settings.storage.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.storage.description")}</p>
        {settings && (
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-[12.5px]">
            <span className="text-muted">{t("settings.storage.appData")}</span>
            <span className="mono truncate text-[11.5px]" title={settings.dataDir} data-data-dir>
              {shortenHome(settings.dataDir)}
            </span>
            <button onClick={() => void window.sudal.app.openPath("data")} className="justify-self-end rounded-md border border-line px-2.5 py-1 hover:bg-panel-2">
              {t("settings.openFolder")}
            </button>

            <span className="text-muted">worktree</span>
            <span className="mono truncate text-[11.5px]" title={settings.worktreeDir} data-worktree-dir>
              {shortenHome(settings.worktreeDir)}
              {!settings.worktreeDirCustom && <span className="ml-1.5 font-sans text-muted">{t("settings.storage.isDefault")}</span>}
            </span>
            <span className="flex items-center gap-1.5 justify-self-end">
              <button onClick={() => void window.sudal.app.openPath("worktrees")} className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2">
                {t("settings.openFolder")}
              </button>
              <button
                onClick={() => void window.sudal.app.pickWorktreeDir().then(adopt)}
                className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2"
                data-worktree-dir-pick
              >
                {t("settings.storage.change")}
              </button>
              {settings.worktreeDirCustom && (
                <button onClick={() => void save({ worktreeDirCustom: false })} className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2" data-worktree-dir-reset>
                  {t("settings.storage.resetDefault")}
                </button>
              )}
            </span>
          </div>
        )}
        <WorktreeCleanup />
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="link-open">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="globe" size={14} className="text-accent" />
          {t("settings.link.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.link.description")}</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {LINK_MODE_OPTIONS.map((v) => (
            <label key={v} className={radioCls(linkMode === v)}>
              <input
                type="radio"
                name="linkOpenMode"
                value={v}
                checked={linkMode === v}
                onChange={() => {
                  setLinkOpenMode(v);
                  setLinkModeState(v);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{t(`settings.link.options.${v}.label`)}</span>
                <span className="block text-[12px] leading-5 text-muted">{t(`settings.link.options.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="warm">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="sparkles" size={14} className="text-accent" />
          {t("settings.warm.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.warm.description")}</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {WARM_OPTIONS.map((v) => (
            <label key={v} className={radioCls(settings?.warmTarget === v)}>
              <input
                type="radio"
                name="warmTarget"
                value={v}
                checked={settings?.warmTarget === v}
                disabled={!settings}
                onChange={() => void save({ warmTarget: v })}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{t(`settings.warm.options.${v}.label`)}</span>
                <span className="block text-[12px] leading-5 text-muted">{t(`settings.warm.options.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="idle">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="clock" size={14} className="text-accent" />
          {t("settings.idle.title")}
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.idle.description")}</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={SESSION_IDLE_MINUTES_MIN}
            max={SESSION_IDLE_MINUTES_MAX}
            value={idleDraft}
            disabled={!settings}
            onChange={(e) => setIdleDraft(e.target.value)}
            onBlur={saveIdle}
            onKeyDown={blurOnEnter}
            className="mono w-24 rounded-md border border-line bg-inset px-2.5 py-1.5 text-fg outline-none focus:border-accent/50"
            style={{ userSelect: "text" }}
            data-idle-minutes
          />
          <span className="text-muted">{t("settings.idle.unit")}</span>
          <span className="ml-2 text-[11.5px] text-muted-2">
            {t("settings.idle.range", { min: SESSION_IDLE_MINUTES_MIN, max: SESSION_IDLE_MINUTES_MAX })}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-4" data-setting="concurrent">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="list" size={14} className="text-accent" />
          {t("settings.concurrent.title")}
          <span className="label ml-1 rounded bg-panel-2 px-1.5 py-0.5 text-muted">{t("settings.concurrent.advanced")}</span>
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">{t("settings.concurrent.description")}</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MAX_CONCURRENT_MIN}
            max={MAX_CONCURRENT_MAX}
            value={concurrentDraft}
            disabled={!settings}
            onChange={(e) => setConcurrentDraft(e.target.value)}
            onBlur={saveConcurrent}
            onKeyDown={blurOnEnter}
            className="mono w-24 rounded-md border border-line bg-inset px-2.5 py-1.5 text-fg outline-none focus:border-accent/50"
            style={{ userSelect: "text" }}
            data-max-concurrent
          />
          <span className="text-muted">{t("settings.concurrent.unit")}</span>
          <span className="ml-2 text-[11.5px] text-muted-2">
            {t("settings.concurrent.range", { min: MAX_CONCURRENT_MIN, max: MAX_CONCURRENT_MAX })}
          </span>
        </div>
      </div>

      {msg && <p className={`mono mt-3 text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`}>{noticeText(t, msg)}</p>}
    </>
  );
}

// ===== MCP 서버 =====

const MCP_STATUS: Record<McpServerStatusDto["status"], { cls: string }> = {
  connected: { cls: "bg-ok-bg text-ok" },
  failed: { cls: "bg-err-bg text-err" },
  "needs-auth": { cls: "bg-warn-bg text-warn" },
  pending: { cls: "bg-panel-2 text-muted" },
  disabled: { cls: "bg-panel-2 text-muted-2" },
};

/**
 * 터미널 /mcp 화면의 앱 버전. SDK 컨트롤 요청으로 같은 정보(상태·에러·도구)를 읽기 전용으로 보여준다.
 * 재연결·토글은 세션 단위 프로세스에만 적용되어 이 앱(턴마다 새 프로세스)에선 의미가 없어 두지 않았다.
 */
function McpSection({ workspacePath }: { workspacePath: string | null }) {
  const { t, i18n } = useTranslation();
  const [servers, setServers] = useState<McpServerStatusDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    setError(null);
    try {
      setServers(await window.sudal.mcp.status(workspacePath));
      setCheckedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    setServers(null);
    void load();
  }, [load]);

  const counts = (servers ?? []).reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[20px] font-semibold">{t("settings.mcp.title")}</h1>
          <p className="mt-1 text-muted">
            <Trans i18nKey="settings.mcp.description" components={{ code: <code /> }} />
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading || !workspacePath}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
        >
          <Icon name="refresh" size={13} className={loading ? "animate-spin" : ""} />
          {t("settings.mcp.recheck")}
        </button>
      </div>

      {!workspacePath ? (
        <p className="text-muted">{t("settings.mcp.needWorkspace")}</p>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
            <span className={`h-2 w-2 rounded-full ${loading ? "bg-muted animate-pulse" : error ? "bg-err" : "bg-ok"}`} />
            <span className="font-medium">
              {loading ? t("settings.mcp.checking") : error ? t("settings.mcp.checkFailed") : t("settings.mcp.serverCount", { count: servers?.length ?? 0 })}
            </span>
            {!loading && !error && servers && (
              <span className="text-muted">
                {t("settings.mcp.summary", { connected: counts.connected ?? 0, failed: counts.failed ?? 0, needsAuth: counts["needs-auth"] ?? 0 })}
                {(counts.pending ?? 0) > 0 && ` · ${t("settings.mcp.pendingCount", { count: counts.pending })}`}
                {(counts.disabled ?? 0) > 0 && ` · ${t("settings.mcp.disabledCount", { count: counts.disabled })}`}
              </span>
            )}
            <span className="mono ml-auto truncate text-[10px] text-muted" title={workspacePath}>
              {shortenHome(workspacePath)}
              {checkedAt && ` · ${new Date(checkedAt).toLocaleTimeString(intlLocale(i18n.language as Locale))}`}
            </span>
          </div>
          {error && <div className="mb-4 rounded-md border border-err/40 bg-err-bg px-3 py-2 text-err">{error}</div>}

          <div className="flex flex-col gap-3">
            {servers?.map((s) => (
              <McpServerCard key={s.name} server={s} />
            ))}
            {servers && servers.length === 0 && !loading && <p className="text-muted">{t("settings.mcp.empty")}</p>}
          </div>
        </>
      )}
    </>
  );
}

function McpServerCard({ server: s }: { server: McpServerStatusDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const st = MCP_STATUS[s.status];
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="font-medium">{s.name}</span>
        <span className={`label rounded px-1.5 py-0.5 ${st.cls}`}>{t(`settings.mcp.status.${s.status}`)}</span>
        {s.scope && <span className="label">{s.scope}</span>}
        {s.serverInfo && (
          <span className="mono text-[10px] text-muted">
            {s.serverInfo.name} {s.serverInfo.version}
          </span>
        )}
        {s.tools.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="ml-auto flex items-center gap-1 text-muted hover:text-fg">
            {t("settings.mcp.tools", { count: s.tools.length })}
            <Icon name="chevronDown" size={12} className={open ? "rotate-180" : ""} />
          </button>
        )}
      </div>
      {s.target && (
        <div className="mono mt-1.5 truncate text-[10.5px] text-muted" title={s.target}>
          {s.transport && <span className="mr-2 uppercase">{s.transport}</span>}
          {s.target}
        </div>
      )}
      {s.error && (
        <div className="mono mt-2 whitespace-pre-wrap rounded-md bg-err-bg px-3 py-2 text-[11px] text-err" style={{ userSelect: "text" }}>
          {s.error}
        </div>
      )}
      {s.status === "needs-auth" && (
        <p className="mt-2 text-[11px] text-warn">
          <Trans i18nKey="settings.mcp.needsAuth" components={{ code: <code /> }} />
        </p>
      )}
      {open && (
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3">
          {s.tools.map((tool) => (
            <li key={tool.name} className="min-w-0">
              <div className="mono truncate text-[11.5px]">{tool.name}</div>
              {tool.description && <div className="truncate text-[10.5px] text-muted" title={tool.description}>{tool.description}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  state,
  onSelect,
  onReset,
}: {
  provider: Provider;
  state: ProviderState;
  onSelect: (path: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const { status, candidates, loading, message } = state;
  const installed = status?.installed ?? false;
  const [name, vendor] = LABEL[provider];

  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-center gap-3">
        <ProviderLogo provider={provider} size={36} />
        <div className="flex-1">
          <div className="text-[14px] font-semibold">{name}</div>
          <div className="text-[11px] text-muted">{vendor}</div>
        </div>
        <span
          className={`label rounded px-2 py-1 ${
            loading ? "bg-panel-2 text-muted" : installed ? "bg-ok-bg text-ok" : "bg-err-bg text-err"
          }`}
        >
          {loading ? t("settings.cli.scanning") : installed ? t("settings.status.connectable") : t("settings.status.notInstalled")}
        </span>
      </div>

      <div className="rounded-md bg-bg px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="label">{t("settings.cli.version")}</span>
          <span className="mono">{status?.version ?? (loading ? "…" : "-")}</span>
        </div>
        <div className="mono mt-1 truncate text-[10.5px] text-muted" title={status?.path ?? ""}>
          {status?.path ?? status?.error ?? ""}
        </div>
      </div>

      {message !== null && <p className="mt-2 text-warn">{message || t("settings.saveFailed")}</p>}

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
        <span>
          {status?.source === "override" ? t("settings.cli.customPath") : t("settings.cli.autoFind")}
          {candidates.length > 1 && ` · ${t("settings.cli.candidates", { count: candidates.length })}`}
        </span>
        {status?.source === "override" && (
          <button onClick={onReset} className="underline-offset-2 hover:underline">
            {t("settings.cli.backToAuto")}
          </button>
        )}
      </div>

      {candidates.length > 1 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
          {candidates.map((c) => (
            <li key={c.path}>
              <button
                disabled={!c.verified}
                onClick={() => onSelect(c.path)}
                className={`mono flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10.5px] ${
                  c.path === status?.path ? "bg-panel-2" : c.verified ? "hover:bg-panel-2/60" : "cursor-not-allowed opacity-50"
                }`}
              >
                <span className="truncate">{c.path}</span>
                <span className="ml-auto shrink-0 text-muted">{c.verified ? c.versionOutput : t("settings.cli.noResponse")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ===== 스니펫 =====

function SnippetsSection({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  const items = useSnippets();
  const [editing, setEditing] = useState<Partial<SnippetDto> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsName = (id: string | null) =>
    id === null ? t("settings.snippets.allWorkspaces") : (workspaces.find((w) => w.id === id)?.name ?? t("settings.snippets.deletedWorkspace"));
  const sorted = items
    .slice()
    .sort((a, b) => (a.workspaceId ?? "").localeCompare(b.workspaceId ?? "") || a.name.localeCompare(b.name));

  const save = async () => {
    if (!editing) return;
    const r = await window.sudal.snippets.save({
      id: editing.id,
      name: editing.name ?? "",
      text: editing.text ?? "",
      workspaceId: editing.workspaceId ?? null,
    });
    if (r.ok) {
      setEditing(null);
      setError(null);
    } else setError(r.error);
  };

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold">{t("settings.snippets.title")}</h1>
          <p className="mt-1 text-muted">
            <Trans i18nKey="settings.snippets.description" components={{ mono: <span className="mono" /> }} />
          </p>
        </div>
        <button
          onClick={() => {
            setEditing({ name: "", text: "", workspaceId: null });
            setError(null);
          }}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 font-medium text-on-primary hover:bg-primary-hover"
          data-snippet-new
        >
          <Icon name="plus" size={13} />
          {t("settings.snippets.new")}
        </button>
      </div>

      {editing && (
        <div className="mb-5 flex flex-col gap-2 rounded-lg border border-accent/40 bg-panel p-4" data-snippet-editor>
          <div className="flex gap-2">
            <label className="flex flex-1 items-center gap-2 rounded-md border border-line bg-inset px-2.5 py-1.5">
              <span className="mono text-muted">/</span>
              <input
                autoFocus
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder={t("settings.snippets.namePlaceholder")}
                className="mono min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
                style={{ userSelect: "text" }}
              />
            </label>
            <select
              value={editing.workspaceId ?? ""}
              onChange={(e) => setEditing({ ...editing, workspaceId: e.target.value || null })}
              className="rounded-md border border-line bg-inset px-2 py-1.5 text-fg outline-none"
            >
              <option value="">{t("settings.snippets.allWorkspaces")}</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={editing.text ?? ""}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            rows={5}
            placeholder={t("settings.snippets.bodyPlaceholder")}
            className="w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2 leading-5 text-fg outline-none placeholder:text-muted"
            style={{ userSelect: "text" }}
          />
          <div className="flex items-center gap-2">
            {error && <span className="text-err">{error}</span>}
            <button
              onClick={() => setEditing(null)}
              className="ml-auto rounded-md border border-line px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => void save()}
              className="rounded-md bg-primary px-3.5 py-1.5 font-medium text-on-primary hover:bg-primary-hover"
              data-snippet-editor-save
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-muted">
          {t("settings.snippets.empty")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2" data-snippet-list>
          {sorted.map((s) => (
            <li
              key={s.id}
              className="flex items-start gap-3 rounded-lg border border-line bg-panel px-4 py-3"
              data-snippet={s.name}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[13px] text-fg">/{s.name}</span>
                  <span className="label rounded bg-panel-2 px-1.5 py-0.5 text-muted">{wsName(s.workspaceId)}</span>
                </div>
                <p className="mt-1 truncate text-muted" title={s.text}>
                  {snippetSummary(s.text, 140)}
                </p>
              </div>
              <button
                onClick={() => {
                  setEditing({ ...s });
                  setError(null);
                }}
                className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
                title={t("common.edit")}
              >
                <Icon name="edit" size={13} />
              </button>
              <button
                onClick={() => void window.sudal.snippets.remove(s.id)}
                className="rounded-md p-1.5 text-muted hover:bg-err-bg hover:text-err"
                title={t("common.delete")}
                data-snippet-delete
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ===== 언어 서버 (TS/JS) =====

function LspCard() {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<LspStatusDto[] | null>(null);
  const load = useCallback(() => {
    window.sudal.lsp.status().then(setStatuses);
  }, []);
  useEffect(load, [load]);
  return (
    <div className="rounded-lg border border-line bg-panel p-4" data-lsp-card>
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Icon name="braces" size={14} className="text-accent" />
        {t("settings.lsp.title")}
      </div>
      <p className="mb-3 text-muted">{t("settings.lsp.description")}</p>
      <div className="flex flex-col gap-3">
        {(statuses ?? []).map((st) => (
          <LspServerRow key={st.serverId} status={st} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function LspServerRow({ status, onChanged }: { status: LspStatusDto; onChanged: () => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState(status.override ?? "");
  // 저장 안내는 종류만 두고 그릴 때 번역한다.
  const [msg, setMsg] = useState<{ ok: true; auto: boolean } | { ok: false; text: string } | null>(null);
  useEffect(() => setPath(status.override ?? ""), [status.override]);
  const save = async (p: string | null) => {
    const r = await window.sudal.lsp.setPath(status.serverId, p);
    setMsg(r.ok ? { ok: true, auto: !p } : { ok: false, text: r.error });
    onChanged();
  };
  return (
    <div className="rounded-md border border-line bg-panel-2/40 p-3" data-lsp-server={status.serverId}>
      <div className="mb-1.5 flex items-center gap-2 font-medium">
        {status.label}
        <span className={`label ml-auto rounded px-1.5 py-0.5 ${status.installed ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
          {status.installed ? t("settings.lsp.connectable", { version: status.version ?? t("settings.lsp.versionUnknown") }) : t("settings.status.notInstalled")}
        </span>
      </div>
      {!status.installed && (
        <p className="mb-2 text-muted">
          {t("settings.lsp.install")} <code className="mono rounded bg-inset px-1">{status.hint}</code>
        </p>
      )}
      {status.path && !status.override && (
        <div className="mono mb-2 truncate text-[11px] text-muted" title={status.path}>
          {t("settings.lsp.autoPath", { path: status.path })}
        </div>
      )}
      {status.installed && status.serverId === "typescript" && (
        <div className="mono mb-2 truncate text-[11px] text-muted" title={status.typescriptLib ?? ""}>
          TypeScript: {status.typescriptLib ?? t("settings.lsp.typescriptFallback")}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t("settings.lsp.pathPlaceholder")}
          className="mono min-w-0 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5 text-[11.5px] text-fg outline-none placeholder:text-muted"
          style={{ userSelect: "text" }}
          data-lsp-path={status.serverId}
        />
        <button onClick={() => void save(path.trim() || null)} className="rounded-md bg-primary px-3 py-1.5 font-medium text-on-primary hover:bg-primary-hover" data-lsp-save={status.serverId}>
          {t("common.save")}
        </button>
        {status.override && (
          <button onClick={() => void save(null)} className="rounded-md border border-line px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg">
            {t("settings.lsp.autoFind")}
          </button>
        )}
      </div>
      {msg && <p className={`mono mt-2 text-[10.5px] ${msg.ok ? "text-ok" : "text-err"}`}>{"text" in msg ? msg.text : msg.auto ? t("settings.lsp.savedAuto") : t("settings.lsp.savedPath")}</p>}
      {status.running.length > 0 && <p className="mono mt-2 text-[10.5px] text-muted">{t("settings.lsp.running", { list: status.running.join(", ") })}</p>}
    </div>
  );
}

/**
 * 남아 있는 worktree 정리. git 상태·크기를 재느라 몇 초 걸릴 수 있어 눌렀을 때 불러온다.
 * 열린 탭이 쓰는 것은 지울 수 없다(main 도 거부한다). 지우기 전에 한 번 더 묻고, 커밋 안 한 변경이 있으면 그 수를 알린다.
 */
function WorktreeCleanup() {
  const { t } = useTranslation();
  const [list, setList] = useState<ManagedWorktreeDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: true; path: string } | { ok: false; text: string } | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      setList(await window.sudal.worktree.listManaged());
    } finally {
      setLoading(false);
    }
  };
  const remove = async (w: ManagedWorktreeDto) => {
    setConfirm(null);
    const r = await window.sudal.worktree.removeManaged(w.path);
    setMsg(r.ok ? { ok: true, path: shortenHome(w.path) } : { ok: false, text: r.error });
    await load();
  };
  const size = (kb: number | null) => (kb === null ? t("settings.cleanup.sizeUnknown") : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)}GB` : kb >= 1024 ? `${Math.round(kb / 1024)}MB` : `${kb}KB`);
  const total = list?.reduce((n, w) => n + (w.sizeKb ?? 0), 0) ?? 0;
  return (
    <div className="mt-4 border-t border-line pt-3" data-worktree-cleanup>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-muted">
          {list === null ? t("settings.cleanup.unloaded") : list.length === 0 ? t("settings.cleanup.empty") : t("settings.cleanup.summary", { count: list.length, size: size(total) })}
        </span>
        <button onClick={() => void load()} disabled={loading} className="ml-auto rounded-md border border-line px-2.5 py-1 hover:bg-panel-2 disabled:opacity-50" data-worktree-list-load>
          {loading ? t("settings.cleanup.loading") : list === null ? t("settings.cleanup.showList") : t("common.refresh")}
        </button>
      </div>
      {list && list.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {list.map((w) => (
            <li key={w.path} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[12px] hover:bg-panel-2" data-worktree-row>
              <span className="min-w-0 flex-1">
                <span className="mono block truncate text-[11.5px]" title={w.path}>
                  {shortenHome(w.path)}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {w.branch || t("settings.cleanup.noBranch")} · {w.tab ? `${w.tab.title === w.branch ? "" : `${w.tab.title} `}${w.tab.open ? t("settings.cleanup.tabOpen") : t("settings.cleanup.tabClosed")}` : t("settings.cleanup.noTab")}
                  {w.dirty > 0 && <span className="text-warn"> · {t("settings.cleanup.dirty", { count: w.dirty })}</span>}
                </span>
              </span>
              <span className="mono shrink-0 text-[11px] text-muted">{size(w.sizeKb)}</span>
              {confirm === w.path ? (
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-err">{w.dirty > 0 ? t("settings.cleanup.dirtyLost", { count: w.dirty }) : t("settings.cleanup.confirm")}</span>
                  <button onClick={() => void remove(w)} className="rounded-md border border-err/40 px-2 py-0.5 text-err hover:bg-err/10" data-worktree-remove-confirm>
                    {t("common.delete")}
                  </button>
                  <button onClick={() => setConfirm(null)} className="rounded-md border border-line px-2 py-0.5 hover:bg-panel">
                    {t("common.cancel")}
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirm(w.path)}
                  disabled={w.openTabs > 0}
                  title={w.openTabs > 0 ? t("settings.cleanup.removeBlocked") : t("settings.cleanup.removeTitle")}
                  className="shrink-0 rounded-md border border-line px-2 py-0.5 hover:bg-panel disabled:opacity-40"
                  data-worktree-remove
                >
                  {t("common.delete")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <div className={`mt-2 text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`}>{"text" in msg ? msg.text : t("settings.cleanup.removed", { path: msg.path })}</div>}
    </div>
  );
}

const ROAM_KEYS = { pauseSec: "otterRoamPauseSec", runPct: "otterRoamRunPct", distancePct: "otterRoamDistancePct" } as const;

/** 돌아다니기 슬라이더. 끄는 동안은 화면 값만 바꾸고, 손을 떼면 저장한다(끌 때마다 저장하면 설정 파일을 수십 번 쓴다). */
function RoamSliders({ settings, onSave }: { settings: AppSettingsDto; onSave: (patch: Partial<AppSettingsDto>) => Promise<void> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Partial<OtterRoamTuning>>({});
  const value = (k: keyof OtterRoamTuning) => draft[k] ?? settings[ROAM_KEYS[k]];
  const commit = (k: keyof OtterRoamTuning) => {
    const v = draft[k];
    if (v === undefined) return;
    setDraft((d) => ({ ...d, [k]: undefined }));
    if (v !== settings[ROAM_KEYS[k]]) void onSave({ [ROAM_KEYS[k]]: v });
  };
  const label = (k: keyof OtterRoamTuning, v: number) => {
    if (k === "runPct") return `${v}%`;
    if (k === "distancePct") {
      const px = ([lo, hi]: [number, number]) => `${Math.round((lo * v) / 100)}~${Math.round((hi * v) / 100)}`;
      return t("settings.otter.roamDistanceValue", { walk: px(OTTER_ROAM.distance.walk), run: px(OTTER_ROAM.distance.run) });
    }
    const m = Math.floor(v / 60);
    const s = v % 60;
    return m === 0 ? t("settings.otter.roamEverySec", { s }) : s === 0 ? t("settings.otter.roamEveryMin", { m }) : t("settings.otter.roamEveryMinSec", { m, s });
  };
  return (
    // 값 칸은 고정 폭이다 — 거리 값은 끌 때마다 글자 길이가 바뀌어, 늘어나는 칸이면 슬라이더가 줄었다 늘었다 한다.
    <div className="mt-3 grid grid-cols-[auto_1fr_232px] items-center gap-x-3 gap-y-2 pl-6 text-[12px]" data-otter-roam-sliders>
      {(Object.keys(ROAM_KEYS) as (keyof OtterRoamTuning)[]).map((k) => {
        const r = OTTER_ROAM_RANGE[k];
        const v = value(k);
        return (
          <label key={k} className="contents">
            <span className="text-muted">{t(`settings.otter.roamSlider.${k}`)}</span>
            <input
              type="range"
              min={r.min}
              max={r.max}
              step={r.step}
              value={v}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: Number(e.target.value) }))}
              onPointerUp={() => commit(k)}
              onKeyUp={() => commit(k)}
              onBlur={() => commit(k)}
              className="w-full accent-accent"
              data-otter-roam-slider={k}
            />
            <span className="truncate whitespace-nowrap text-right tabular-nums text-muted">{label(k, v)}</span>
          </label>
        );
      })}
    </div>
  );
}
