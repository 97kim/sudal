// 채팅 오른쪽 패널. 컨텍스트 / 파일 탐색기를 탭으로 전환하고, 접거나 왼쪽 가장자리를 끌어 너비를 바꾼다.
// 너비·접힘·탭은 localStorage 에 남겨 다음 실행에도 유지한다.

import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PaneSplitContext } from "../pane-focus";
import { FileTree } from "./FileTree";
import { Icon } from "./Icon";
import { startDrag } from "../drag";

export type RightPanelTab = "context" | "files";

const MIN_W = 240;
const MAX_W = 640;
const DEFAULT_W = 300;
const KEY = "sudal.rightPanel";

interface Saved {
  width: number;
  collapsed: boolean;
  tab: RightPanelTab;
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    return {
      width: Math.min(MAX_W, Math.max(MIN_W, Number(raw.width) || DEFAULT_W)),
      collapsed: raw.collapsed === true,
      tab: raw.tab === "files" ? "files" : "context",
    };
  } catch {
    return { width: DEFAULT_W, collapsed: false, tab: "context" };
  }
}

const TABS: { id: RightPanelTab; icon: "list" | "folder" }[] = [
  { id: "context", icon: "list" },
  { id: "files", icon: "folder" },
];

export function RightPanel({
  cwd,
  context,
}: {
  cwd: string;
  context: ReactNode;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<Saved>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* 저장 실패는 무시 */
    }
  }, [saved]);
  // 분할 화면이면 칸이 좁아 기본으로 접는다. 칸에서 펼치고 접은 건 저장하지 않는다 — 한 칸일 때의 설정을 바꾸지 않게.
  const split = useContext(PaneSplitContext);
  const [splitCollapsed, setSplitCollapsed] = useState(true);
  const collapsed = split ? splitCollapsed : saved.collapsed;
  const setTab = (tab: RightPanelTab) => {
    if (split) setSplitCollapsed(false);
    setSaved((s) => ({ ...s, tab, collapsed: split ? s.collapsed : false }));
  };
  const toggle = () => (split ? setSplitCollapsed((c) => !c) : setSaved((s) => ({ ...s, collapsed: !s.collapsed })));

  // 왼쪽 가장자리 드래그로 너비 조절. 왼쪽으로 끌면 넓어진다.
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = saved.width;
      const move = (ev: MouseEvent) =>
        setSaved((s) => ({
          ...s,
          width: Math.min(
            MAX_W,
            Math.max(MIN_W, startW + (startX - ev.clientX)),
          ),
        }));
      startDrag(move, "col-resize");
    },
    [saved.width],
  );

  if (collapsed) {
    return (
      <aside
        className="mb-3 mr-3 flex w-10 shrink-0 flex-col items-center gap-1 bg-panel py-2"
        data-right-panel="collapsed"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setTab(tab.id)}
            className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
            title={t("panel.right.expand", { name: t(`panel.right.tabs.${tab.id}`) })}
          >
            <Icon name={tab.icon} size={14} />
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside
      className="relative mb-3 mr-3 flex shrink-0 flex-col overflow-hidden rounded-xl bg-panel"
      style={{ width: saved.width }}
      data-right-panel={saved.tab}
    >
      <div
        onMouseDown={onDragStart}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        title={t("panel.right.resize")}
      />
      <div className="flex h-11 items-center gap-1 px-2">
        {TABS.map((tab) => {
          const active = saved.tab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium ${
                active ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"
              }`}
            >
              <Icon
                name={tab.icon}
                size={13}
                className={active ? "text-accent" : ""}
              />
              {t(`panel.right.tabs.${tab.id}`)}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          onClick={toggle}
          className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
          title={t("panel.right.collapse")}
        >
          <Icon name="panelRight" size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {saved.tab === "context" ? (
          context
        ) : cwd ? (
          <FileTree root={cwd} />
        ) : (
          <p className="px-4 text-muted">{t("panel.right.noCwd")}</p>
        )}
      </div>
    </aside>
  );
}
