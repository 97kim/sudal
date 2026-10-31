import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import type {
  ProviderRateLimitDto,
  RateLimitWindowDto,
  UsageStatusDto,
} from "@shared/ipc";
import { Icon } from "./Icon";

/**
 * 한도에 닿아도 결제로 이어 쓸 수 있는지. 추가 사용량을 못 쓰는 상태는 구독 한도가 남아 있으면 지금 막힌 게 아니다 —
 * 빨간색은 한도에 닿았을 때만 쓴다(그전에 빨갛게 보이면 "다 썼다"로 읽혔다).
 */
function OverageLine({ limit }: { limit: ProviderRateLimitDto }) {
  const { t } = useTranslation();
  const o = limit.overage!;
  const atLimit =
    [limit.session, limit.weekly, limit.modelWeekly].some((w) => w && w.usedPercent >= 100) ||
    (limit.rejectedResetsAt !== undefined && limit.rejectedResetsAt * 1000 > Date.now());
  const kind = o.status === "rejected" ? "rejected" : o.inUse ? "in-use" : "enabled";
  const key =
    kind === "rejected"
      ? o.disabledReason === "out_of_credits"
        ? "nav.limits.overageNoCredits"
        : // 조회 실패·알 수 없음은 꺼 둔 게 아니다 — "꺼짐"이라 하면 설정을 끈 것으로 읽힌다
          o.disabledReason && o.disabledReason !== "fetch_error" && o.disabledReason !== "unknown"
          ? "nav.limits.overageOff"
          : "nav.limits.overageUnavailable"
      : kind === "in-use"
        ? "nav.limits.overageInUse"
        : "nav.limits.overageOn";
  const color = kind === "in-use" ? "text-warn" : kind === "rejected" && atLimit ? "text-err" : "text-muted-2";
  return (
    <span className={`text-[10px] ${color}`} data-limits-overage={kind}>
      {t(key)}
    </span>
  );
}

/** 사이드바 하단 고정: provider 별 구독 한도(5시간/주간 창) 요약. 클릭하면 사용량 화면으로. */
export function SidebarLimits({ onOpen }: { onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const [limits, setLimits] = useState<UsageStatusDto["rateLimits"] | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    const load = () =>
      window.sudal.usage.status().then((s) => {
        if (alive) setLimits(s.rateLimits);
      });
    void load();
    const off = window.sudal.usage.onChanged(() => void load());
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
      const s = await window.sudal.usage.refreshLimits();
      setLimits(s.rateLimits);
    } finally {
      setRefreshing(false);
    }
  };

  const rows: { name: string; limit: ProviderRateLimitDto }[] = [];
  if (limits?.claude) rows.push({ name: "Claude", limit: limits.claude });
  if (limits?.codex) rows.push({ name: "Codex", limit: limits.codex });
  if (limits?.agy) rows.push({ name: "Antigravity", limit: limits.agy });
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
          {r.limit.overage?.enabled && <OverageLine limit={r.limit} />}
          {!!r.limit.groups?.length && (
            <div className="flex flex-col gap-2 pt-0.5">
              {r.limit.groups.map((group) => (
                <div key={group.label} className="ml-1 flex flex-col gap-1.5" data-limits-group={group.label}>
                  <span className="flex min-w-0 items-baseline gap-1 text-[10px] font-normal leading-snug text-fg/95" title={group.label}>
                    <span className="w-2 shrink-0 text-center text-muted" aria-hidden="true">·</span>
                    <span className="min-w-0 truncate">{group.label}</span>
                  </span>
                  <div className="ml-3 flex flex-col gap-1">
                    {group.windows.map((w) => <MiniBar key={w.windowMinutes} w={w} />)}
                  </div>
                </div>
              ))}
            </div>
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
