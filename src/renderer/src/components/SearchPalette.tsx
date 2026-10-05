// ⌘F 대화 검색: 모든 세션(닫힌 것 포함)의 사용자·어시스턴트 텍스트를 부분 일치로 찾는다.
// 결과는 세션별로 묶이고, 고르면 그 세션을 열고 해당 블록으로 스크롤한다.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SearchResultDto } from "@shared/ipc";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

interface Row {
  tabId: string;
  blockId: string;
  title: string;
  workspaceName: string;
  open: boolean;
  kind: "user" | "assistant" | "tool";
  snippet: string;
  first: boolean;
}

export function SearchPalette({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (tabId: string, blockId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // 입력 후 180ms 디바운스. 늦게 온 응답이 최신 결과를 덮지 않게 seq 로 거른다.
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      ++seq.current; // 늦게 오는 이전 응답을 무효화
      setResults([]);
      setSearching(false);
      return;
    }
    const my = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      window.sudal.chat
        .search(q)
        .then((r) => {
          if (my !== seq.current) return;
          setResults(r);
          setCursor(0);
        })
        .catch(console.error)
        .finally(() => my === seq.current && setSearching(false));
    }, 180);
    return () => clearTimeout(t);
  }, [query]);

  const rows: Row[] = results.flatMap((r) =>
    r.hits.map((h, i) => ({
      tabId: r.tabId,
      blockId: h.blockId,
      title: r.title,
      workspaceName: r.workspaceName,
      open: r.open,
      kind: h.kind,
      snippet: h.snippet,
      first: i === 0,
    })),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown" && rows.length) {
        e.preventDefault();
        setCursor((c) => (c + 1) % rows.length);
      } else if (e.key === "ArrowUp" && rows.length) {
        e.preventDefault();
        setCursor((c) => (c - 1 + rows.length) % rows.length);
      } else if (e.key === "Enter" && rows[cursor]) {
        onPick(rows[cursor].tabId, rows[cursor].blockId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, onClose, onPick]);
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const total = results.reduce((n, r) => n + r.hits.length, 0);

  return (
    <Modal variant="palette" onClose={onClose} className="w-[640px] overflow-hidden" data-search-palette>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Icon name="search" size={14} className="text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("nav.search.placeholder")}
          className="flex-1 bg-transparent outline-none placeholder:text-muted"
          style={{ userSelect: "text" }}
        />
        {searching && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />
        )}
        <kbd className="label">esc</kbd>
      </div>
      <ul ref={listRef} className="max-h-[420px] overflow-y-auto p-2">
        {rows.length === 0 && (
          <li className="px-3 py-6 text-center text-muted">
            {query.trim()
              ? searching
                ? t("nav.search.searching")
                : t("nav.search.noMatch")
              : t("nav.search.hint")}
          </li>
        )}
        {rows.map((row, i) => (
          <li key={`${row.tabId}:${row.blockId}`}>
            {row.first && (
              <div className="mt-2 flex items-baseline gap-2 px-3 pb-1 pt-1 first:mt-0">
                <span className="truncate font-medium">{row.title}</span>
                <span className="label shrink-0 text-muted">{row.workspaceName}</span>
                {!row.open && <span className="label shrink-0 text-muted-2">{t("nav.search.closed")}</span>}
              </div>
            )}
            <div
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(row.tabId, row.blockId)}
              className={`flex cursor-default items-start gap-2 rounded-md px-3 py-1.5 ${
                cursor === i ? "bg-panel-2" : ""
              }`}
              data-search-hit
            >
              <span
                className={`label mt-0.5 w-7 shrink-0 ${row.kind === "user" ? "text-accent" : row.kind === "tool" ? "text-muted-2" : "text-muted"}`}
              >
                {t(`nav.search.kind.${row.kind}`)}
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] text-fg">{row.snippet}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="label flex justify-between border-t border-line px-4 py-2">
        <span>{t("nav.search.navHint")}</span>
        <span>{total > 0 ? t("nav.search.summary", { count: results.length, hits: total }) : ""}</span>
      </div>
    </Modal>
  );
}
