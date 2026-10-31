import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@shared/error-message";
import { CodexInfoResult } from "./CodexInfoResult";

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
    <div className="grid grid-cols-2 gap-2">{(["on", "off"] as const).map(mode => <button key={mode} disabled={busy} onClick={() => void apply(mode)} className="rounded-lg border border-line px-3 py-3 text-sm hover:bg-panel-2 disabled:opacity-50">{t(mode === "on" ? "session.codexResult.fastEnable" : "session.codexResult.fastDisable")}</button>)}</div>
    {error && <p role="alert" className="whitespace-pre-wrap rounded-lg bg-err-bg p-3 text-xs text-err">{error}</p>}
    {confirmed && <CodexInfoResult command="fast" data={{ fast: confirmed === "on" }} />}
  </section>;
}
