import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PROVIDERS, type CliStatusDto, type CrossReviewStartDto, type Provider } from "@shared/ipc";
import { usePaneFocusRef } from "../pane-focus";
import { modelOptions, useModels } from "../models";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { ProviderLogo } from "./ProviderLogo";

const LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };

function ReviewModelSelect({ provider, value, defaultModel, onChange, disabled }: {
  provider: Provider; value: string; defaultModel?: string; onChange: (model: string) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const { models, source } = useModels(provider);
  return <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
    className="w-full min-w-0 rounded-md border border-line bg-panel px-3 py-2 outline-none focus:border-accent disabled:opacity-50"
    aria-label={t("chat.header.crossReview.model")} data-review-model data-models-source={source}>
    {modelOptions(t, models, value, defaultModel).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
  </select>;
}

export function CrossReviewModal({ onStart, onClose }: {
  onStart: (request: CrossReviewStartDto) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [selected, setSelected] = useState<Provider | null>(null);
  const [model, setModel] = useState("");
  const [statuses, setStatuses] = useState<Partial<Record<Provider, CliStatusDto>>>({});
  const [checkErrors, setCheckErrors] = useState<Partial<Record<Provider, string>>>({});
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const paneFocus = usePaneFocusRef();

  useEffect(() => {
    let alive = true;
    setStatuses({});
    setCheckErrors({});
    void (async () => {
      if (retry > 0) {
        try { await window.sudal.cli.refresh(); }
        catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (alive) setCheckErrors(Object.fromEntries(PROVIDERS.map((p) => [p, message])));
          return;
        }
      }
      if (!alive) return;
      for (const provider of PROVIDERS) {
        void window.sudal.cli.status(provider).then((status) => {
          if (alive) setStatuses((prev) => ({ ...prev, [provider]: status }));
        }).catch((e: unknown) => {
          if (alive) setCheckErrors((prev) => ({ ...prev, [provider]: e instanceof Error ? e.message : String(e) }));
        });
      }
    })();
    return () => { alive = false; };
  }, [retry]);

  const requestClose = () => { if (!inFlight.current) onClose(); };
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current || e.key !== "Escape") return;
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const canStart = selected !== null && !!statuses[selected]?.installed && !busy;
  const start = async () => {
    if (!canStart || !selected || inFlight.current) return;
    inFlight.current = true;
    // 비활성화될 선택창에 포커스가 남으면 브라우저가 body로 옮긴다. 준비 중에도 대화상자 안에 둔다.
    dialog.current?.focus();
    setBusy(true);
    setError(null);
    try {
      const failure = await onStart({ provider: selected, ...(model ? { model } : {}) });
      if (failure) setError(failure);
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <Modal variant="window" onClose={requestClose} className="w-full max-w-[460px] max-h-[calc(100vh-40px)] overflow-y-auto" data-cross-review-modal>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="outline-none"
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)")];
        if (controls.length === 0) { e.preventDefault(); dialog.current?.focus(); return; }
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <Icon name="switch" size={16} className="shrink-0 text-accent" />
        <h2 id={titleId} className="flex-1 text-[14px] font-semibold">{t("chat.header.crossReview.label")}</h2>
        <button type="button" onClick={requestClose} disabled={busy} className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40" aria-label={t("common.close")}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="text-[12px] leading-relaxed text-muted">{t("chat.header.crossReview.description")}</p>
        <div className="flex flex-col gap-2" role="group" aria-label={t("chat.header.crossReview.reviewer")}>
          {PROVIDERS.map((p) => {
            const status = statuses[p];
            const checkError = checkErrors[p];
            const checking = !status && checkError === undefined;
            const active = selected === p;
            return <button key={p} type="button" disabled={busy || !status?.installed} aria-pressed={active} aria-busy={checking}
              onClick={() => { if (selected !== p) { setSelected(p); setModel(""); setError(null); } }}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 ${active ? "border-accent/50 bg-accent-tint" : "border-line hover:bg-panel-2"}`}
              data-review-provider={p}>
              <ProviderLogo provider={p} size={22} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{LABEL[p]}</span>
                {checkError !== undefined && <span className="block break-words text-[11px] text-warn">{checkError || t("nav.providerSwitch.checkFailed")}</span>}
              </span>
              <span className={`shrink-0 text-[10.5px] ${active ? "text-accent" : "text-muted"}`}>
                {checking ? t("nav.providerSwitch.checking") : checkError !== undefined ? t("nav.providerSwitch.checkFailed") : status?.installed ? t("nav.providerSwitch.ready") : t("nav.providerSwitch.notInstalled")}
              </span>
              {active && <Icon name="check" size={12} className="shrink-0 text-accent" />}
            </button>;
          })}
        </div>
        {(Object.keys(checkErrors).length > 0 || PROVIDERS.some((p) => statuses[p] && !statuses[p]?.installed)) && <button type="button" disabled={busy} className="w-fit text-[11px] text-accent hover:underline disabled:opacity-40"
          onClick={() => { setSelected(null); setModel(""); setRetry((n) => n + 1); }} data-review-retry>{t("nav.providerSwitch.retryCheck")}</button>}
        {selected && <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium">{t("chat.header.crossReview.model")}</span>
          <ReviewModelSelect key={selected} provider={selected} value={model} defaultModel={statuses[selected]?.defaultModel} onChange={setModel} disabled={busy} />
        </label>}
        <p className="text-[11px] text-muted">{t("chat.header.crossReview.sameProvider")}</p>
        {selected === "agy" && <p className="text-[11px] leading-relaxed text-muted">{t("session.msg.agyHeadlessPermissions")}</p>}
        {error && <p role="alert" className="rounded-md border border-err/30 bg-err-bg px-3 py-2 text-[12px] text-err" data-review-error>{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" onClick={requestClose} disabled={busy} className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40">{t("common.cancel")}</button>
        <button type="button" onClick={() => void start()} disabled={!canStart} className="rounded-md bg-accent px-3 py-1.5 text-on-accent hover:bg-accent/90 disabled:opacity-40" data-review-start>
          {busy ? t("chat.header.crossReview.starting") : t("chat.header.crossReview.start")}
        </button>
      </div>
    </div>
  </Modal>;
}
