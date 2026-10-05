import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import type {
  ProviderRateLimitDto,
  RateLimitWindowDto,
  UsageStatusDto,
} from "@shared/ipc";
import { Icon } from "./Icon";

/** 사이드바 하단 고정: provider 별 구독 한도(5시간/주간 창) 요약. 클릭하면 사용량 화면으로. */
export function SidebarLimits({ onOpen }: { onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const [limits, setLimits] = useState<UsageStatusDto["rateLimits"] | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    const load = () =>
      window.workbench.usage.status().then((s) => {
        if (alive) setLimits(s.rateLimits);
      });
    void load();
    const off = window.workbench.usage.onChanged(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    try {
      const s = await window.workbench.usage.refreshLimits();
      setLimits(s.rateLimits);
    } finally {
      setRefreshing(false);
    }
  };

  const rows: { name: string; limit: ProviderRateLimitDto }[] = [];
  if (limits?.claude) rows.push({ name: "Claude", limit: limits.claude });
  if (limits?.codex) rows.push({ name: "Codex", limit: limits.codex });
  if (rows.length === 0 && !refreshing) {
    return (
      <button
        onClick={(e) => void refresh(e)}
        className="no-drag mx-3 mb-1 flex items-center justify-between rounded-md border border-line px-3 py-2 text-left text-[10.5px] text-muted hover:bg-panel-2"
        title={t("nav.limits.load")}
        data-limits-refresh
      >
        <span className="label">{t("nav.limits.title")}</span>
        <span className="flex items-center gap-1">
          {t("nav.limits.loadButton")} <Icon name="refresh" size={10} />
        </span>
      </button>
    );
  }

  return (
    <button
      onClick={onOpen}
      className="no-drag mx-3 mb-1 flex flex-col gap-1.5 rounded-md border border-line px-3 py-2 text-left hover:bg-panel-2"
      title={t("nav.limits.openUsage")}
    >
      <div className="label flex items-center justify-between">
        <span>{t("nav.limits.title")}</span>
        <span className="flex items-center gap-1">
          <span className="mono text-[9px] text-muted-2">
            {t("nav.limits.asOf", { time: fmtObserved(Math.max(...rows.map((r) => r.limit.observedAt)), i18n.language as Locale) })}
          </span>
          <span
            role="button"
            onClick={(e) => void refresh(e)}
            className={`rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg ${refreshing ? "animate-spin" : ""}`}
            title={t("nav.limits.refresh")}
            data-limits-refresh
          >
            <Icon name="refresh" size={10} />
          </span>
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.name} className="flex flex-col gap-1">
          <span className="text-[10.5px] font-medium">{r.name}</span>
          {r.limit.session && <MiniBar w={r.limit.session} />}
          {r.limit.weekly && <MiniBar w={r.limit.weekly} />}
          {r.limit.modelWeekly && (
            <MiniBar
              w={r.limit.modelWeekly}
              label={r.limit.modelWeekly.label}
            />
          )}
        </div>
      ))}
    </button>
  );
}

function MiniBar({
  w,
  label: given,
}: {
  w: RateLimitWindowDto;
  label?: string;
}) {
  const { t, i18n } = useTranslation();
  const label =
    given ??
    (w.windowMinutes >= 1440
      ? t("nav.limits.days", { count: Math.round(w.windowMinutes / 1440) })
      : t("nav.limits.hours", { count: Math.round(w.windowMinutes / 60) }));
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const reset = new Date(w.resetsAt * 1000);
  const status = pct >= 100 ? t("nav.limits.reached") : t("nav.limits.used", { percent: Math.round(pct) });
  const title = w.resetsAt
    ? t("nav.limits.windowTitleReset", {
        label,
        status,
        date: `${reset.getMonth() + 1}/${reset.getDate()}`,
        time: reset.toLocaleTimeString(intlLocale(i18n.language as Locale), { hour: "2-digit", minute: "2-digit" }),
      })
    : t("nav.limits.windowTitle", { label, status });
  return (
    <span className="flex min-w-0 items-center gap-2 pl-1" title={title}>
      <span className="mono w-9 shrink-0 text-[9.5px] text-muted">{label}</span>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-panel-2">
        <span
          className={`block h-full rounded-full ${pct >= 100 ? "bg-err" : pct >= 80 ? "bg-warn" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={`mono w-7 shrink-0 text-right text-[9.5px] ${pct >= 100 ? "text-err" : "text-muted"}`}>
        {Math.round(pct)}%
      </span>
    </span>
  );
}

function fmtObserved(ts: number, locale: Locale): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
