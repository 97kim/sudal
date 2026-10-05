import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceStateDto } from "@shared/ipc";
import { shortenHome } from "@shared/path-display";
import { Icon } from "./Icon";

/** ⌘K 팔레트: 워크스페이스를 고르면 그 워크스페이스에 새 세션을 연다. 검색어가 없는 이름이면 그 이름으로 새 워크스페이스. */
export function WorkspaceSwitcher({
  ws,
  onClose,
  onPick,
  onAdd,
  onRemove,
}: {
  ws: WorkspaceStateDto;
  onClose: () => void;
  onPick: (workspaceId: string) => void;
  onAdd: (name: string) => void;
  onRemove: (workspaceId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...ws.model.workspaces]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .filter(
        (w) =>
          !q ||
          w.name.toLowerCase().includes(q) ||
          w.path.toLowerCase().includes(q),
      );
  }, [ws.model.workspaces, query]);

  const total = items.length + 1; // + "폴더 추가"

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown") setCursor((c) => (c + 1) % total);
      else if (e.key === "ArrowUp") setCursor((c) => (c - 1 + total) % total);
      else if (e.key === "Enter") {
        if (cursor < items.length) onPick(items[cursor].id);
        else onAdd(query.trim());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, items, total, onClose, onPick, onAdd]);

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-overlay/50 pt-24"
      onClick={onClose}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="search" size={14} className="text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            placeholder={t("nav.switcher.placeholder")}
            className="flex-1 bg-transparent outline-none placeholder:text-muted"
            style={{ userSelect: "text" }}
          />
          <kbd className="label">esc</kbd>
        </div>
        <ul className="max-h-[360px] overflow-y-auto p-2">
          {items.map((w, i) => {
            const openCount = ws.model.tabs.filter(
              (t) => t.workspaceId === w.id && t.open,
            ).length;
            return (
              <li key={w.id}>
                <div
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onPick(w.id)}
                  className={`group flex cursor-default items-center gap-3 rounded-md px-3 py-2 ${
                    cursor === i ? "bg-panel-2" : ""
                  }`}
                >
                  <Icon name="folder" size={14} className="text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{w.name}</span>
                    <span className="mono block truncate text-[10.5px] text-muted">
                      {w.path ? shortenHome(w.path) : t("nav.switcher.noDefaultPath")}
                    </span>
                  </span>
                  {openCount > 0 && (
                    <span className="label">{t("nav.switcher.openCount", { count: openCount })}</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(w.id);
                    }}
                    className="rounded p-1 text-muted opacity-0 hover:bg-panel-2 hover:text-err group-hover:opacity-100"
                    title={t("nav.switcher.remove")}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </li>
            );
          })}
          <li>
            <div
              onMouseEnter={() => setCursor(items.length)}
              onClick={() => onAdd(query.trim())}
              className={`flex cursor-default items-center gap-3 rounded-md px-3 py-2 ${
                cursor === items.length ? "bg-panel-2" : ""
              }`}
            >
              <span className="flex h-[14px] w-[14px] items-center justify-center text-accent">
                +
              </span>
              <span className="font-medium">
                {query.trim()
                  ? t("nav.switcher.createNamed", { name: query.trim() })
                  : t("nav.switcher.createNew")}
              </span>
            </div>
          </li>
        </ul>
        <div className="label flex justify-between border-t border-line px-4 py-2">
          <span>{t("nav.switcher.navHint")}</span>
          <span>{t("nav.switcher.count", { count: ws.model.workspaces.length })}</span>
        </div>
      </div>
    </div>
  );
}
