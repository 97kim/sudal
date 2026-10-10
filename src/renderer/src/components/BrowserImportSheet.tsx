// 다른 브라우저(Chrome·Edge)의 로그인을 인앱 브라우저로 가져오는 시트. 고른 사이트의 쿠키만 바꾼다.
// 사이트 목록·개수만 받고 쿠키 값은 main 이 다룬다 — 이 화면엔 오지 않는다.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

/** 지금 보던 주소의 호스트와 같거나 그 상위 도메인인 사이트 — 처음에 체크해 둔다. */
function matchesHost(site: string, host: string): boolean {
  return !!host && (host === site || host.endsWith(`.${site}`));
}

export function BrowserImportSheet({ currentHost, onClose, onDone }: { currentHost: string; onClose: () => void; onDone: (r: { sites: number; imported: number; skipped: number }) => void }) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [sites, setSites] = useState<{ host: string; count: number }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.sudal.browser.importSources().then((r) => {
      setSupported(r.supported);
      setSources(r.sources);
      setSource(r.sources[0]?.id ?? null);
    });
  }, []);
  useEffect(() => {
    if (!source) return;
    setSites(null);
    void window.sudal.browser.importSites(source).then((list) => {
      setSites(list);
      setPicked(new Set(list.filter((s) => matchesHost(s.host, currentHost)).map((s) => s.host)));
    });
  }, [source, currentHost]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // 고른 것이 위로 — 찾지 않아도 무엇을 가져오는지 보인다.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sites ?? []).filter((s) => !q || s.host.includes(q)).sort((a, b) => Number(picked.has(b.host)) - Number(picked.has(a.host)));
  }, [sites, query, picked]);

  const toggle = (host: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });

  const run = async () => {
    if (!source || picked.size === 0) return;
    setBusy(true);
    setError(null);
    // macOS 가 키체인 접근 허용 창을 띄운다 — 사람이 누를 때까지 기다린다.
    const r = await window.sudal.browser.importLogins(source, [...picked]).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    setBusy(false);
    if (!r.ok) setError(r.error);
    // 하나도 못 가져왔으면 성공처럼 닫지 않는다.
    else if (r.imported === 0) setError(t("panel.browser.import.none", { failed: r.failed + r.partitioned }));
    else onDone({ sites: picked.size, imported: r.imported, skipped: r.failed + r.partitioned });
  };

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-bg/60 px-4 pt-10" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} data-browser-import>
      <div className="flex max-h-[85%] w-full max-w-[420px] flex-col overflow-hidden rounded-xl border border-line bg-panel-2 shadow-2xl">
        <div className="px-4 pb-3 pt-4">
          <div className="text-[14px] font-semibold text-fg">{t("panel.browser.import.title")}</div>
          <div className="mt-1 text-[11.5px] text-muted">{t("panel.browser.import.sub")}</div>
        </div>
        {supported === false ? (
          <div className="px-4 pb-4 text-[12px] text-muted" data-browser-import-unsupported>
            {t("panel.browser.import.unsupported")}
          </div>
        ) : sources.length === 0 && supported ? (
          <div className="px-4 pb-4 text-[12px] text-muted">{t("panel.browser.import.noSources")}</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
              {sources.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSource(s.id)}
                  className={`rounded-md border px-2.5 py-1 text-[11.5px] ${s.id === source ? "border-accent bg-accent-tint text-accent" : "border-line text-muted hover:text-fg"}`}
                  data-browser-import-source={s.id}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 border-y border-line px-4 py-2">
              <Icon name="search" size={12} className="text-muted-2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={t("panel.browser.import.search")}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-muted-2"
                style={{ userSelect: "text" }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sites === null ? (
                <div className="px-4 py-3 text-[11.5px] text-muted">{t("common.loading")}</div>
              ) : (
                shown.slice(0, 200).map((s) => (
                  <label key={s.host} className="flex cursor-pointer items-center gap-2.5 px-4 py-1.5 text-[12px] hover:bg-panel" data-browser-import-site={s.host}>
                    <input type="checkbox" checked={picked.has(s.host)} onChange={() => toggle(s.host)} className="accent-[var(--color-accent)]" />
                    <span className="min-w-0 flex-1 truncate text-fg">{s.host}</span>
                    {matchesHost(s.host, currentHost) && <span className="shrink-0 rounded bg-accent-tint px-1.5 text-[10px] text-accent">{t("panel.browser.import.here")}</span>}
                    <span className="shrink-0 text-[10.5px] text-muted-2">{t("panel.browser.import.cookies", { count: s.count })}</span>
                  </label>
                ))
              )}
            </div>
          </>
        )}
        {error && <div className="border-t border-line bg-err-bg px-4 py-2 text-[11.5px] text-err" data-browser-import-error>{error}</div>}
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <Icon name="info" size={12} className="shrink-0 text-muted-2" />
          <span className="min-w-0 flex-1 text-[10.5px] text-muted-2">{t("panel.browser.import.note")}</span>
          <button onClick={onClose} disabled={busy} className="rounded-md border border-line px-3 py-1 text-[11.5px] text-muted hover:text-fg disabled:opacity-40">
            {t("common.cancel")}
          </button>
          {supported !== false && (
            <button
              onClick={() => void run()}
              disabled={busy || picked.size === 0}
              className="rounded-md bg-accent px-3 py-1 text-[11.5px] font-semibold text-bg hover:opacity-90 disabled:opacity-40"
              data-browser-import-run
            >
              {busy ? t("panel.browser.import.running") : t("panel.browser.import.run", { count: picked.size })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
