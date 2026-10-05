// `/model` 을 앱에서 처리하는 피커. 고르면 이 세션의 모델을 바꾼다(다음 턴부터 적용, 세션은 그대로).
import { usePaneFocusRef } from "../pane-focus";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Provider } from "@shared/ipc";
import { modelOptions, useModels } from "../models";
import { Icon } from "./Icon";

export function ModelPickerModal({
  provider,
  current,
  onClose,
  onPick,
}: {
  provider: Provider;
  /** 현재 설정된 모델(빈 문자열·undefined 는 CLI 기본). */
  current: string | undefined;
  onClose: () => void;
  onPick: (model: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    window.sudal.cli.status(provider).then((s) => alive && setDefaultModel(s.defaultModel ?? null));
    return () => {
      alive = false;
    };
  }, [provider]);
  const { models, source } = useModels(provider);
  const options = modelOptions(t, models, current, defaultModel).map((o) => (o.description ? { ...o, label: `${o.label} — ${o.description}` } : o));
  void source;
  const known = options.some((o) => o.id === (current ?? ""));
  const [custom, setCustom] = useState(known ? "" : (current ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = async (model: string) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(model);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-overlay/60" onClick={onClose} data-model-picker>
      <div className="w-[420px] rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{t("nav.modelPicker.title")}</h2>
            <p className="mt-0.5 text-muted">{t("nav.modelPicker.description")}</p>
          </div>
          <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-1 px-5 py-4">
          {options.map((o) => {
            const active = (current ?? "") === o.id;
            return (
              <button
                key={o.id || "default"}
                disabled={busy}
                onClick={() => void pick(o.id)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left ${
                  active ? "border-accent bg-accent-tint" : "border-line hover:bg-panel-2"
                }`}
                data-model-option={o.id || "default"}
              >
                <span className="font-medium">{o.label}</span>
                {active && <span className="label rounded bg-line px-1.5 py-0.5">{t("nav.modelPicker.current")}</span>}
              </button>
            );
          })}
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) void pick(custom.trim());
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={t("nav.modelPicker.customPlaceholder")}
              className="mono min-w-0 flex-1 rounded-md border border-line bg-inset px-2 py-1.5 text-[12px] outline-none focus:border-accent"
              style={{ userSelect: "text" }}
              data-model-custom
            />
            <button type="submit" disabled={busy || !custom.trim()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-on-primary disabled:opacity-40">
              {t("nav.modelPicker.apply")}
            </button>
          </form>
          {error && <div className="mono mt-1 text-[11px] text-err">{error}</div>}
        </div>
      </div>
    </div>
  );
}
