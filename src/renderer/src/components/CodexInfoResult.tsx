import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { codexHooks, codexMemory, codexPlugins, codexResultErrorMessage, codexSessionInfo, codexTerminals } from "@shared/codex-command-results";
import { PERMISSION_POLICIES } from "@shared/chat-events";
import { Icon } from "./Icon";

export function CodexInfoResult({ command, data }: { command: "status" | "ps" | "hooks" | "plugins" | "memories" | "fast" | "stop" | "debug-config"; data: unknown }) {
  const { t } = useTranslation();
  if (command === "status") return <StatusResult data={data} />;
  if (command === "ps") return <TerminalResult data={data} />;
  if (command === "hooks") return <HooksResult data={data} />;
  if (command === "plugins") return <PluginsResult data={data} />;
  if (command === "memories") return <MemoryResult data={data} />;
  if (command === "debug-config") return <DebugResult data={data} />;
  const row = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (command === "fast" && typeof row.fast === "boolean") return <Confirmation text={t(row.fast ? "session.codexResult.fastEnabled" : "session.codexResult.fastDisabled")} />;
  if (command === "stop" && row.stopped === true) return <Confirmation text={t("session.codexResult.terminalsStopped")} note={t("session.codexResult.stopNote")} />;
  return <ResultEmpty text={t("session.codexResult.infoUnavailable")} />;
}

function StatusResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const info = useMemo(() => codexSessionInfo(data), [data]);
  const status = ["idle", "running", "queued", "waiting_permission", "error"].includes(info.status ?? "") ? t(`chat.status.${info.status as "idle" | "running" | "queued" | "waiting_permission" | "error"}`) : null;
  const policy = (PERMISSION_POLICIES as readonly unknown[]).includes(info.policy) ? t(`panel.context.policy.${info.policy as typeof PERMISSION_POLICIES[number]}.codexLabel`) : null;
  return <dl className="divide-y divide-line rounded-xl border border-line px-4" data-session-info>
    <InfoRow label={t("session.codexResult.sessionState")} value={status} />
    <InfoRow label={t("session.codexResult.modelSetting")} value={info.model} />
    <InfoRow label={t("session.codexResult.permissionSetting")} value={policy} />
    <InfoRow label={t("session.codexResult.modeSetting")} value={info.mode === "plan" ? t("session.codexUi.planOn") : info.mode === "default" ? t("session.codexUi.planOff") : null} />
    <InfoRow label={t("session.codexResult.directory")} value={info.cwd} mono />
    <InfoRow label={t("session.codexResult.branch")} value={info.branch} mono />
    <InfoRow label={t("session.codexResult.queuedPrompts")} value={info.pending === null ? null : String(info.pending)} />
    <InfoRow label={t("session.codexResult.controller")} value={info.controller === "app" ? t("session.codexResult.chatController") : info.controller === "terminal" ? t("session.codexResult.terminalController") : null} />
    <InfoRow label={t("session.codexResult.sessionId")} value={info.id} mono />
    <InfoRow label={t("session.codexResult.cliVersion")} value={info.cliVersion} />
  </dl>;
}

function InfoRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  const { t } = useTranslation();
  return <div className="grid grid-cols-[minmax(72px,1fr)_minmax(0,3fr)] gap-4 py-3 text-xs"><dt className="text-muted">{label}</dt><dd className={`select-text whitespace-pre-wrap break-all ${mono ? "mono" : ""} ${value === null ? "text-muted-2" : "text-fg"}`}>{value ?? t("session.codexResult.infoUnavailable")}</dd></div>;
}

function TerminalResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const result = useMemo(() => codexTerminals(data), [data]);
  if (!result.available) return <ResultEmpty text={t("session.codexResult.infoUnavailable")} />;
  return <SearchableRows items={result.items} keyOf={row => row.id} textOf={row => `${row.command} ${row.cwd ?? ""} ${row.pid ?? ""}`} empty={t("session.codexResult.noTerminals")} render={row => <article className="rounded-xl border border-line p-4" data-background-terminal>
    <pre className="mono select-text whitespace-pre-wrap break-all text-xs leading-relaxed">{row.command}</pre>
    {row.cwd && <p className="mono mt-2 select-text break-all text-[11px] text-muted">{row.cwd}</p>}
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[11px] text-muted">
      {row.pid !== null && <span>PID <span className="mono text-fg">{row.pid}</span></span>}
      <span>CPU <span className="mono text-fg">{row.cpu === null ? "—" : `${Math.round(row.cpu * 10) / 10}%`}</span></span>
      <span>{t("session.codexResult.processMemory")} <span className="mono text-fg">{row.rssKb === null ? "—" : `${Math.round(row.rssKb / 1024 * 10) / 10} MB`}</span></span>
    </div>
  </article>} />;
}

function HooksResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const result = useMemo(() => codexHooks(data), [data]);
  if (!result.available) return <ResultEmpty text={t("session.codexResult.infoUnavailable")} />;
  return <><ResultMessages messages={result.messages} /><SearchableRows items={result.items} keyOf={row => row.key} textOf={row => `${row.event} ${row.matcher ?? ""} ${row.command ?? ""} ${row.path ?? ""}`} empty={t("session.codexResult.noHooks")} render={row => <article className="rounded-xl border border-line p-4" data-hook-result>
    <div className="flex flex-wrap items-center gap-2"><h4 className="mono text-xs font-medium">{row.event}</h4>{["command", "mcpTool", "prompt", "agent"].includes(row.type ?? "") && <span className="text-[10px] text-muted">{t(`session.codexResult.hookTypes.${row.type as "command" | "mcpTool" | "prompt" | "agent"}`)}</span>}<StateBadge label={t(row.enabled === true ? "session.codexResult.enabled" : row.enabled === false ? "session.codexResult.disabled" : "session.codexResult.unknownState")} active={row.enabled === true} />{row.trust && <StateBadge label={t(row.trust === "trusted" ? "session.codexResult.trusted" : row.trust === "managed" ? "session.codexResult.managed" : row.trust === "modified" ? "session.codexResult.modified" : row.trust === "untrusted" ? "session.codexResult.untrusted" : "session.codexResult.unknownState")} warning={row.trust === "untrusted" || row.trust === "modified"} />}</div>
    {row.description && <p className="mt-2 text-xs text-muted">{row.description}</p>}
    {row.matcher && <p className="mt-2 text-xs text-muted">{t("session.codexResult.hookMatcher")}: <code className="select-text break-all text-fg">{row.matcher}</code></p>}
    {row.path && <p className="mono mt-2 select-text break-all text-[10px] text-muted-2">{row.path}</p>}
    {row.command && <details className="mt-3 border-t border-line pt-2 text-xs"><summary className="cursor-pointer text-muted">{t("session.codexResult.executionDetails")}</summary><pre className="mono mt-2 select-text whitespace-pre-wrap break-all rounded-md bg-panel-2 p-3 text-[11px]">{row.command}</pre></details>}
  </article>} /></>;
}

function PluginsResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const result = useMemo(() => codexPlugins(data), [data]);
  if (!result.available) return <ResultEmpty text={t("session.codexResult.infoUnavailable")} />;
  return <><ResultMessages messages={result.errors} /><SearchableRows items={result.items} keyOf={row => row.key} textOf={row => `${row.name} ${row.description ?? ""} ${row.developer ?? ""} ${row.marketplace}`} empty={t("session.codexResult.noPlugins")} render={row => <article className="rounded-xl border border-line p-4" data-plugin-result>
    <div className="flex flex-wrap items-center gap-2"><h4 className="min-w-0 break-words text-sm font-medium">{row.name}</h4><StateBadge label={t(`session.codexResult.pluginState.${row.state}`)} active={row.state === "enabled"} warning={row.state === "unavailable"} />{row.version && <span className="mono text-[10px] text-muted">v{row.version}</span>}</div>
    {row.description && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted" title={row.description}>{row.description}</p>}
    <p className="mt-2 break-words text-[10px] text-muted-2">{[row.marketplace, row.developer].filter(Boolean).join(" · ")}</p>
    {row.reason && <p className="mt-2 text-xs text-warn">{t(row.reason === "disabled_by_admin" ? "session.codexResult.pluginReason.admin" : row.reason === "plan_not_eligible" ? "session.codexResult.pluginReason.plan" : row.reason === "required_app_unavailable" ? "session.codexResult.pluginReason.app" : "session.codexResult.pluginReason.unknown")}</p>}
  </article>} /></>;
}

function MemoryResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const result = codexMemory(data);
  if (result.mode) return <Confirmation text={t(result.mode === "enabled" ? "session.codexResult.memoryEnabled" : "session.codexResult.memoryDisabled")} />;
  if (!result.available) return <ResultEmpty text={t("session.codexResult.infoUnavailable")} />;
  if (!result.summary) return <ResultEmpty text={t("session.codexResult.noMemory")} />;
  return <article className="rounded-xl border border-line p-4" data-memory-summary><div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-xs text-muted">{t("session.codexResult.memorySummary")}</h4><CopyText getText={() => result.summary!} /></div><div className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed">{result.summary}</div></article>;
}

function DebugResult({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <div className="rounded-xl border border-line p-4"><p className="mb-3 text-xs leading-relaxed text-muted">{t("session.codexResult.debugNote")}</p><CopyText getText={() => JSON.stringify(data ?? {}, null, 2)} /><details className="mt-3" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-muted">{t("session.codexResult.rawConfig")}</summary>{open && <pre className="mono mt-3 max-h-80 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg bg-panel-2 p-3 text-[11px]">{JSON.stringify(data ?? {}, null, 2)}</pre>}</details></div>;
}

function CopyText({ getText }: { getText: () => string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false), [error, setError] = useState<string | null>(null);
  return <><button onClick={() => { void navigator.clipboard.writeText(getText()).then(() => { setCopied(true); setError(null); }).catch(error => setError(codexResultErrorMessage(error))); }} className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg">{t(copied ? "session.codexResult.copied" : "session.codexResult.copy")}</button>{error && <span role="alert" className="ml-2 text-xs text-err">{error}</span>}</>;
}

function Confirmation({ text, note }: { text: string; note?: string }) { return <div role="status" className="rounded-xl border border-line p-4" data-command-confirmation><div className="flex items-start gap-2 text-sm"><Icon name="check" size={16} className="mt-0.5 shrink-0 text-ok" /><p>{text}</p></div>{note && <p className="mt-2 text-xs leading-relaxed text-muted">{note}</p>}</div>; }
function StateBadge({ label, active, warning }: { label: string; active?: boolean; warning?: boolean }) { return <span className={`rounded px-1.5 py-0.5 text-[10px] ${warning ? "bg-warn-bg text-warn" : active ? "bg-ok-bg text-ok" : "bg-panel-2 text-muted"}`}>{label}</span>; }
export function ResultEmpty({ text }: { text: string }) { return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs leading-relaxed text-muted">{text}</p>; }
function ResultMessages({ messages }: { messages: { text: string; path: string | null; error: boolean }[] }) { return <div className="space-y-2">{messages.map((message, index) => <div key={index} role={message.error ? "alert" : "status"} className={`mb-3 rounded-lg p-3 text-xs ${message.error ? "bg-err-bg text-err" : "bg-warn-bg text-warn"}`}>{message.path && <p className="mono mb-1 break-all text-[10px]">{message.path}</p>}<p className="select-text whitespace-pre-wrap break-words">{message.text}</p></div>)}</div>; }

function SearchableRows<T>({ items, keyOf, textOf, render, empty }: { items: T[]; keyOf: (row: T) => string; textOf: (row: T) => string; render: (row: T) => ReactNode; empty: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(""), [visible, setVisible] = useState(50);
  const filtered = useMemo(() => { const search = query.trim().toLocaleLowerCase(); return search ? items.filter(row => textOf(row).toLocaleLowerCase().includes(search)) : items; }, [items, query, textOf]);
  useEffect(() => setVisible(50), [query]);
  if (!items.length) return <ResultEmpty text={empty} />;
  return <div><label className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-muted"><Icon name="search" size={14} /><input aria-label={t("session.codexResult.searchResults")} placeholder={t("session.codexResult.searchResults")} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none" /></label><p className="mb-3 text-[11px] text-muted">{t("session.codexResult.items", { count: filtered.length })}</p>{!filtered.length ? <ResultEmpty text={t("session.codexResult.noMatches")} /> : <div className="space-y-3">{filtered.slice(0, visible).map(row => <div key={keyOf(row)}>{render(row)}</div>)}</div>}{filtered.length > visible && <button onClick={() => setVisible(count => count + 50)} className="mt-3 rounded border border-line px-3 py-1.5 text-xs text-muted">{t("session.codexResult.moreResults", { count: filtered.length - visible })}</button>}</div>;
}
