import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexGoal } from "@shared/codex-controls";
import { userErrorMessage } from "@shared/error-message";
import { Modal } from "./Modal";
import { usePaneFocusRef } from "../pane-focus";

export function CodexGoalModal({ goal, onRun, onClose }: { goal: CodexGoal | null; onRun: (arg: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const paneFocus = usePaneFocusRef();
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [budget, setBudget] = useState(goal?.tokenBudget?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setObjective(goal?.objective ?? ""); setBudget(goal?.tokenBudget?.toString() ?? ""); }, [goal?.objective, goal?.tokenBudget]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (paneFocus.current && event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, busy]);
  const run = async (arg: string) => {
    setBusy(true); setError(null);
    try { await onRun(arg); } catch (e) { setError(userErrorMessage(e)); }
    finally { setBusy(false); }
  };
  return <Modal variant="pane" onClose={() => { if (!busy) onClose(); }} className="w-[min(520px,95%)] p-5">
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-codex-goal>
      <div className="mb-4 flex items-center justify-between"><h2 id={titleId} className="font-semibold">{t("session.codexUi.goalTitle")}</h2><button onClick={onClose} disabled={busy} className="text-muted">{t("session.codexUi.close")}</button></div>
      <p className="mb-3 text-sm text-muted">{t("session.codexUi.goalHelp")}</p>
      {goal && <p className="mb-3 text-sm text-accent">{t(`session.codexUi.goalStatus.${goal.status}`)} · {t("session.codexUi.tokens", { count: goal.tokensUsed })}{goal.tokenBudget != null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void run(objective.trim()); }}>
        <label className="block text-sm">{t("session.codexUi.objective")}<textarea autoFocus value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={4000} rows={4} className="mt-2 w-full rounded border border-line bg-bg p-2" /></label>
        <button disabled={busy || !objective.trim()} className="mt-3 rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-40">{t("session.codexUi.saveGoal")}</button>
      </form>
      {goal && <>
        <div className="mt-4 flex gap-2"><button disabled={busy} onClick={() => void run(goal.status === "active" ? "pause" : "resume")} className="rounded border border-line px-3 py-1.5 text-sm disabled:opacity-40">{t(goal.status === "active" ? "session.codexUi.pause" : "session.codexUi.resume")}</button><button disabled={busy} onClick={() => void run("clear")} className="rounded border border-line px-3 py-1.5 text-sm disabled:opacity-40">{t("session.codexUi.clearGoal")}</button></div>
        <form className="mt-4 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run(`budget ${budget}`); }}>
          <label className="flex-1 text-sm">{t("session.codexUi.budget")}<input type="number" min="1" step="1" required value={budget} onChange={(e) => setBudget(e.target.value)} className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
          <button disabled={busy} className="rounded border border-line px-3 py-2 text-sm disabled:opacity-40">{t("session.codexUi.apply")}</button>
        </form>
      </>}
      {error && <p role="alert" className="mt-3 text-sm text-err">{error}</p>}
    </div>
  </Modal>;
}
