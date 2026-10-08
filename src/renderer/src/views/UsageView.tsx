import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import type {
  Provider,
  ProviderRateLimitDto,
  RateLimitWindowDto,
  UsageSettingsDto,
  UsageStatusDto,
} from "@shared/ipc";
import {
  pctChange,
  periodRange,
  tokensTotal,
  type Period,
  type UsageFilter,
  type UsageSummary,
} from "@shared/usage";
import { Icon } from "../components/Icon";
import { StackedBars, type StackedPoint } from "../components/StackedBars";
import { baseName, shortenHome } from "@shared/path-display";

const PERIODS: Period[] = ["today", "7d", "30d", "month"];

// dataviz 검증 통과 팔레트 (light, 인접 쌍 CVD ΔE ≥ 13). 입력=인디고, 캐시=틸, 출력=앰버.
const SERIES = [
  { key: "input", color: "#696FEA" },
  { key: "cacheRead", color: "#2A9D8F" },
  { key: "output", color: "#C98A1E" },
] as const;

export function UsageView() {
  const { t, i18n } = useTranslation();
  const loc = intlLocale(i18n.language as Locale);
  const [period, setPeriod] = useState<Period>("30d");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [cwd, setCwd] = useState<string | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [wsOptions, setWsOptions] = useState<{ cwd: string; name: string }[]>(
    [],
  );
  const [status, setStatus] = useState<UsageStatusDto | null>(null);
  const [settings, setSettings] = useState<UsageSettingsDto>({
    monthlyBudgetUsd: null,
  });
  const [monthCost, setMonthCost] = useState<number | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const [exported, setExported] = useState<string | null>(null);
  const [hideCache, setHideCache] = useState(false);

  const filter = useMemo<UsageFilter>(
    () => ({ ...periodRange(period, Date.now()), provider, cwd }),
    [period, provider, cwd],
  );

  const load = useCallback(async () => {
    const [s, st, all, month, cfg] = await Promise.all([
      window.sudal.usage.query(filter),
      window.sudal.usage.status(),
      window.sudal.usage.query({ ...filter, cwd: null }),
      window.sudal.usage.query({
        ...periodRange("month", Date.now()),
        provider: "all",
      }),
      window.sudal.usage.getSettings(),
    ]);
    setSummary(s);
    setStatus(st);
    setWsOptions(all.byWorkspace.map((w) => ({ cwd: w.cwd, name: w.name })));
    setMonthCost(month.totals.costUsd);
    setSettings(cfg);
    setBudgetInput(cfg.monthlyBudgetUsd ? String(cfg.monthlyBudgetUsd) : "");
  }, [filter]);

  useEffect(() => {
    void load();
    return window.sudal.usage.onChanged(() => void load());
  }, [load]);

  const saveBudget = async () => {
    const n = Number(budgetInput);
    const next = await window.sudal.usage.setSettings({
      monthlyBudgetUsd: Number.isFinite(n) && n > 0 ? n : null,
    });
    setSettings(next);
  };

  const exportCsv = async () => {
    const p = await window.sudal.usage.exportCsv(filter);
    setExported(p);
    if (p) setTimeout(() => setExported(null), 4000);
  };

  const points: StackedPoint[] = useMemo(
    () =>
      (summary?.daily ?? []).map((d) => ({
        label: d.day.slice(5).replace("-", "/"),
        title: d.day,
        values: {
          input: d.input + d.cacheWrite,
          cacheRead: hideCache ? 0 : d.cacheRead,
          output: d.output,
        },
        extra: `$${d.costUsd.toFixed(2)} · ${t("usage.requestCount", { count: d.requests })}`,
      })),
    [summary, hideCache, t],
  );
  const chartSeries = (hideCache
    ? SERIES.filter((s) => s.key !== "cacheRead")
    : [...SERIES]
  ).map((s) => ({ ...s, label: t(`usage.series.${s.key}`) }));

  const tot = summary?.totals;
  const prev = summary?.previous;
  const totalTokens = tot ? tokensTotal(tot) : 0;
  const limits = status?.rateLimits;
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const refreshLimits = async () => {
    if (refreshingLimits) return;
    setRefreshingLimits(true);
    try {
      setStatus(await window.sudal.usage.refreshLimits());
    } finally {
      setRefreshingLimits(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-14 shrink-0 items-center justify-between px-6 mac:h-[84px] mac:pt-7">
        <div>
          <div className="text-[15px] font-semibold">{t("usage.title")}</div>
          <div className="text-[11px] text-muted">
            {t("usage.description")}
          </div>
        </div>
        <div className="no-drag mono flex items-center gap-2 text-[10px] text-muted">
          {status?.scanning
            ? t("usage.scanning")
            : status?.lastScanAt
              ? t("usage.scanInfo", { count: status.files, time: fmtTime(status.lastScanAt, loc) })
              : ""}
          <button
            onClick={() => void window.sudal.usage.rescan().then(setStatus)}
            className="rounded-md border border-line p-1.5 hover:bg-panel-2"
            title={t("usage.rescanTitle")}
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-4">
          {/* 필터 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-line bg-panel p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`rounded px-3 py-1 ${period === p ? "bg-accent-tint text-accent" : "text-muted hover:text-fg"}`}
                >
                  {t(`usage.period.${p}`)}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-line bg-panel p-0.5">
              {(["all", "claude", "codex"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`rounded px-3 py-1 ${provider === p ? "bg-accent-tint text-accent" : "text-muted hover:text-fg"}`}
                >
                  {p === "all" ? t("usage.providerAll") : p === "claude" ? "Claude" : "Codex"}
                </button>
              ))}
            </div>
            <Select
              value={cwd ?? ""}
              onChange={(v) => setCwd(v || null)}
              icon="folder"
            >
              <option value="">{t("usage.allWorkspaces")}</option>
              {wsOptions.map((w) => (
                <option key={w.cwd} value={w.cwd}>
                  {w.name} — {shortenHome(w.cwd)}
                </option>
              ))}
            </Select>
            <button
              onClick={() => void exportCsv()}
              className="ml-auto flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 hover:bg-panel-2"
            >
              <Icon name="file" size={13} />
              {t("usage.exportCsv")}
            </button>
          </div>
          {exported && (
            <p className="mono text-[11px] text-ok">{t("usage.saved", { path: exported })}</p>
          )}

          {/* KPI */}
          <div className="grid grid-cols-4 gap-4">
            <Kpi
              label={t("usage.kpi.totalTokens")}
              value={fmtTokens(totalTokens)}
              delta={
                tot && prev ? pctChange(totalTokens, tokensTotal(prev)) : null
              }
              icon="usage"
            />
            <Kpi
              label={t("usage.kpi.estCost")}
              value={tot ? fmtUsd(tot.costUsd) : "-"}
              delta={tot && prev ? pctChange(tot.costUsd, prev.costUsd) : null}
              sub={
                tot && tot.unpricedModels.length > 0
                  ? t("usage.kpi.notBilledUnpriced", { models: tot.unpricedModels.join(", ") })
                  : t("usage.kpi.notBilled")
              }
              icon="sparkles"
            />
            <Kpi
              label={t("usage.kpi.requests")}
              value={tot ? tot.requests.toLocaleString() : "-"}
              delta={tot && prev ? pctChange(tot.requests, prev.requests) : null}
              icon="play"
            />
            <Kpi
              label={t("usage.kpi.avgCost")}
              value={
                tot && tot.requests > 0 ? fmtUsd(tot.costUsd / tot.requests, 4) : "-"
              }
              delta={
                tot && prev && tot.requests > 0 && prev.requests > 0
                  ? pctChange(
                      tot.costUsd / tot.requests,
                      prev.costUsd / prev.requests,
                    )
                  : null
              }
              icon="clock"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4">
            {/* 시간별 사용량 */}
            <Card
              title={t("usage.chart.title")}
              sub={t("usage.chart.sub")}
              action={
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={hideCache}
                    onChange={(e) => setHideCache(e.target.checked)}
                    className="accent-[#696FEA]"
                  />
                  {t("usage.chart.hideCache")}
                </label>
              }
            >
              {points.length > 0 ? (
                <StackedBars
                  points={points}
                  series={chartSeries}
                  format={fmtTokens}
                />
              ) : (
                <p className="text-muted">{t("usage.noData")}</p>
              )}
            </Card>

            {/* 모델별 */}
            <Card
              title={t("usage.byModel.title")}
              sub={tot ? t("usage.byModel.total", { cost: fmtUsd(tot.costUsd) }) : undefined}
            >
              {summary && summary.byModel.length > 0 ? (
                <ul className="flex flex-col gap-3">
                  {summary.byModel.slice(0, 8).map((m) => {
                    const share =
                      tot && tot.costUsd > 0 ? m.costUsd / tot.costUsd : 0;
                    return (
                      <li key={m.model}>
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${m.provider === "claude" ? "bg-[#D98A5E]" : "bg-accent"}`}
                          />
                          <span
                            className="min-w-0 flex-1 truncate font-medium"
                            title={m.model}
                          >
                            {m.label}
                            <span className="mono ml-1.5 text-[10px] font-normal text-muted">
                              {m.model}
                            </span>
                            {m.estimated && (
                              <span className="label ml-1.5 text-warn">
                                {t("usage.byModel.estimated")}
                              </span>
                            )}
                            {!m.priced && (
                              <span className="label ml-1.5 text-err">
                                {t("usage.byModel.unpriced")}
                              </span>
                            )}
                          </span>
                          <span className="mono text-[10.5px] text-muted">
                            {fmtTokens(tokensTotal(m))} ·{" "}
                            {m.priced ? fmtUsd(m.costUsd) : "-"}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-2">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.max(2, share * 100)}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-muted">{t("usage.noData")}</p>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4">
            {/* 워크스페이스별 */}
            <Card title={t("usage.byWorkspace.title")} sub={t("usage.byWorkspace.sub")}>
              {summary && summary.byWorkspace.length > 0 ? (
                <table className="w-full table-fixed text-left">
                  <colgroup>
                    <col />
                    <col className="w-14" />
                    <col className="w-20" />
                    <col className="w-24" />
                    <col className="w-14" />
                  </colgroup>
                  <thead>
                    <tr className="label border-b border-line">
                      <th className="pb-2 font-normal">{t("usage.byWorkspace.path")}</th>
                      <th className="pb-2 text-right font-normal">{t("usage.byWorkspace.sessions")}</th>
                      <th className="pb-2 text-right font-normal">{t("usage.byWorkspace.tokens")}</th>
                      <th className="pb-2 text-right font-normal">{t("usage.byWorkspace.cost")}</th>
                      <th className="pb-2 text-right font-normal">{t("usage.byWorkspace.share")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byWorkspace.slice(0, 10).map((w) => (
                      <tr
                        key={w.cwd}
                        className="border-b border-line/60 last:border-0"
                      >
                        <td className="min-w-0 py-2 pr-3">
                          <button
                            onClick={() => setCwd(w.cwd)}
                            className="block w-full min-w-0 text-left hover:text-accent"
                          >
                            <span className="block truncate font-medium">
                              {w.name}
                            </span>
                            <span
                              className="mono block truncate text-[10px] text-muted"
                              title={w.cwd}
                            >
                              {shortenHome(w.cwd)}
                            </span>
                          </button>
                        </td>
                        <td className="mono py-2 text-right text-muted">
                          {w.sessions}
                        </td>
                        <td className="mono py-2 text-right">
                          {fmtTokens(tokensTotal(w))}
                        </td>
                        <td className="mono py-2 text-right">
                          {fmtUsd(w.costUsd)}
                        </td>
                        <td className="mono py-2 text-right text-accent">
                          {Math.round(w.share * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-muted">{t("usage.noData")}</p>
              )}
            </Card>

            {/* 한도 · 알림 */}
            <Card title={t("usage.limits.title")}>
              <div className="flex flex-col gap-4">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium">
                      {t("usage.limits.budget")}
                    </span>
                    <span className="mono text-[10.5px] text-muted">
                      {monthCost !== null ? fmtUsd(monthCost) : "-"}
                      {settings.monthlyBudgetUsd
                        ? ` / ${fmtUsd(settings.monthlyBudgetUsd)}`
                        : ""}
                    </span>
                  </div>
                  {settings.monthlyBudgetUsd && monthCost !== null && (
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
                      <div
                        className={`h-full rounded-full ${monthCost / settings.monthlyBudgetUsd >= 0.8 ? "bg-warn" : "bg-accent"}`}
                        style={{
                          width: `${Math.min(100, (monthCost / settings.monthlyBudgetUsd) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={budgetInput}
                      onChange={(e) => setBudgetInput(e.target.value)}
                      placeholder={t("usage.limits.budgetPlaceholder")}
                      inputMode="decimal"
                      className="mono min-w-0 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5 outline-none focus:border-accent/50"
                      style={{ userSelect: "text" }}
                    />
                    <button
                      onClick={() => void saveBudget()}
                      className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2"
                    >
                      {t("common.save")}
                    </button>
                  </div>
                  <p className="mt-1.5 text-[10.5px] text-muted">
                    {t("usage.limits.budgetHint")}
                  </p>
                </div>

                <div className="border-t border-line pt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium">{t("usage.limits.last5h")}</span>
                    <span className="mono text-[10.5px] text-muted">
                      {summary
                        ? `${fmtTokens(tokensTotal(summary.last5h))} · ${fmtUsd(summary.last5h.costUsd)}`
                        : "-"}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-muted">
                    {t("usage.limits.last5hHint")}
                  </p>
                </div>

                <RateLimitBlock
                  label={t("usage.limits.claude")}
                  color="bg-accent"
                  limit={limits?.claude ?? null}
                  hint={t("usage.limits.claudeHint")}
                  onRefresh={refreshLimits}
                  refreshing={refreshingLimits}
                />
                <RateLimitBlock
                  label={t("usage.limits.codex")}
                  color="bg-[#2A9D8F]"
                  limit={limits?.codex ?? null}
                  hint={t("usage.limits.codexHint")}
                  onRefresh={refreshLimits}
                  refreshing={refreshingLimits}
                />

                {summary && (
                  <div className="border-t border-line pt-3">
                    <div className="mb-1.5 font-medium">{t("usage.limits.source")}</div>
                    <SourceBar
                      inApp={summary.sources.inApp.costUsd}
                      terminal={summary.sources.terminal.costUsd}
                    />
                  </div>
                )}
              </div>
            </Card>
          </div>

          {summary && summary.topSessions.length > 0 && (
            <Card title={t("usage.topSessions.title")} sub={t("usage.topSessions.sub")}>
              <ul className="grid grid-cols-2 gap-x-6 gap-y-2">
                {summary.topSessions.map((s) => (
                  <li
                    key={s.sessionId}
                    className="flex items-center gap-2 border-b border-line/60 py-1.5"
                  >
                    <span
                      className={`label rounded px-1.5 py-0.5 ${s.inApp ? "bg-accent-tint text-accent" : "bg-panel-2 text-muted"}`}
                    >
                      {s.inApp ? t("usage.topSessions.inApp") : t("usage.topSessions.terminal")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {baseName(s.cwd) || t("usage.topSessions.noPath")}
                      </span>
                      <span className="mono block truncate text-[10px] text-muted">
                        {s.model} · {t("usage.requestCount", { count: s.requests })} · {fmtTime(s.lastTs, loc)}
                      </span>
                    </span>
                    <span className="mono text-right text-[10.5px]">
                      {fmtUsd(s.costUsd)}
                      <span className="block text-muted">
                        {fmtTokens(tokensTotal(s))}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="mono pb-2 text-[10px] text-muted">
            {status?.customPricing ? t("usage.footnoteCustom") : t("usage.footnoteDefault")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  sub,
  action,
  children,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <span className="flex items-center gap-3">
          {sub && <span className="mono text-[10px] text-muted">{sub}</span>}
          {action}
        </span>
      </div>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  delta,
  sub,
  icon,
}: {
  label: string;
  value: string;
  delta: number | null;
  sub?: string;
  icon: "usage" | "sparkles" | "play" | "clock";
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="label">{label}</span>
        <Icon name={icon} size={13} className="text-accent" />
      </div>
      <div className="mono text-[24px] font-medium leading-none">{value}</div>
      <div className="mt-2 text-[10.5px] text-muted">
        {delta === null ? (
          <span>{t("usage.kpi.noPrev")}</span>
        ) : (
          <span className={delta > 0 ? "text-warn" : "text-ok"}>
            {t("usage.kpi.vsPrev", { value: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}` })}
          </span>
        )}
        {sub && (
          <span className="block truncate text-err" title={sub}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

function SourceBar({ inApp, terminal }: { inApp: number; terminal: number }) {
  const { t } = useTranslation();
  const total = inApp + terminal;
  const p = total > 0 ? (inApp / total) * 100 : 0;
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div className="h-full bg-accent" style={{ width: `${p}%` }} />
        <div className="h-full bg-[#2A9D8F]" style={{ width: `${100 - p}%` }} />
      </div>
      <div className="mono mt-1.5 flex justify-between text-[10px] text-muted">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent align-middle" />
          {t("usage.limits.sourceInApp", { cost: fmtUsd(inApp) })}
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#2A9D8F] align-middle" />
          {t("usage.limits.sourceTerminal", { cost: fmtUsd(terminal) })}
        </span>
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  icon,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  icon: "folder";
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex items-center">
      <Icon
        name={icon}
        size={12}
        className="pointer-events-none absolute left-2.5 text-muted"
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[320px] rounded-md border border-line bg-panel py-1.5 pl-7 pr-7"
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        size={12}
        className="pointer-events-none absolute right-2 text-muted"
      />
    </span>
  );
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n: number, digits = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** provider 하나의 5시간/주간 창 소진율. 값이 없으면 안내만 보여 준다 (턴을 돌려야 관측된다). */
function RateLimitBlock({
  label,
  color,
  limit,
  hint,
  onRefresh,
  refreshing,
}: {
  label: string;
  color: string;
  limit: ProviderRateLimitDto | null;
  hint: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const loc = intlLocale(i18n.language as Locale);
  return (
    <div className="border-t border-line pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="mono text-[10.5px] text-muted">
            {limit ? t("usage.limits.observedAt", { time: fmtTime(limit.observedAt, loc) }) : t("usage.limits.noInfo")}
          </span>
          <button
            onClick={onRefresh}
            className={`rounded p-1 text-muted hover:bg-panel-2 hover:text-fg ${refreshing ? "animate-spin" : ""}`}
            title={t("usage.limits.refreshTitle")}
            data-limits-refresh
          >
            <Icon name="refresh" size={11} />
          </button>
        </span>
      </div>
      {limit ? (
        <div className="flex flex-col gap-2">
          {limit.session && <RateLimitBar color={color} w={limit.session} />}
          {limit.weekly && (
            <RateLimitBar
              color={color}
              w={limit.weekly}
              suffix={limit.modelWeekly ? ` · ${t("usage.limits.allModels")}` : ""}
            />
          )}
          {limit.modelWeekly && (
            <RateLimitBar
              color={color}
              w={limit.modelWeekly}
              suffix={` · ${t("usage.limits.modelOnly", { model: limit.modelWeekly.label })}`}
            />
          )}
          <p className="text-[10.5px] text-muted">{hint}</p>
        </div>
      ) : (
        <p className="text-[10.5px] text-muted">
          {t("usage.limits.noInfoHint", { hint })}
        </p>
      )}
    </div>
  );
}

function RateLimitBar({
  color,
  w,
  suffix = "",
}: {
  color: string;
  w: RateLimitWindowDto;
  suffix?: string;
}) {
  const { t, i18n } = useTranslation();
  const loc = intlLocale(i18n.language as Locale);
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const left = 100 - pct;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted">
          {t("usage.limits.windowBasis", { window: fmtWindow(w.windowMinutes, t), suffix })}
        </span>
        <span className="mono text-[10.5px] text-muted">
          {pct >= 100 ? t("usage.limits.reached") : t("usage.limits.usedLeft", { used: Math.round(pct), left: Math.round(left) })}
          {w.resetsAt ? ` · ${t("usage.limits.resets", { time: fmtDateTime(w.resetsAt * 1000, loc) })}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div
          className={`h-full rounded-full ${pct >= 100 ? "bg-err" : pct >= 80 ? "bg-warn" : color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** 오늘이면 시:분, 아니면 월/일 시:분. 한도 초기화 시각처럼 날짜와 시각이 모두 필요한 곳에. */
function fmtDateTime(ts: number, loc: string): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(loc, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function fmtTime(ts: number, loc: string): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(loc, { month: "numeric", day: "numeric" });
}

function fmtWindow(min: number, t: TFunction): string {
  if (min >= 1440) return t("usage.limits.day", { count: Math.round(min / 1440) });
  if (min >= 60) return t("usage.limits.hour", { count: Math.round(min / 60) });
  return t("usage.limits.minute", { count: min });
}


