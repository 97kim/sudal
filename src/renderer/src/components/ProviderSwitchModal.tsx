import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePaneFocusRef } from "../pane-focus";
import type { Handoff } from "@shared/handoff";
import { PROVIDERS, type CliStatusDto, type Provider } from "@shared/ipc";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

import { modelOptions, useModels } from "../models";
import { Modal } from "./Modal";

const LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "OpenAI Codex" };

export function ProviderSwitchModal({
  current,
  running,
  onClose,
  onSwitch,
  loadHandoff,
}: {
  current: Provider;
  running: boolean;
  onClose: () => void;
  onSwitch: (opts: { provider: Provider; model?: string; preserveContext: boolean; askSummary?: boolean }) => Promise<void>;
  loadHandoff: () => Promise<Handoff>;
}) {
  const { t } = useTranslation();
  // 미리 고르지 않는다 — 사용자가 목록에서 직접 고른 뒤 확인한다(제공자가 늘어도 같은 흐름).
  const [selected, setSelected] = useState<Provider | null>(null);
  const [model, setModel] = useState("");
  const [preserve, setPreserve] = useState(true);
  // 떠나는 쪽이 직접 쓴 인계서가 우리가 기록을 잘라 만든 요약보다 낫다 — 기본값으로 둔다.
  const [askSummary, setAskSummary] = useState(true);
  const [status, setStatus] = useState<Record<Provider, CliStatusDto | null>>({ claude: null, codex: null });
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const { models: targetModels } = useModels(selected ?? current);

  useEffect(() => {
    for (const p of PROVIDERS) {
      window.sudal.cli.status(p).then((s) => setStatus((prev) => ({ ...prev, [p]: s })));
    }
    loadHandoff().then(setHandoff).catch(console.error);
  }, [loadHandoff]);

  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key === "Escape") onClose();
      // 네이티브 <select> 에서 항목을 고르는 Enter 는 확인이 아니다
      const inField = e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Enter" && !busy && !inField) void confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const canConfirm = selected !== null && selected !== current && !!status[selected]?.installed;
  const confirm = async () => {
    if (!canConfirm || !selected) return;
    setBusy(true);
    try {
      await onSwitch({ provider: selected, model: model || undefined, preserveContext: preserve, askSummary: preserve && askSummary });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal variant="pane" onClose={onClose} className="w-[640px]">
      <div className="flex items-start justify-between border-b border-line px-6 py-5">
        <div>
          <h2 className="text-[17px] font-semibold">{t("nav.providerSwitch.title")}</h2>
          <p className="mt-1 text-muted">{t("nav.providerSwitch.description")}</p>
        </div>
        <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg">
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-6 py-5">
        <div>
          <div className="label mb-2">{t("nav.providerSwitch.targetAgent")}</div>
          <div className="flex flex-col gap-2" role="radiogroup">
            {PROVIDERS.map((p) => {
              const s = status[p];
              const isCurrent = p === current;
              const disabled = isCurrent || !s?.installed;
              const active = selected === p;
              return (
                <button
                  key={p}
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => {
                    setSelected(p);
                    setModel(""); // 제공자마다 모델 목록이 다르다
                  }}
                  className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left ${
                    active ? "border-accent bg-accent-tint" : "border-line bg-panel-2/40 hover:bg-panel-2"
                  } ${disabled ? "cursor-default opacity-60 hover:bg-panel-2/40" : ""}`}
                  data-agent-option={p}
                >
                  <ProviderLogo provider={p} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{LABEL[p]}</span>
                      {isCurrent && <span className="label rounded bg-line px-1.5 py-0.5">{t("nav.providerSwitch.current")}</span>}
                      {!isCurrent && s?.installed && <span className="label rounded bg-ok-bg px-1.5 py-0.5 text-ok">{t("nav.providerSwitch.ready")}</span>}
                      {s && !s.installed && <span className="label rounded bg-err-bg px-1.5 py-0.5 text-err" title={s.error}>{t("nav.providerSwitch.notInstalled")}</span>}
                    </span>
                    <span className="mono mt-0.5 block truncate text-muted" title={s?.path ?? ""}>
                      {s?.version ?? (s ? "" : t("nav.providerSwitch.checking"))}
                      {s?.path ? ` · ${s.path}` : ""}
                    </span>
                  </span>
                  {!isCurrent && (
                    <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${active ? "border-accent bg-accent" : "border-muted-2"}`} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="label mb-2">{t("nav.providerSwitch.options")}</div>
          <div className="rounded-lg border border-line bg-panel-2/40">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <div className="font-medium">{t("nav.providerSwitch.model")}</div>
                <div className="text-muted">{t("nav.providerSwitch.modelHint")}</div>
              </div>
              <select
                value={model}
                disabled={!selected}
                onChange={(e) => setModel(e.target.value)}
                className="mono rounded-md border border-line bg-panel px-2.5 py-1.5 disabled:opacity-50"
                title={selected ? "" : t("nav.providerSwitch.pickAgentFirst")}
              >
                {modelOptions(t, targetModels, model, status[selected ?? current]?.defaultModel).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium">{t("nav.providerSwitch.carrySummary")}</div>
                <div className="text-muted">
                  {t("nav.providerSwitch.carrySummaryHint")}
                </div>
              </div>
              <Toggle value={preserve} onChange={setPreserve} />
            </div>
            {preserve && (
              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <div>
                  <div className="font-medium">{t("nav.providerSwitch.askSummary")}</div>
                  <div className="text-muted">
                    {t("nav.providerSwitch.askSummaryHint")}
                  </div>
                </div>
                <Toggle value={askSummary} onChange={setAskSummary} />
              </div>
            )}
          </div>
        </div>

        {preserve && handoff && (
          <div className="rounded-lg border border-accent/30 bg-accent-tint px-4 py-3">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <Icon name="file" size={13} className="text-accent" />
              {askSummary ? t("nav.providerSwitch.fallbackSummary") : t("nav.providerSwitch.summaryReady")}
            </div>
            <div className="flex gap-8">
              {([
                [handoff.stats.messages, "messages"],
                [handoff.stats.files, "files"],
                [handoff.stats.pendingTasks, "pendingTasks"],
                [`${(handoff.stats.tokensEstimate / 1000).toFixed(1)}K`, "tokens"],
              ] as const).map(([v, l]) => (
                <div key={l}>
                  <div className="mono text-[14px]">{v}</div>
                  <div className="text-[11px] text-muted">{t(`nav.providerSwitch.stats.${l}`)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {running && (
          <div className="flex items-center gap-2 rounded-md bg-warn-bg px-3 py-2 text-warn">
            <Icon name="info" size={13} />
            {t("nav.providerSwitch.runningWarning")}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-6 py-4">
        <span className="mono text-[10px] text-muted">{t("nav.providerSwitch.keyHint")}</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="rounded-md border border-line px-4 py-1.5 hover:bg-panel-2">
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void confirm()}
            disabled={busy || !canConfirm}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 font-medium text-on-primary disabled:opacity-40"
            data-switch-confirm
          >
            <Icon name="switch" size={13} />
            {selected && selected !== current ? t("nav.providerSwitch.switchTo", { name: LABEL[selected] }) : t("nav.providerSwitch.pickAgent")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${value ? "bg-accent" : "bg-line"}`}
    >
      <span
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          value ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
