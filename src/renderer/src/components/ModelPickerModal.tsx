import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Provider, SessionConfigDto } from "@shared/ipc";
import { userErrorMessage } from "@shared/error-message";
import { modelOptions, useModels } from "../models";
import { Icon } from "./Icon";

type Effort = SessionConfigDto["effort"];

/** Composer-anchored picker, shared with /model. */
export function ModelPickerModal({ provider, current, effort, anchor, onClose, onPick }: {
  provider: Provider;
  current: string | undefined;
  effort?: Effort;
  anchor: HTMLButtonElement | null;
  onClose: () => void;
  onPick: (model: string, effort?: Effort) => Promise<void>;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, bottom: 8, width: 320, maxHeight: 400 });
  const { models } = useModels(provider);
  const options = modelOptions(t, models, current, defaultModel);
  const levels = models.find(m => m.id === (current || defaultModel) || (!current && !defaultModel && m.isDefault))?.efforts ?? [];

  useEffect(() => {
    let alive = true;
    window.sudal.cli.status(provider).then(s => { if (alive) setDefaultModel(s.defaultModel ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [provider]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 16);
      setPosition({ width, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8), maxHeight: Math.max(80, rect.top - 16) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);

  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);

  const pick = async (model: string, nextEffort?: Effort) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await onPick(model, nextEffort); }
    catch (e) { setError(userErrorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  };

  return createPortal(
    <div ref={panel} role="dialog" aria-label={t("nav.modelPicker.title")} aria-busy={busy} tabIndex={-1}
      data-model-picker style={position}
      className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-fg shadow-2xl outline-none">
      <div className="px-3 pb-1 pt-3 text-xs font-medium text-muted">{t("nav.modelPicker.title")}</div>
      <div className="min-h-0 overflow-y-auto p-1.5">
        {options.map(option => <button key={option.id || "default"} disabled={busy}
          data-model-option={option.id || "default"} aria-pressed={(current ?? "") === option.id}
          onClick={() => void pick(option.id, option.id === (current ?? "") ? effort : undefined)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none disabled:opacity-50">
          <span className="min-w-0"><span className="block break-words">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs text-muted">{option.description}</span>}</span>
          {(current ?? "") === option.id && <span className="shrink-0"><Icon name="check" size={14} /></span>}
        </button>)}
      </div>
      {levels.length > 0 && <EffortSlider key={current ?? ""} levels={levels} effort={effort} busy={busy}
        onPick={next => pick(current ?? "", next)} />}
      <form className="shrink-0 border-t border-line p-2" onSubmit={event => { event.preventDefault(); if (custom.trim()) void pick(custom.trim(), custom.trim() === current ? effort : undefined); }}>
        <input disabled={busy} value={custom} onChange={event => setCustom(event.target.value)} data-model-custom
          aria-label={t("nav.modelPicker.customPlaceholder")} placeholder={t("nav.modelPicker.customPlaceholder")}
          className="w-full rounded-md bg-inset px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-accent" />
      </form>
      {error && <div role="alert" className="px-3 pb-3 text-xs text-err">{error}</div>}
    </div>, document.body,
  );
}

function EffortSlider({ levels, effort, busy, onPick }: {
  levels: NonNullable<Effort>[];
  effort?: Effort;
  busy: boolean;
  onPick: (effort?: Effort) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number | null>(null);
  const index = effort ? levels.indexOf(effort) : -1;
  const selected = draft ?? index;
  const label = (level: string) => level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1);
  const valueText = selected >= 0 ? label(levels[selected]) : t("session.model.default");
  const commit = async (value: number) => {
    if (busy) return;
    await onPick(levels[value]);
    setDraft(null);
  };
  return <div className="shrink-0 border-t border-line px-3 py-3">
    <div className="mb-3 flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">{t("nav.modelPicker.effort")}</span>
      <span className="rounded-md bg-panel-2 px-2 py-1 font-medium" data-effort-value>{valueText}</span>
    </div>
    <div className="relative h-7">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-[7px] top-3 h-[3px] rounded-full bg-line">
        <div className="h-full rounded-full bg-accent opacity-70" style={{ width: ((Math.max(0, selected) / Math.max(1, levels.length - 1)) * 100) + "%" }} />
        {levels.map((level, i) => <span key={level} className={"absolute top-1/2 h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full " + (selected >= i ? "bg-accent" : "bg-muted")}
          style={{ left: ((i / Math.max(1, levels.length - 1)) * 100) + "%" }} />)}
      </div>
    <input type="range" min={0} max={Math.max(1, levels.length - 1)} step={1}
      value={Math.max(0, selected)} disabled={busy || levels.length === 1}
      aria-label={t("nav.modelPicker.effort")} aria-valuetext={valueText}
      onChange={event => setDraft(Number(event.target.value))}
      onPointerUp={event => { if (draft !== null) void commit(Number(event.currentTarget.value)); }}
      onPointerCancel={() => setDraft(null)}
      onKeyUp={event => {
        if (draft !== null && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key))
          void commit(Number(event.currentTarget.value));
      }}
      onBlur={() => { if (draft !== null) void commit(draft); }}
      className={"effort-slider relative block h-7 w-full cursor-pointer disabled:cursor-default " + (selected < 0 ? "opacity-40" : "")} />
    </div>
    <div className="mt-1.5 flex justify-between gap-1">
      {levels.map((level, i) => <button key={level} disabled={busy}
        onClick={() => void commit(i)} aria-pressed={selected === i}
        className={"rounded py-1 text-[11px] focus-visible:outline focus-visible:outline-accent " + (selected === i ? "font-medium text-fg" : "text-muted hover:text-fg")}>
        {label(level)}
      </button>)}
    </div>
    <button disabled={busy || (effort === undefined && draft === null)} data-effort-default
      onClick={() => { setDraft(null); void onPick(undefined); }}
      className="mt-2 rounded text-[11px] text-muted underline-offset-4 hover:text-fg hover:underline disabled:opacity-40">
      {t("nav.modelPicker.resetEffort")}
    </button>
  </div>;
}
