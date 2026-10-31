import { useTranslation } from "react-i18next";
import { feedbackActive, type VerificationFeedback } from "@shared/verification-feedback";

export function VerificationFeedbackPanel({ state, onStop }: { state: VerificationFeedback; onStop: () => void }) {
  const { t } = useTranslation();
  const active = feedbackActive(state);
  const tone = state.phase === "passed" ? "text-ok" : state.phase === "failed" || state.phase === "detected" ? "text-err" : "text-accent";
  return <section className="shrink-0 border-b border-line bg-panel px-4 py-3 text-xs" data-verification-feedback={state.phase}>
    <div className="flex items-center gap-2">
      <span className={`size-1.5 shrink-0 rounded-full bg-current ${tone} ${active ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      <span role="status" className={`font-medium ${tone}`}>{t(`chat.feedback.phases.${state.phase}`)}</span>
      <span className="text-muted">{t("chat.feedback.attempt", { count: state.attempt, max: state.maxAttempts })}</span>
      <span className="flex-1" />
      {active && <button disabled={state.phase === "stopping"} onClick={onStop} className="rounded border border-line px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40">{t("chat.feedback.stop")}</button>}
    </div>
    {state.reason && <p className="mt-2 leading-relaxed text-muted">{state.reason === "timeout" ? t("chat.feedback.timeout") : t(`chat.feedback.reasons.${state.reason}`)}</p>}
    {state.phase === "passed" && <p className="mt-1 text-[11px] text-muted">{t("chat.feedback.checkedAt")}</p>}
    {(state.verification || state.detail) && <details className="mt-2 text-muted">
      <summary className="cursor-pointer select-none hover:text-fg">{t("chat.feedback.details")}</summary>
      <div className="mt-2 max-h-48 space-y-2 overflow-auto rounded-md border border-line bg-inset p-3">
        {state.detail && <pre className="mono whitespace-pre-wrap break-words text-[11px] text-err">{state.detail}</pre>}
        {(state.failure && state.failure.runId !== state.verification?.runId ? [state.failure, ...(state.verification ? [state.verification] : [])] : state.verification ? [state.verification] : []).flatMap(verification => verification.commands.map((command, index) => <div key={`${verification.runId}-${index}`}>
          <div className="mono flex gap-2 text-[11px]"><span className={command.status === "failed" ? "text-err" : command.status === "passed" ? "text-ok" : "text-muted"}>{command.status === "passed" ? "✓" : command.status === "failed" ? "×" : "·"}</span><span className="break-all text-fg">{command.cmd}</span></div>
          {command.output && <pre className="mono mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed">{command.output}</pre>}
        </div>))}
      </div>
    </details>}
  </section>;
}
