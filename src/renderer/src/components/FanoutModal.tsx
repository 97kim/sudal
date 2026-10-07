// 팬아웃 시작 창 — 지시 하나 + 세션(제공자) 목록 + 정책. 각 세션은 별도의 git worktree에서 실행된다.
import { usePaneFocusRef } from "../pane-focus";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PERMISSION_POLICIES, type PermissionPolicy } from "@shared/chat-events";
import type { FanoutStartDto, Provider } from "@shared/ipc";
import { FANOUT_MAX_VARIANTS, FANOUT_MIN_VARIANTS, PROVIDER_NAME, variantLabel } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { modelOptions, useModels } from "../models";
import { Modal } from "./Modal";

const POLICIES = PERMISSION_POLICIES;

/** 세션 한 줄의 모델 셀렉트 — provider 의 실제 모델 목록(CLI 조회)을 쓴다. */
function VariantModelSelect({ provider, value, onChange }: { provider: Provider; value: string; onChange: (model: string) => void }) {
  const { t } = useTranslation();
  const { models, source } = useModels(provider);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.sudal.cli.status(provider).then((s) => alive && setDefaultModel(s.defaultModel ?? null));
    return () => {
      alive = false;
    };
  }, [provider]);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mono min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] outline-none focus:border-accent"
      title={source === "loading" ? t("fanout.modal.modelsLoading") : source === "static" ? t("fanout.modal.modelsStatic") : t("fanout.modal.modelsDefault")}
      data-fanout-model
      data-models-source={source}
    >
      {modelOptions(t, models, value, defaultModel).map((o) => (
        <option key={o.id} value={o.id} title={o.description}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function FanoutModal({
  initialPrompt,
  defaultProvider,
  onStart,
  onClose,
}: {
  initialPrompt: string;
  defaultProvider: Provider;
  onStart: (req: FanoutStartDto) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [variants, setVariants] = useState<{ provider: Provider; model: string }[]>([
    { provider: defaultProvider, model: "" },
    { provider: defaultProvider === "claude" ? "codex" : "claude", model: "" },
  ]);
  const [policy, setPolicy] = useState<PermissionPolicy>("auto_edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const start = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await onStart({ prompt, variants: variants.map((v) => (v.model.trim() ? { provider: v.provider, model: v.model.trim() } : { provider: v.provider })), policy });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  return (
    <Modal variant="window" onClose={onClose} className="w-full max-w-[640px]" data-fanout-modal>
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Icon name="sparkles" size={15} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t("fanout.modal.title")}</div>
          <div className="mt-0.5 text-[11px] text-muted">{t("fanout.modal.description")}</div>
        </div>
        <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title={t("fanout.modal.close")}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <label className="flex flex-col gap-1.5">
          <span className="label text-muted">{t("fanout.modal.promptLabel")}</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void start();
              }
            }}
            rows={5}
            autoFocus
            placeholder={t("fanout.modal.promptPlaceholder")}
            className="w-full resize-y rounded-md border border-line bg-inset px-3 py-2 text-[13px] leading-[1.6] outline-none focus:border-accent"
            data-fanout-prompt
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="label text-muted">{t("fanout.modal.sessions", { count: variants.length })}</span>
          <div className="flex flex-col gap-1.5" data-fanout-variants>
            {variants.map((v, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-line bg-inset px-2.5 py-1.5" data-fanout-variant={variantLabel(i)}>
                <span className="mono w-4 text-[11px] text-muted">{variantLabel(i)}</span>
                {(["claude", "codex"] as Provider[]).map((p) => (
                  <button
                    key={p}
                    // provider 를 바꾸면 모델은 그 provider 의 기본으로(다른 provider 의 모델명이 남지 않게)
                    onClick={() => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, provider: p, model: x.provider === p ? x.model : "" } : x)))}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] ${v.provider === p ? "border-accent/40 bg-accent-tint text-accent" : "border-line text-muted hover:bg-panel-2"}`}
                    data-fanout-provider={p}
                    data-selected={v.provider === p ? "true" : "false"}
                  >
                    <ProviderLogo provider={p} size={14} />
                    {PROVIDER_NAME[p]}
                  </button>
                ))}
                <VariantModelSelect provider={v.provider} value={v.model} onChange={(m) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, model: m } : x)))} />
                <button
                  onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}
                  disabled={variants.length <= FANOUT_MIN_VARIANTS}
                  className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
                  title={t("fanout.modal.removeVariant")}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
          </div>
          {variants.length < FANOUT_MAX_VARIANTS && (
            <button
              onClick={() => setVariants((vs) => [...vs, { provider: vs[vs.length - 1]?.provider === "claude" ? "codex" : "claude", model: "" }])}
              className="flex w-fit items-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
              data-fanout-add
            >
              <Icon name="plus" size={10} />
              {t("fanout.modal.addVariant")}
            </button>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="label text-muted">{t("fanout.modal.policyLabel")}</span>
          <div className="flex gap-1.5" data-fanout-policy={policy}>
            {POLICIES.map((p) => (
              <button
                key={p}
                onClick={() => setPolicy(p)}
                className={`rounded-md border px-2.5 py-1 text-[12px] ${policy === p ? "border-accent/40 bg-accent-tint text-accent" : "border-line text-muted hover:bg-panel-2"}`}
                title={t(`fanout.modal.policy.${p}.description`)}
                data-fanout-policy-option={p}
              >
                {t(`fanout.modal.policy.${p}.label`)}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted">{t("fanout.modal.policyNote", { description: t(`fanout.modal.policy.${policy}.description`) })}</div>
        </div>
        {error && (
          <div className="rounded-md border border-err/40 bg-err-bg px-3 py-2 text-[12px] text-err" data-fanout-error>
            {error}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <button onClick={onClose} className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2">
          {t("common.cancel")}
        </button>
        <button
          onClick={() => void start()}
          disabled={!prompt.trim() || busy}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-on-accent hover:bg-accent/90 disabled:opacity-40"
          title="⌘↩"
          data-fanout-start
        >
          <Icon name="play" size={10} />
          {busy ? t("fanout.modal.creating") : t("fanout.modal.send", { count: variants.length })}
        </button>
      </div>
    </Modal>
  );
}
