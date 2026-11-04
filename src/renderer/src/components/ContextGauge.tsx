import { useTranslation } from "react-i18next";

/** Small persistent context indicator; the center stays empty. */
export function ContextGauge({ percent, onOpen }: { percent: number | null; onOpen: () => void }) {
  const { t } = useTranslation();
  const pct = percent !== null && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  const label = pct === null ? t("chat.composer.contextUnknown") : t("chat.composer.contextUsage", { used: pct, remaining: 100 - pct });
  return <button type="button" onClick={onOpen} title={label} aria-label={label} data-context-gauge={pct ?? "unknown"}
    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" className="text-muted-2 opacity-40" />
      {pct !== null && pct > 0 && <circle cx="10" cy="10" r="8" pathLength="100" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${pct} 100`} transform="rotate(-90 10 10)" className={pct >= 95 ? "text-err" : pct >= 80 ? "text-warn" : "text-accent"} />}
    </svg>
  </button>;
}
