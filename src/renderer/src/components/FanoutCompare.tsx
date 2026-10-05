// 팬아웃 비교 오버레이 — 왼쪽은 모든 세션이 건드린 파일의 합집합, 오른쪽은 세션별 열(그 파일의 diff). 열 머리에서 "채택".
import { usePaneFocusRef } from "../pane-focus";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import type { FanoutCompareDto } from "@shared/ipc";
import { PROVIDER_NAME, changeStats, unionPaths } from "@shared/fanout";
import { UnifiedDiff } from "./DiffView";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { Modal } from "./Modal";

export function FanoutCompare({ tabId, fanoutId, adoptedTabId, onClose }: { tabId: string; fanoutId: string; adoptedTabId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<FanoutCompareDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => {
    setError(null);
    window.sudal.chat
      .fanoutCompare(tabId, fanoutId)
      .then((d) => {
        setData(d);
        setCurrent((c) => c ?? unionPaths(d.variants)[0]?.path ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [tabId, fanoutId]);
  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, confirm]);
  const files = useMemo(() => (data ? unionPaths(data.variants) : []), [data]);
  const adopt = async (variantTabId: string) => {
    setAdopting(variantTabId);
    setMsg(null);
    const r = await window.sudal.chat.fanoutAdopt(tabId, fanoutId, variantTabId);
    setAdopting(null);
    setConfirm(null);
    setMsg(r.ok ? { ok: true, text: t("fanout.compare.applied", { count: r.files.length }) } : { ok: false, text: r.error });
  };
  return createPortal(
    <Modal variant="window" onClose={onClose} className="flex h-full w-full max-w-[1500px] flex-col overflow-hidden" data-fanout-compare-view>
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Icon name="sparkles" size={15} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t("fanout.compare.title")}</div>
          <div className="mt-0.5 text-[10.5px] text-muted">
            {data ? `${t("fanout.compare.sessionCount", { count: data.variants.length })} · ${t("fanout.compare.fileCount", { count: files.length })}` : t("common.loading")} · {t("fanout.compare.hint")}
          </div>
        </div>
        {msg && (
          <span className={`text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`} data-fanout-adopt-msg={msg.ok ? "ok" : "error"}>
            {msg.text}
          </span>
        )}
        <button onClick={load} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title={t("fanout.compare.reload")}>
          <Icon name="refresh" size={13} />
        </button>
        <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title={t("fanout.compare.close")}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {error && <div className="px-5 py-3 text-err">{error}</div>}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-line" data-fanout-files>
          {files.length === 0 && data && <div className="px-3 py-3 text-[11.5px] text-muted">{t("fanout.compare.noFiles")}</div>}
          {files.map((f) => (
            <button
              key={f.path}
              onClick={() => setCurrent(f.path)}
              className={`flex items-center gap-2 border-b border-line px-3 py-1.5 text-left ${current === f.path ? "bg-accent-tint" : "hover:bg-panel-2"}`}
              data-fanout-file={f.path}
            >
              <span className="mono min-w-0 flex-1 truncate text-[11.5px]">{f.path}</span>
              <span className="mono shrink-0 text-[10px] text-muted-2">{f.labels.join(" ")}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {data?.variants.map((v) => {
            const stats = changeStats(v.changes);
            const diff = current ? v.diffs[current] : undefined;
            const adopted = adoptedTabId === v.tabId;
            return (
              <div key={v.tabId} className="flex min-w-[360px] flex-1 flex-col border-r border-line last:border-r-0" data-fanout-column={v.label}>
                <div className="flex items-center gap-2 border-b border-line bg-inset px-3 py-2">
                  <span className="mono text-[11px] text-muted">{v.label}</span>
                  <ProviderLogo provider={v.provider} size={14} />
                  <span className="text-[12px] font-medium">{PROVIDER_NAME[v.provider]}</span>
                  <span className="mono text-[10.5px] text-muted-2">
                    {t("fanout.compare.fileCount", { count: stats.files })} <span className="text-ok">+{stats.added}</span> <span className="text-err">−{stats.deleted}</span>
                  </span>
                  <span className="flex-1" />
                  {adopted ? (
                    <span className="label text-ok">{t("fanout.compare.adopted")}</span>
                  ) : confirm === v.tabId ? (
                    <span className="flex items-center gap-1 text-[11px]">
                      <span className="text-muted">{t("fanout.compare.askApply")}</span>
                      <button onClick={() => void adopt(v.tabId)} disabled={adopting !== null} className="rounded bg-accent px-2 py-0.5 text-on-accent disabled:opacity-40" data-fanout-adopt-yes>
                        {adopting === v.tabId ? t("fanout.compare.applying") : t("common.apply")}
                      </button>
                      <button onClick={() => setConfirm(null)} className="rounded px-1.5 py-0.5 hover:bg-panel-2">
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirm(v.tabId)}
                      disabled={!v.exists || v.changes.length === 0 || adopting !== null}
                      className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                      title={t("fanout.compare.adoptTitle")}
                      data-fanout-adopt={v.tabId}
                    >
                      {t("fanout.compare.adopt")}
                    </button>
                  )}
                  <button onClick={() => void window.sudal.workspaces.activateTab(v.tabId)} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title={t("fanout.compare.openTabTitle")}>
                    {t("fanout.compare.openTab")}
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {v.summary && !current && <div className="text-[12px] text-muted" style={{ userSelect: "text" }}>{v.summary}</div>}
                  {!v.exists && <div className="text-[11.5px] text-muted">{t("fanout.compare.noWorktree")}</div>}
                  {v.exists && current && (diff ? <UnifiedDiff diff={diff} /> : <div className="text-[11.5px] text-muted-2" data-fanout-nochange>{t("fanout.compare.noChange")}</div>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
