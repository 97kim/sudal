import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@shared/error-message";
import { Icon } from "./Icon";

export function CodexFastSettings({ onApply }: { onApply: (mode: "on" | "off") => Promise<unknown> }) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<"on" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = async (mode: "on" | "off") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(null);
    try { await onApply(mode); setConfirmed(mode); }
    catch (error) { setError(userErrorMessage(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section data-codex-fast-settings aria-busy={busy} className="space-y-4">
    <p className="text-sm leading-relaxed text-muted">{t("session.codexResult.fastChoose")}</p>
    <div className="grid grid-cols-2 gap-2">{(["on", "off"] as const).map(mode => <button key={mode} type="button" aria-pressed={confirmed === mode} disabled={busy} onClick={() => void apply(mode)} className={`rounded-lg border px-3 py-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${confirmed === mode ? "border-accent bg-accent/10 text-fg" : "border-line text-fg hover:bg-panel-2"}`}>{t(mode === "on" ? "session.codexResult.fastEnable" : "session.codexResult.fastDisable")}</button>)}</div>
    {error && <p role="alert" className="whitespace-pre-wrap rounded-lg bg-err-bg p-3 text-xs text-err">{error}</p>}
    <div role="status" aria-live="polite" aria-atomic="true" data-codex-fast-feedback>
      {confirmed && <div className="flex items-center gap-3 rounded-lg border border-ok/40 bg-ok-bg px-4 py-3 text-base font-semibold text-fg">
        <Icon name="check" size={20} className="shrink-0 text-ok" />
        <p>{t(confirmed === "on" ? "session.codexResult.fastEnabled" : "session.codexResult.fastDisabled")}</p>
      </div>}
    </div>
  </section>;
}
