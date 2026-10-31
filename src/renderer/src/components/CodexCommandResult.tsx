import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { codexMcpServers, codexUsageGroups, type CodexMcpServer, type CodexUsageWindow, type FormattedCodexCommand } from "@shared/codex-command-results";
import { userErrorMessage } from "@shared/error-message";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import { Icon } from "./Icon";
import { CodexInfoResult } from "./CodexInfoResult";

export function CodexCommandResult({ command, argument = "", initialData, onRefresh }: { command: FormattedCodexCommand; argument?: string; initialData: unknown; onRefresh: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const kind = command === "debug-config" ? "debugConfig" : command;
  const refreshable = command !== "fast" && command !== "stop" && !(command === "memories" && argument !== "");
  useEffect(() => { request.current++; setData(initialData); setLoading(false); setError(null); }, [initialData]);
  useEffect(() => () => { request.current++; }, []);
  const refresh = async () => {
    const id = ++request.current;
    setLoading(true); setError(null);
    try { const next = await onRefresh(); if (request.current === id) setData(next); }
    catch (e) { if (request.current === id) setError(userErrorMessage(e)); }
    finally { if (request.current === id) setLoading(false); }
  };
  return <section data-codex-result={command} aria-busy={loading}>
    <div className="mb-4 flex items-start justify-between gap-3">
      <div><h3 className="text-sm font-medium">{t(`session.codexResult.${kind}Title`)}</h3><p className="mt-1 text-xs leading-relaxed text-muted">{t(`session.codexResult.${kind}Help`)}</p></div>
      {refreshable && <button disabled={loading} onClick={() => void refresh()} className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50" data-command-refresh>
        <Icon name="refresh" size={12} className={loading ? "animate-spin motion-reduce:animate-none" : ""} />{t("session.codexResult.refresh")}
      </button>}
    </div>
    {error && <p role="alert" className="mb-3 whitespace-pre-wrap rounded-md bg-err-bg p-3 text-xs text-err">{error}</p>}
    {command === "usage" ? <UsageResult data={data} /> : command === "mcp" ? <McpResult data={data} /> : <CodexInfoResult command={command} data={data} />}
  </section>;
}

function UsageResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const result = useMemo(() => codexUsageGroups(data), [data]);
  return <div className="space-y-3">
    {result.ordinaryUsageAllowed === false && <p className="flex items-start gap-2 rounded-lg bg-warn-bg p-3 text-xs text-warn"><Icon name="alert" size={14} className="shrink-0" />{t("session.codexResult.usageRestricted")}</p>}
    {!result.groups.length && <EmptyResult text={t("session.codexResult.noUsage")} />}
    {result.groups.map(group => <article key={group.id} className="rounded-xl border border-line p-4" data-usage-group>
      <header className="mb-4 flex flex-wrap items-center gap-2"><h4 className="min-w-0 break-words font-medium">{group.name}</h4>{group.plan && <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{group.plan.replace(/_/g, " ")}</span>}</header>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))" }}>
        {group.windows.map(window => <UsageWindow key={window.kind} window={window} />)}
      </div>
      {!group.windows.length && <p className="text-xs text-muted">{t("session.codexResult.noWindows")}</p>}
      {group.credits && <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3 text-xs"><span className="text-muted">{t("session.codexResult.credits")}</span><span>{group.credits.unlimited ? t("session.codexResult.unlimited") : group.credits.balance !== null ? group.credits.balance : t(group.credits.available === false ? "session.codexResult.noCredits" : "session.codexResult.creditsUnknown")}</span></div>}
    </article>)}
  </div>;
}

function UsageWindow({ window: value }: { window: CodexUsageWindow }) {
  const { t, i18n } = useTranslation();
  const minutes = value.minutes;
  const label = minutes !== null && minutes % 1440 === 0 ? t("nav.limits.days", { count: minutes / 1440 }) : minutes !== null && minutes % 60 === 0 ? t("nav.limits.hours", { count: minutes / 60 }) : minutes !== null ? t("session.codexResult.minutes", { count: minutes }) : t(value.kind === "primary" ? "session.codexResult.primaryWindow" : "session.codexResult.secondaryWindow");
  const reset = value.resetsAt ? new Date(value.resetsAt * 1000) : null;
  const color = value.usedPercent >= 100 ? "text-err" : value.usedPercent >= 80 ? "text-warn" : "text-fg";
  return <div data-usage-window>
    <div className="mb-2 flex items-baseline justify-between gap-2"><span className="text-xs text-muted">{label}</span><span className={`mono text-xl font-medium tabular-nums ${color}`}>{Math.round(value.usedPercent)}<span className="ml-0.5 text-xs font-normal text-muted">%</span></span></div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value.usedPercent} aria-valuetext={t("nav.limits.used", { percent: Math.round(value.usedPercent) })} className="h-1.5 overflow-hidden rounded-full bg-panel-2">
      <div className={`h-full rounded-full ${value.usedPercent >= 100 ? "bg-err" : value.usedPercent >= 80 ? "bg-warn" : "bg-accent"}`} style={{ width: `${value.usedPercent}%` }} />
    </div>
    <p className="mt-1.5 text-[10px] text-muted-2">{t("nav.limits.used", { percent: Math.round(value.usedPercent) })}</p>
    <div className="mt-3 flex items-start gap-1.5 text-[11px] text-muted"><Icon name="clock" size={12} className="mt-0.5 shrink-0" />{reset ? <time dateTime={reset.toISOString()}>{t("session.codexResult.resetsAt", { time: reset.toLocaleString(intlLocale(i18n.language as Locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</time> : t("session.codexResult.resetUnknown")}</div>
  </div>;
}

function McpResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const servers = useMemo(() => codexMcpServers(data), [data]);
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const filtered = servers.filter(server => !search || server.name.toLocaleLowerCase().includes(search) || server.tools.some(tool => `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLocaleLowerCase().includes(search)));
  return <div>
    <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" data-mcp-summary><span>{t("session.codexResult.servers", { count: servers.length })}</span><span>{t("session.codexResult.connected", { count: servers.filter(server => server.status === "connected").length })}</span><span>{t("session.codexResult.tools", { count: servers.reduce((sum, server) => sum + server.tools.length, 0) })}</span></div>
    {servers.length > 0 && <label className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-muted"><Icon name="search" size={14} /><input aria-label={t("session.codexResult.searchTools")} placeholder={t("session.codexResult.searchTools")} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none" /></label>}
    {!servers.length ? <EmptyResult text={t("session.codexResult.noServers")} /> : !filtered.length ? <EmptyResult text={t("session.codexResult.noMatches")} /> : <div className="space-y-3">{filtered.map(server => <McpServer key={server.name} server={server} search={search} />)}</div>}
  </div>;
}

function McpServer({ server, search }: { server: CodexMcpServer; search: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(100);
  const id = useId();
  useEffect(() => { if (search) setOpen(true); setVisible(100); }, [search]);
  const tools = !search || server.name.toLocaleLowerCase().includes(search) ? server.tools : server.tools.filter(tool => `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLocaleLowerCase().includes(search));
  const tone = server.status === "connected" ? "bg-ok-bg text-ok" : server.status === "failed" ? "bg-err-bg text-err" : server.status === "authenticationRequired" || server.status === "starting" ? "bg-warn-bg text-warn" : "bg-panel-2 text-muted";
  return <article className="overflow-hidden rounded-xl border border-line" data-mcp-server>
    <button onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={id} className="flex w-full items-start gap-3 p-4 text-left hover:bg-panel-2/40">
      <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="break-all text-sm font-medium">{server.name}</span><span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{t(`session.codexResult.mcpStatus.${server.status}`)}</span></span><span className="mt-1.5 block text-[11px] text-muted">{t(`session.codexResult.mcpAuth.${server.auth}`)}{server.version ? ` · v${server.version}` : ""}</span>{server.origin && <span className="mono mt-1 block truncate text-[10px] text-muted-2">{server.origin}</span>}</span>
      <span className="mt-0.5 flex shrink-0 items-center gap-2 text-[11px] text-muted">{t("session.codexResult.tools", { count: server.tools.length })}<Icon name="chevronDown" size={13} className={open ? "rotate-180" : ""} /></span>
    </button>
    {(server.auth === "notLoggedIn" || server.status === "authenticationRequired") && <p className="px-4 pb-3 text-xs leading-relaxed text-warn">{t("session.codexResult.needsAuth")}</p>}
    {server.toolsError && <p className="mx-4 mb-3 whitespace-pre-wrap break-words rounded-lg bg-err-bg p-3 text-xs text-err">{server.toolsError}</p>}
    {open && <div id={id} className="border-t border-line px-4 pb-3 pt-1">
      {!tools.length && <p className="py-3 text-xs text-muted">{t(server.toolsError ? "session.codexResult.toolsUnavailable" : "session.codexResult.noTools")}</p>}
      {tools.slice(0, visible).map(tool => <div key={tool.name} className="border-b border-line py-3 last:border-b-0" data-mcp-tool><div className="break-all text-xs font-medium">{tool.title ?? tool.name}</div>{tool.title && <div className="mono mt-0.5 break-all text-[10px] text-muted-2">{tool.name}</div>}{tool.description && <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted" title={tool.description}>{tool.description}</p>}</div>)}
      {tools.length > visible && <button onClick={() => setVisible(value => value + 100)} className="my-2 rounded border border-line px-2 py-1 text-xs text-muted hover:text-fg">{t("session.codexResult.moreTools", { count: tools.length - visible })}</button>}
      {(server.resources.length > 0 || server.templateCount > 0) && <details className="mt-2 border-t border-line pt-3 text-xs text-muted"><summary className="cursor-pointer">{t("session.codexResult.resources", { count: server.resources.length })} · {t("session.codexResult.templates", { count: server.templateCount })}</summary>{server.resources.map((resource, index) => <div className="mt-2" key={index}><span className="text-fg">{resource.name}</span>{resource.description && <p className="mt-1 text-[11px]">{resource.description}</p>}</div>)}</details>}
    </div>}
  </article>;
}

function EmptyResult({ text }: { text: string }) { return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs leading-relaxed text-muted">{text}</p>; }
