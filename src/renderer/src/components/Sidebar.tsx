import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionStatus } from "@shared/chat-events";
import { isScheduleWorkspace } from "@shared/schedules";
import type { AppInfoDto, WorkspaceStateDto, SessionAttention } from "@shared/ipc";
import {
  tabTitle,
  workspaceTabs,
  type TabMeta,
  type Workspace,
} from "@shared/workspace-model";
import { moveNextTo, neighborOf } from "@shared/reorder";
import { Icon } from "./Icon";
import { isMod, scApp } from "../platform";
import { EMPTY_SELECTION, pruneSelection, rangeSelection, toggleSelection, type TabSelection } from "@shared/sidebar-select";
import { ProviderLogo } from "./ProviderLogo";
import { Logo } from "./Logo";
import { SidebarLimits } from "./SidebarLimits";
import { SidebarUpdate } from "./SidebarUpdate";
import { attentionLabel, StatusDot } from "./StatusDot";

export type View = "chat" | "usage" | "settings";

const NAV: { id: View; icon: "chat" | "usage" | "settings" }[] =
  [
    { id: "chat", icon: "chat" },
    { id: "usage", icon: "usage" },
    { id: "settings", icon: "settings" },
  ];

/** 워크스페이스마다 닫힌 세션은 이만큼만. 그 아래는 "n개 더" 로 접는다. */
const CLOSED_LIMIT = 12;
const COLLAPSED_KEY = "sudal.sidebar.collapsed";
/** 드래그 중 자동 스크롤이 작동하는 가장자리 폭과 최대 속도(px/s). */
const EDGE_PX = 24;
const MAX_SCROLL_SPEED = 360;

type Menu =
  | { kind: "tab"; id: string; x: number; y: number }
  /** 여러 개 고른 세션 중 하나를 우클릭했다 — 고른 것 전체에 대한 메뉴 */
  | { kind: "tabs"; id: string; x: number; y: number }
  | { kind: "ws"; id: string; x: number; y: number };

/**
 * 좌측 패널 = 워크스페이스 트리. 워크스페이스 행 아래에 그 워크스페이스의 세션(탭)들이 붙는다.
 * 열린 세션은 탭바 순서, 닫힌 세션은 흐리게 최근 순. 행에 마우스를 올리면 × (열린 세션은 닫기, 닫힌 세션은 삭제).
 */
export function Sidebar({
  view,
  onView,
  onOpenUpdate,
  ws,
  info,
  onNewTab,
  onNewTabIn,
  onOpenTab,
  onCloseTab,
  onRenameTab,
  onDeleteTab,
  onCreateWorkspace,
  onRenameWorkspace,
  onSetWorkspacePath,
  onClearWorkspacePath,
  onRemoveWorkspace,
  onSwitchWorkspace,
  onSearch,
  onExportTab,
  onSplitTab,
  onJumpAttention,
  onNewWorktreeIn,
  onReorderTabs,
  onReorderWorkspaces,
  railed,
  onToggleRail,
}: {
  /** 접힘: 얇은 띠만 남긴다. 아주 없애지 않는 이유는 macOS 신호등 버튼 자리를 지켜야 해서다. */
  railed: boolean;
  onToggleRail: () => void;
  view: View;
  onView: (v: View) => void;
  /** 설정의 업데이트 카드가 있는 곳(일반)으로. 설정이 다른 섹션에 머물러 있어도 카드가 보이게. */
  onOpenUpdate: () => void;
  ws: WorkspaceStateDto;
  info: AppInfoDto | null;
  onNewTab: () => void;
  /** ⌘F 대화 검색 팔레트. */
  onSearch: () => void;
  /** 응답 필요 세션(권한 대기·미확인 완료)으로 점프 (⌘⇧↓). */
  onJumpAttention: () => void;
  /** 세션을 마크다운 파일로 내보내기(저장 다이얼로그). */
  onExportTab: (tabId: string) => void;
  /** 채팅 화면을 좌우로 나눠 이 탭을 오른쪽 칸에 연다. */
  onSplitTab: (tabId: string) => void;
  onNewTabIn: (workspaceId: string) => void;
  /** 격리 세션: 브랜치 + git worktree 를 만들어 그 경로에서 새 세션을 연다. */
  onNewWorktreeIn: (workspaceId: string) => void;
  onOpenTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, title: string) => void;
  onDeleteTab: (tabId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  /** 디렉토리 선택 다이얼로그를 띄워 기본 경로를 정한다. */
  onSetWorkspacePath: (workspaceId: string) => void;
  onClearWorkspacePath: (workspaceId: string) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onSwitchWorkspace: () => void;
  /** 끌어 옮긴 열린 세션 순서(모든 워크스페이스를 통틀어). */
  onReorderTabs: (openTabIds: string[]) => void;
  onReorderWorkspaces: (workspaceIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const { model, statuses, attention } = ws;
  const attentionCount = model.openTabIds.filter((id) => attention[id]).length;
  const activeTab = model.tabs.find((t) => t.id === model.activeTabId) ?? null;
  const activeWs: Workspace | null =
    (activeTab &&
      model.workspaces.find((w) => w.id === activeTab.workspaceId)) ??
    [...model.workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ??
    null;
  // 사용자가 끌어서 정한 순서를 따른다. 최근 사용순으로 자동 정렬하면 자리가 계속 바뀌어
  // 손으로 맞춘 순서가 남지 않는다 — 둘은 같이 쓸 수 없다.
  // 예약 결과가 모이는 칸만 맨 위에 둔다. 사람이 만든 것이 아니라 앱이 만든 자리라, 손으로 맞춘
  // 순서 사이에 끼어 있으면 매번 찾아야 한다. 저장된 순서는 건드리지 않는다 — 보이는 순서만 바꾼다.
  const workspaces = useMemo(() => {
    const i = model.workspaces.findIndex(isScheduleWorkspace);
    if (i <= 0) return model.workspaces;
    const list = [...model.workspaces];
    return [list.splice(i, 1)[0], ...list];
  }, [model.workspaces]);

  // 끌어 옮기기. 워크스페이스끼리, 그리고 같은 워크스페이스의 "열린" 세션끼리만 자리를 바꾼다
  // (닫힌 세션은 최근 순으로 보여 주므로 자리를 정할 수 없다).
  type DragItem = { kind: "ws" | "tab"; id: string; wsId: string };
  // 끌고 있는 것은 ref 로도 들고 있는다 — 상태만 쓰면 dragstart 직후의 dragover 가 아직 옛 값을 본다.
  const dragRef = useRef<DragItem | null>(null);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const dropRef = useRef<{ id: string; after: boolean } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  // 드래그 중 목록 자동 스크롤. 세션이 많으면 목적지가 화면 밖이라 끌고 갈 수가 없다.
  // 가장자리 EDGE_PX 안에서만 움직이고, 가장자리에 가까울수록 빨라진다.
  const autoScroll = useRef<{ el: HTMLElement; speed: number } | null>(null);
  const rafRef = useRef(0);
  const stopAutoScroll = () => {
    autoScroll.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };
  const onTreeDragOver = (e: React.DragEvent) => {
    if (!dragRef.current) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const fromTop = e.clientY - r.top;
    const fromBottom = r.bottom - e.clientY;
    let speed = 0;
    if (fromTop < EDGE_PX) speed = -MAX_SCROLL_SPEED * Math.min(1, (EDGE_PX - fromTop) / EDGE_PX);
    else if (fromBottom < EDGE_PX) speed = MAX_SCROLL_SPEED * Math.min(1, (EDGE_PX - fromBottom) / EDGE_PX);
    if (speed === 0) {
      stopAutoScroll();
      return;
    }
    autoScroll.current = { el, speed };
    if (rafRef.current) return; // 이미 돌고 있다 — 속도만 갱신했다
    let prev = performance.now();
    const step = (t: number) => {
      const cur = autoScroll.current;
      if (!cur) {
        rafRef.current = 0;
        return;
      }
      cur.el.scrollTop += (cur.speed * (t - prev)) / 1000;
      prev = t;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  // 끌기 말고도 자리를 옮길 수 있어야 한다 — 마우스를 끌기 어려운 경우도 있고,
  // 목록이 길면 한 칸 옮기는 데도 끌고 가야 한다. 메뉴는 클릭·키보드 양쪽에서 열린다.
  const openTabIdsOf = (wsId: string) => workspaceTabs(model, wsId).filter((t) => t.open).map((t) => t.id);
  const moveTabBy = (tabId: string, wsId: string, dir: "up" | "down") => {
    const neighbor = neighborOf(openTabIdsOf(wsId), tabId, dir);
    if (neighbor) onReorderTabs(moveNextTo(model.openTabIds, tabId, neighbor, dir === "down"));
  };
  const moveWsBy = (wsId: string, dir: "up" | "down") => {
    const ids = model.workspaces.map((w) => w.id);
    const neighbor = neighborOf(ids, wsId, dir);
    if (neighbor) onReorderWorkspaces(moveNextTo(ids, wsId, neighbor, dir === "down"));
  };

  const endDrag = () => {
    stopAutoScroll();
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDropAt(null);
  };
  // 끄는 쪽과 받는 쪽을 나눈다. 워크스페이스는 헤더에서 끌지만 받는 자리는 그룹 전체다 —
  // 헤더에만 선을 그리면 "A 뒤" 가 A 의 세션들 위에 그려져, 실제로 들어갈 자리(A 그룹 다음)와 어긋난다.
  const dragSource = (kind: "ws" | "tab", id: string, wsId: string, canDrag: boolean) => ({
    draggable: canDrag,
    onDragStart: (e: React.DragEvent) => {
      dragRef.current = { kind, id, wsId };
      setDrag({ kind, id, wsId });
      // 텍스트로도 실어 둔다 — 브라우저가 드래그를 시작하려면 무엇이든 담겨 있어야 한다.
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: endDrag,
    "data-dragging": drag?.id === id ? "true" : undefined,
  });

  const dropTarget = (kind: "ws" | "tab", id: string, wsId: string, canDrop: boolean) => {
    // 받을 수 없는 자리에는 선을 그리지 않는다. draggable=false 는 출발만 막을 뿐이라,
    // 닫힌 세션 위에도 선이 떠서 "될 것처럼 보이고 아무 일도 안 일어나는" 상태가 됐었다.
    const mine = () => {
      const d = dragRef.current;
      return canDrop && d !== null && d.kind === kind && (kind === "ws" || d.wsId === wsId) && d.id !== id;
    };
    const clear = () => {
      if (dropRef.current?.id !== id) return;
      dropRef.current = null;
      setDropAt(null);
    };
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!mine()) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        dropRef.current = { id, after };
        setDropAt((prev) => (prev && prev.id === id && prev.after === after ? prev : { id, after }));
      },
      // 벗어나면 선을 지운다. 안쪽 요소로 옮겨 다니는 것은 벗어난 것이 아니다.
      onDragLeave: (e: React.DragEvent) => {
        const to = e.relatedTarget as Node | null;
        if (to && (e.currentTarget as HTMLElement).contains(to)) return;
        clear();
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const moved = dragRef.current;
        if (mine() && moved) {
          const drop = dropRef.current;
          const after = drop?.id === id ? drop.after : false;
          if (kind === "ws") onReorderWorkspaces(moveNextTo(model.workspaces.map((w) => w.id), moved.id, id, after));
          else onReorderTabs(moveNextTo(model.openTabIds, moved.id, id, after));
        }
        endDrag();
      },
      // 선이 들어가도 자리가 밀리지 않게 그림자로 그린다.
      style: (dropAt?.id === id
        ? { boxShadow: `inset 0 ${dropAt.after ? "-2px" : "2px"} 0 var(--color-accent)` }
        : undefined) as React.CSSProperties | undefined,
      "data-drop": dropAt?.id === id ? (dropAt.after ? "after" : "before") : undefined,
    };
  };

  // 워크스페이스 접힘 상태 (저장).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      return new Set(
        Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* 무시 */
      }
      return next;
    });
  const [showAllClosed, setShowAllClosed] = useState<Set<string>>(new Set());
  // 여러 세션 고르기(⌘·Ctrl+클릭, Shift+클릭). 범위는 화면에 보이는 순서로 잡는다 — 접힌 워크스페이스·숨긴 닫힌 세션은 빼고.
  const [selection, setSelection] = useState<TabSelection>(EMPTY_SELECTION);
  const selectableOrder = useMemo(() => {
    const out: string[] = [];
    // 화면에 그리는 순서(예약 워크스페이스가 맨 위로 올라간다)와 같아야 Shift 범위에 안 보이는 세션이 끼지 않는다
    for (const w of workspaces) {
      if (collapsed.has(w.id)) continue;
      const tabs = workspaceTabs(model, w.id);
      const closed = tabs.filter((t) => !t.open).length;
      const hidden = showAllClosed.has(w.id) ? 0 : Math.max(0, closed - CLOSED_LIMIT);
      for (const t of hidden > 0 ? tabs.slice(0, tabs.length - hidden) : tabs) out.push(t.id);
    }
    return out;
  }, [model, workspaces, collapsed, showAllClosed]);
  useEffect(() => setSelection((s) => pruneSelection(s, selectableOrder)), [selectableOrder]);
  // 워크스페이스 만들기(이름 입력 행) · 워크스페이스 이름 변경(행 안에서).
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [renamingWs, setRenamingWs] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const wsRenameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renamingWs) wsRenameRef.current?.select();
  }, [renamingWs?.id]);
  const commitCreate = () => {
    const name = createDraft.trim();
    setCreating(false);
    setCreateDraft("");
    if (name) onCreateWorkspace(name);
  };
  const commitWsRename = () => {
    if (!renamingWs) return;
    const w = model.workspaces.find((x) => x.id === renamingWs.id);
    if (w && renamingWs.draft.trim() && renamingWs.draft.trim() !== w.name)
      onRenameWorkspace(w.id, renamingWs.draft);
    setRenamingWs(null);
  };

  // 우클릭 메뉴 + 행 안에서 하는 이름 변경·삭제/제거 확인.
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{
    tabId: string;
    draft: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "tab" | "ws"; id: string }
    /** 고른 세션 여러 개 삭제. 확인 줄은 id(화면에서 맨 위에 있는 고른 세션) 자리에 띄운다. */
    | { kind: "tabs"; id: string; ids: string[] }
    | null
  >(null);
  // 확인 줄을 띄운 뒤 선택이 바뀌면(워크스페이스를 접어 빠지는 등) 그 확인은 이제 맞지 않는다 — 숨은 세션까지 지울 뻔했다
  useEffect(() => setConfirm((c) => (c?.kind === "tabs" ? null : c)), [selection]);
  const selectedInOrder = () => selectableOrder.filter((id) => selection.ids.has(id));
  const askDeleteSelected = () => {
    const ids = selectedInOrder();
    if (ids.length > 0) setConfirm({ kind: "tabs", id: ids[0], ids });
  };
  // 고른 세션이 있을 때: Delete(Mac 은 ⌫)로 삭제 확인, Esc 로 선택 풀기. 입력칸에 쓰는 중이면 그 키를 가로채지 않는다.
  useEffect(() => {
    if (selection.ids.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      // 포커스가 사이드바 안이거나 아무 데도 없을 때만 — 다른 화면(설정·팔레트·입력칸)에서 누른 ⌫ 를 가로채지 않는다
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && !el.closest("[data-sidebar]")) return;
      if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "")) return;
      if (e.key === "Escape") {
        setConfirm((c) => (c?.kind === "tabs" ? null : c));
        setSelection(EMPTY_SELECTION);
      }
      else if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        askDeleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const renameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming?.tabId]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const commitRename = () => {
    if (!renaming) return;
    const tab = model.tabs.find((t) => t.id === renaming.tabId);
    if (tab && renaming.draft.trim() !== (tab.title ?? "").trim())
      onRenameTab(renaming.tabId, renaming.draft);
    setRenaming(null);
  };
  const menuTab =
    menu?.kind === "tab" ? model.tabs.find((t) => t.id === menu.id) : null;
  const menuWs =
    menu?.kind === "ws" ? model.workspaces.find((w) => w.id === menu.id) : null;
  const openMenu = (e: React.MouseEvent, m: Menu) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(m);
  };

  if (railed)
    return (
      <aside className="drag flex w-[52px] shrink-0 flex-col items-center bg-panel" data-sidebar="collapsed">
        <button
          onClick={onToggleRail}
          className="no-drag mt-3 rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg mac:mt-11"
          title={t("nav.sidebar.expand")}
          data-sidebar-toggle
        >
          <Icon name="panelRight" size={15} />
        </button>
        <nav className="no-drag mt-2 flex flex-col gap-0.5">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => onView(item.id)}
              title={t(`nav.items.${item.id}`)}
              className={`rounded-md p-1.5 transition-colors ${
                view === item.id ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2/60 hover:text-fg"
              }`}
            >
              <Icon name={item.icon} size={15} />
            </button>
          ))}
        </nav>
        <button
          onClick={activeWs ? onNewTab : () => onToggleRail()}
          className="no-drag mt-2 rounded-md bg-primary p-1.5 text-on-primary hover:bg-primary-hover"
          title={activeWs ? t("nav.sidebar.newSessionIn", { name: activeWs.name }) : t("nav.sidebar.addWorkspaceExpand")}
        >
          <Icon name="edit" size={14} strokeWidth={2} />
        </button>
        <button
          onClick={onSearch}
          className="no-drag mt-1 rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
          title={t("nav.sidebar.searchChatsRailTitle")}
        >
          <Icon name="search" size={15} />
        </button>
        {attentionCount > 0 && (
          <button
            onClick={onJumpAttention}
            className="no-drag mt-1 rounded-md bg-warn-bg p-1.5 text-warn"
            title={t("nav.sidebar.attentionRailTitle", { count: attentionCount })}
          >
            <Icon name="alert" size={15} />
          </button>
        )}
      </aside>
    );

  return (
    <aside className="drag flex w-[248px] shrink-0 flex-col bg-panel" data-sidebar="expanded">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4 mac:pt-11">
        <Logo size={22} className="text-fg" />
        <span className="text-[14px] font-semibold tracking-wide">Sudal</span>
        <button
          onClick={onToggleRail}
          className="no-drag -mr-1 ml-auto rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
          title={t("nav.sidebar.collapse")}
          data-sidebar-toggle
        >
          <Icon name="panelRight" size={14} />
        </button>
      </div>

      <nav className="no-drag flex gap-0.5 px-3 pb-3">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onView(item.id)}
            title={t(`nav.items.${item.id}`)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] transition-colors ${
              view === item.id
                ? "bg-panel-2 text-fg"
                : "text-muted hover:bg-panel-2/60 hover:text-fg"
            }`}
          >
            <Icon name={item.icon} size={13} />
            {t(`nav.items.${item.id}`)}
          </button>
        ))}
      </nav>

      <div className="no-drag px-3">
        <button
          onClick={activeWs ? onNewTab : () => setCreating(true)}
          className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 font-medium text-on-primary hover:bg-primary-hover"
          title={
            activeWs ? t("nav.sidebar.newSessionIn", { name: activeWs.name }) : t("nav.sidebar.addWorkspace")
          }
        >
          <Icon name="edit" size={14} strokeWidth={2} />
          <span className="flex-1 text-left">
            {activeWs ? t("nav.sidebar.newSession") : t("nav.sidebar.addWorkspace")}
          </span>
          {activeWs && <kbd className="mono text-[10px] opacity-70">{scApp("newTab")}</kbd>}
        </button>
        <button
          onClick={onSearch}
          className="mt-1.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg"
          title={t("nav.sidebar.searchChatsTitle")}
          data-search-button
        >
          <Icon name="search" size={13} />
          <span className="flex-1 text-left">{t("nav.sidebar.searchChats")}</span>
          <kbd className="mono text-[10px] opacity-70">{scApp("search")}</kbd>
        </button>
        {attentionCount > 0 && (
          <button
            onClick={onJumpAttention}
            className="mt-1 flex w-full items-center gap-2 rounded-md bg-warn-bg px-3 py-1.5 text-warn hover:brightness-95"
            title={t("nav.sidebar.attentionJumpTitle")}
            data-attention-jump
          >
            <Icon name="alert" size={13} />
            <span className="flex-1 text-left">{t("nav.sidebar.attentionJump", { count: attentionCount })}</span>
            <kbd className="mono text-[10px] opacity-70">{scApp("nextAttention")}</kbd>
          </button>
        )}
      </div>

      <div
        className="no-drag mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        onDragOver={onTreeDragOver}
        onDrop={stopAutoScroll}
        onDragLeave={(e) => {
          const to = e.relatedTarget as Node | null;
          // 목록을 아주 벗어났을 때만 멈춘다 — 안쪽 행 사이를 지나는 것은 벗어난 것이 아니다.
          if (!to || !(e.currentTarget as HTMLElement).contains(to)) stopAutoScroll();
        }}
        data-workspace-tree
      >
        <div className="label mb-1 flex items-center justify-between px-1">
          <span>{t("nav.sidebar.workspaces")}</span>
          <span className="flex items-center gap-0.5">
            <button
              onClick={onSwitchWorkspace}
              className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
              title={t("nav.sidebar.switchWorkspace")}
            >
              <Icon name="search" size={11} />
            </button>
            <button
              onClick={() => setCreating(true)}
              className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
              title={t("nav.sidebar.addWorkspaceEllipsis")}
            >
              <Icon name="plus" size={12} />
            </button>
          </span>
        </div>
        {creating && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-accent/50 bg-panel px-2 py-1.5">
            <Icon name="folder" size={13} className="shrink-0 text-accent" />
            <input
              autoFocus
              value={createDraft}
              onChange={(e) => setCreateDraft(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitCreate();
                else if (e.key === "Escape") {
                  setCreating(false);
                  setCreateDraft("");
                }
              }}
              placeholder={t("nav.sidebar.workspaceNameDraft")}
              className="min-w-0 flex-1 bg-transparent text-fg outline-none"
              style={{ userSelect: "text" }}
              data-ws-create
            />
          </div>
        )}
        {workspaces.length === 0 && !creating && (
          <p className="px-1 text-muted">
            {t("nav.sidebar.workspaceHint")}
          </p>
        )}

        {workspaces.map((w) => {
          const tabs = workspaceTabs(model, w.id);
          const openCount = tabs.filter((t) => t.open).length;
          // 접어 둔 워크스페이스 안에서 응답이 와도 알 수 있어야 한다.
          const unread = tabs.filter((t) => t.open && attention[t.id]).length;
          const isCollapsed = collapsed.has(w.id);
          const isActiveWs = activeWs?.id === w.id;
          const closedTabs = tabs.filter((t) => !t.open);
          const hiddenClosed = showAllClosed.has(w.id)
            ? 0
            : Math.max(0, closedTabs.length - CLOSED_LIMIT);
          const visible =
            hiddenClosed > 0 ? tabs.slice(0, tabs.length - hiddenClosed) : tabs;
          return (
            <div key={w.id} className="mb-1.5" data-workspace={w.id} {...dropTarget("ws", w.id, w.id, true)}>
              {confirm?.kind === "ws" && confirm.id === w.id ? (
                <ConfirmRow
                  text={t("nav.sidebar.removeWorkspaceConfirm")}
                  action={t("nav.sidebar.removeWorkspaceAction")}
                  onYes={() => {
                    setConfirm(null);
                    onRemoveWorkspace(w.id);
                  }}
                  onNo={() => setConfirm(null)}
                />
              ) : (
                <div
                  {...dragSource("ws", w.id, w.id, renamingWs?.id !== w.id)}
                  data-workspace-head={w.id}
                  onClick={() => toggleCollapsed(w.id)}
                  onContextMenu={(e) =>
                    openMenu(e, {
                      kind: "ws",
                      id: w.id,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                  className={`group flex cursor-default items-center gap-1.5 rounded-md py-1.5 pl-1 pr-1 ${
                    drag?.id === w.id ? "opacity-70" : ""
                  } ${
                    menu?.kind === "ws" && menu.id === w.id
                      ? "bg-panel-2"
                      : "hover:bg-panel-2/60"
                  }`}
                  onDoubleClick={() =>
                    setRenamingWs({ id: w.id, draft: w.name })
                  }
                  title={
                    w.path
                      ? t("nav.sidebar.defaultPath", { path: w.path })
                      : t("nav.sidebar.noDefaultPathTitle")
                  }
                >
                  <Icon
                    name="chevronRight"
                    size={11}
                    className={`shrink-0 text-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <Icon
                    name="folder"
                    size={13}
                    className={`shrink-0 ${isActiveWs ? "text-accent" : "text-muted"}`}
                  />
                  {renamingWs?.id === w.id ? (
                    <input
                      ref={wsRenameRef}
                      value={renamingWs.draft}
                      onChange={(e) =>
                        setRenamingWs({ id: w.id, draft: e.target.value })
                      }
                      onBlur={commitWsRename}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitWsRename();
                        else if (e.key === "Escape") setRenamingWs(null);
                      }}
                      placeholder={t("nav.sidebar.workspaceName")}
                      className="-mx-1 min-w-0 flex-1 rounded border border-accent/50 bg-panel px-1 font-medium text-fg outline-none"
                      style={{ userSelect: "text" }}
                    />
                  ) : (
                    <span
                      className={`min-w-0 flex-1 truncate font-medium ${isActiveWs ? "text-fg" : "text-fg/80"}`}
                      // 정해 둔 기본 경로를 볼 데가 없으면 정했는지도 알 수 없다.
                      title={w.path ? t("nav.sidebar.defaultPathDot", { path: w.path }) : t("nav.sidebar.noDefaultPathHint")}
                      data-ws-name
                    >
                      {w.name}
                    </span>
                  )}
                  {unread > 0 ? (
                    <span
                      className="label shrink-0 rounded-full bg-accent/20 px-1.5 font-medium text-accent group-hover:hidden"
                      title={t("nav.sidebar.unreadReplies", { count: unread })}
                      data-ws-unread={unread}
                    >
                      {unread}
                    </span>
                  ) : (
                    openCount > 0 && (
                      <span className="label shrink-0 text-muted-2 group-hover:hidden">
                        {openCount}
                      </span>
                    )
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewTabIn(w.id);
                    }}
                    className="hidden shrink-0 rounded p-0.5 text-muted hover:bg-panel hover:text-fg group-hover:block"
                    title={t("nav.sidebar.newSessionInWorkspace")}
                    data-ws-new
                  >
                    <Icon name="plus" size={12} />
                  </button>
                </div>
              )}

              {!isCollapsed && (
                <ul className="ml-3 flex flex-col gap-px border-l border-line pl-1.5" role="listbox" aria-multiselectable="true" aria-label={w.name}>
                  {tabs.length === 0 && (
                    <li className="px-2 py-1 text-[11px] text-muted-2">
                      {t("nav.sidebar.noSessions")}
                    </li>
                  )}
                  {visible.map((tab) => (
                    <li key={tab.id}>
                      {confirm?.kind === "tabs" && confirm.id === tab.id ? (
                        <ConfirmRow
                          text={t("nav.sidebar.deleteSelectedConfirm", { count: confirm.ids.length })}
                          action={t("nav.sidebar.deleteSessionAction")}
                          onYes={() => {
                            setConfirm(null);
                            setSelection(EMPTY_SELECTION);
                            for (const id of confirm.ids) onDeleteTab(id);
                          }}
                          onNo={() => setConfirm(null)}
                        />
                      ) : confirm?.kind === "tab" && confirm.id === tab.id ? (
                        <ConfirmRow
                          text={t("nav.sidebar.deleteSessionConfirm")}
                          action={t("nav.sidebar.deleteSessionAction")}
                          onYes={() => {
                            setConfirm(null);
                            onDeleteTab(tab.id);
                          }}
                          onNo={() => setConfirm(null)}
                        />
                      ) : (
                        <SessionRow
                          drag={{
                            ...dragSource("tab", tab.id, w.id, tab.open && renaming?.tabId !== tab.id),
                            ...dropTarget("tab", tab.id, w.id, tab.open),
                          }}
                          dragging={drag?.id === tab.id}
                          tab={tab}
                          status={statuses[tab.id] ?? "idle"}
                          attention={attention[tab.id] ?? null}
                          active={
                            tab.id === model.activeTabId && view === "chat"
                          }
                          highlighted={
                            menu?.kind === "tab" && menu.id === tab.id
                          }
                          selected={selection.ids.has(tab.id)}
                          renaming={
                            renaming?.tabId === tab.id ? renaming.draft : null
                          }
                          renameRef={renameRef}
                          onSelectKey={(range) =>
                            setSelection((s) =>
                              range ? rangeSelection(s, tab.id, selectableOrder, model.activeTabId) : toggleSelection(s, tab.id, model.activeTabId),
                            )
                          }
                          onClick={(e) => {
                            if (isMod(e)) return setSelection((s) => toggleSelection(s, tab.id, model.activeTabId));
                            if (e.shiftKey) return setSelection((s) => rangeSelection(s, tab.id, selectableOrder, model.activeTabId));
                            // 그냥 클릭은 지금처럼 연다. 고른 것은 풀고 Shift+클릭의 기준점만 남긴다.
                            setSelection({ ids: new Set(), anchor: tab.id });
                            onOpenTab(tab.id);
                          }}
                          onStartRename={() =>
                            setRenaming({
                              tabId: tab.id,
                              draft: tab.title ?? "",
                            })
                          }
                          onRenameChange={(v) =>
                            setRenaming({ tabId: tab.id, draft: v })
                          }
                          onRenameCommit={commitRename}
                          onRenameCancel={() => setRenaming(null)}
                          onContextMenu={(e) => {
                            // 여러 개 고른 것 중 하나면 고른 것 전체의 메뉴, 아니면 고른 것을 풀고 이 세션의 메뉴
                            const many = selection.ids.size > 1 && selection.ids.has(tab.id);
                            if (!many && selection.ids.size > 0) setSelection(EMPTY_SELECTION);
                            openMenu(e, { kind: many ? "tabs" : "tab", id: tab.id, x: e.clientX, y: e.clientY });
                          }}
                          onX={() =>
                            tab.open
                              ? onCloseTab(tab.id)
                              : setConfirm({ kind: "tab", id: tab.id })
                          }
                        />
                      )}
                    </li>
                  ))}
                  {hiddenClosed > 0 && (
                    <li>
                      <button
                        onClick={() =>
                          setShowAllClosed((s) => new Set(s).add(w.id))
                        }
                        className="px-2 py-1 text-[11px] text-muted hover:text-fg"
                      >
                        {t("nav.sidebar.showMoreClosed", { count: hiddenClosed })}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {menu && (menuTab || menuWs || menu.kind === "tabs") && (
        <div
          role="menu"
          data-session-menu
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag fixed z-50 min-w-[160px] rounded-lg border border-line bg-panel p-1 shadow-pop"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 140),
          }}
        >
          {menu.kind === "tabs" && (
            <>
              {(() => {
                const ids = selectedInOrder();
                const open = ids.filter((id) => model.tabs.find((x) => x.id === id)?.open);
                return (
                  <>
                    {open.length > 0 && (
                      <MenuItem
                        label={t("nav.sidebar.menu.closeSelected", { count: open.length })}
                        onPick={() => {
                          setMenu(null);
                          for (const id of open) onCloseTab(id);
                        }}
                      />
                    )}
                    <MenuItem
                      label={t("nav.sidebar.menu.clearSelection")}
                      onPick={() => {
                        setMenu(null);
                        setSelection(EMPTY_SELECTION);
                      }}
                    />
                    <div className="my-1 h-px bg-line" />
                    <MenuItem
                      label={t("nav.sidebar.menu.deleteSelected", { count: ids.length })}
                      danger
                      onPick={() => {
                        setMenu(null);
                        askDeleteSelected();
                      }}
                    />
                  </>
                );
              })()}
            </>
          )}
          {menuTab && (
            <>
              {menuTab.open && menuTab.id !== model.activeTabId && (
                <MenuItem
                  label={t("nav.sidebar.menu.openSplit")}
                  onPick={() => {
                    setMenu(null);
                    onSplitTab(menuTab.id);
                  }}
                />
              )}
              <MenuItem
                label={menuTab.open ? t("nav.sidebar.menu.close") : t("nav.sidebar.menu.open")}
                onPick={() => {
                  setMenu(null);
                  if (menuTab.open) onCloseTab(menuTab.id);
                  else onOpenTab(menuTab.id);
                }}
              />
              <MenuItem
                label={t("nav.sidebar.menu.rename")}
                onPick={() => {
                  setMenu(null);
                  setRenaming({
                    tabId: menuTab.id,
                    draft: menuTab.title ?? "",
                  });
                }}
              />
              {menuTab.open && (
                <>
                  <MenuItem
                    label={t("nav.sidebar.menu.moveUp")}
                    disabled={!neighborOf(openTabIdsOf(menuTab.workspaceId), menuTab.id, "up")}
                    onPick={() => {
                      setMenu(null);
                      moveTabBy(menuTab.id, menuTab.workspaceId, "up");
                    }}
                  />
                  <MenuItem
                    label={t("nav.sidebar.menu.moveDown")}
                    disabled={!neighborOf(openTabIdsOf(menuTab.workspaceId), menuTab.id, "down")}
                    onPick={() => {
                      setMenu(null);
                      moveTabBy(menuTab.id, menuTab.workspaceId, "down");
                    }}
                  />
                </>
              )}
              <MenuItem
                label={t("nav.sidebar.menu.exportMarkdown")}
                onPick={() => {
                  setMenu(null);
                  onExportTab(menuTab.id);
                }}
              />
              <div className="my-1 h-px bg-line" />
              <MenuItem
                label={t("nav.sidebar.menu.delete")}
                danger
                onPick={() => {
                  setMenu(null);
                  setConfirm({ kind: "tab", id: menuTab.id });
                }}
              />
            </>
          )}
          {menuWs && (
            <>
              <MenuItem
                label={t("nav.sidebar.menu.newSession")}
                onPick={() => {
                  setMenu(null);
                  onNewTabIn(menuWs.id);
                }}
              />
              <MenuItem
                label={t("nav.sidebar.menu.isolatedSession")}
                onPick={() => {
                  setMenu(null);
                  onNewWorktreeIn(menuWs.id);
                }}
              />
              <MenuItem
                label={collapsed.has(menuWs.id) ? t("nav.sidebar.menu.expand") : t("nav.sidebar.menu.collapse")}
                onPick={() => {
                  setMenu(null);
                  toggleCollapsed(menuWs.id);
                }}
              />
              <MenuItem
                label={t("nav.sidebar.menu.rename")}
                onPick={() => {
                  setMenu(null);
                  setRenamingWs({ id: menuWs.id, draft: menuWs.name });
                }}
              />
              <MenuItem
                label={t("nav.sidebar.menu.moveUp")}
                disabled={!neighborOf(model.workspaces.map((w) => w.id), menuWs.id, "up")}
                onPick={() => {
                  setMenu(null);
                  moveWsBy(menuWs.id, "up");
                }}
              />
              <MenuItem
                label={t("nav.sidebar.menu.moveDown")}
                disabled={!neighborOf(model.workspaces.map((w) => w.id), menuWs.id, "down")}
                onPick={() => {
                  setMenu(null);
                  moveWsBy(menuWs.id, "down");
                }}
              />
              <MenuItem
                label={menuWs.path ? t("nav.sidebar.menu.changeDefaultPath") : t("nav.sidebar.menu.setDefaultPath")}
                onPick={() => {
                  setMenu(null);
                  onSetWorkspacePath(menuWs.id);
                }}
              />
              {menuWs.path && (
                <MenuItem
                  label={t("nav.sidebar.menu.clearDefaultPath")}
                  onPick={() => {
                    setMenu(null);
                    onClearWorkspacePath(menuWs.id);
                  }}
                />
              )}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                label={t("nav.sidebar.menu.removeWorkspace")}
                danger
                onPick={() => {
                  setMenu(null);
                  setConfirm({ kind: "ws", id: menuWs.id });
                }}
              />
            </>
          )}
        </div>
      )}

      <SidebarLimits onOpen={() => onView("usage")} />

      <div className="px-4 py-3">
        <div className="text-[12px] font-medium">{info?.userName ?? ""}</div>
        <div className="mono text-[10px] text-muted">
          {t("nav.sidebar.workspaceCount", { count: model.workspaces.length })}{" "}
          {info ? `· v${info.version}` : ""}
        </div>
        {/* 업데이트 자리는 언제나 버전 아랫줄 — 문구 길이에 따라 줄이 오르내리지 않게 */}
        <SidebarUpdate onOpenSettings={onOpenUpdate} />
      </div>
    </aside>
  );
}

function SessionRow({
  drag,
  dragging,
  tab,
  status,
  attention,
  active,
  highlighted,
  selected,
  renaming,
  renameRef,
  onClick,
  onSelectKey,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onContextMenu,
  onX,
}: {
  tab: TabMeta;
  status: SessionStatus;
  attention: SessionAttention | null;
  active: boolean;
  highlighted: boolean;
  /** 여러 개 고르기로 골랐다 */
  selected: boolean;
  renaming: string | null;
  renameRef: React.RefObject<HTMLInputElement | null>;
  onClick: (e: React.MouseEvent) => void;
  /** 키보드로 고르기: Space(range=false 면 넣고 빼기), Shift+Space(범위). */
  onSelectKey: (range: boolean) => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onX: () => void;
  /** 끌어 옮기기 핸들러 묶음(사이드바가 만든다). 닫힌 세션·이름 바꾸는 중이면 꺼져 있다. */
  drag: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean };
  dragging: boolean;
}) {
  const { t } = useTranslation();
  const unread = tab.open ? attention : null;
  return (
    <div
      {...drag}
      onClick={onClick}
      // Shift+클릭으로 범위를 고를 때 글자가 같이 선택되지 않게
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      // 키보드로도 고르고 연다: Enter 열기, Space 넣고 빼기, Shift+Space 범위, ↑↓ 옆 세션으로
      tabIndex={renaming === null ? 0 : -1}
      role="option"
      aria-selected={selected}
      onKeyDown={(e) => {
        if (renaming !== null || e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        } else if (e.key === " ") {
          e.preventDefault();
          onSelectKey(e.shiftKey);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [...document.querySelectorAll<HTMLElement>("[data-sidebar] [data-session]")];
          rows[rows.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
        }
      }}
      className={`group flex cursor-default items-center gap-2 rounded-md py-1.5 pl-2 pr-1 outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
        dragging ? "opacity-70" : ""
      } ${selected ? "bg-accent/15" : active || highlighted ? "bg-panel-2" : "hover:bg-panel-2/60"}`}
      data-session={tab.id}
      data-selected={selected ? "true" : undefined}
      data-open={tab.open ? "true" : "false"}
    >
      <StatusDot
        status={tab.open ? status : "idle"}
        attention={tab.open ? attention : null}
        dim={!tab.open}
      />
      {renaming !== null ? (
        <input
          ref={renameRef}
          value={renaming}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRenameCommit();
            else if (e.key === "Escape") onRenameCancel();
          }}
          placeholder={t("nav.sidebar.sessionName")}
          className="-mx-1 block min-w-0 flex-1 rounded border border-accent/50 bg-panel px-1 text-fg outline-none"
          style={{ userSelect: "text" }}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${
            tab.open ? (unread ? "font-semibold text-fg" : "text-fg") : "text-muted"
          }`}
        >
          {tabTitle(tab, t("shared.untitledTab"))}
        </span>
      )}
      {/* 안 본 응답은 목록을 훑을 때 바로 눈에 들어와야 한다 — 왼쪽 상태 점은 색만 바뀌어 잘 안 보인다. */}
      {unread && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${unread === "error" ? "bg-err" : unread === "permission" ? "bg-warn" : "bg-accent"}`}
          title={attentionLabel(unread)}
          data-unread={unread}
        />
      )}
      <ProviderLogo provider={tab.provider} size={13} className="opacity-80 group-hover:hidden" />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onX();
        }}
        className={`hidden shrink-0 rounded p-0.5 group-hover:block ${
          tab.open
            ? "text-muted hover:bg-panel hover:text-fg"
            : "text-muted hover:bg-err-bg hover:text-err"
        }`}
        title={tab.open ? t("nav.sidebar.menu.close") : t("nav.sidebar.menu.delete")}
        data-session-x
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}

function ConfirmRow({
  text,
  action,
  onYes,
  onNo,
}: {
  text: string;
  action: string;
  onYes: () => void;
  onNo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 rounded-md bg-err-bg px-2 py-1.5 text-[12px] text-err">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button
        onClick={onYes}
        className="rounded px-1.5 py-0.5 font-medium hover:bg-err/10"
      >
        {action}
      </button>
      <button
        onClick={onNo}
        className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2"
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}

function MenuItem({
  label,
  onPick,
  danger,
  disabled,
}: {
  label: string;
  onPick: () => void;
  danger?: boolean;
  /** 지금은 할 수 없는 동작(맨 위에서 "위로 이동" 처럼). 감추지 않고 잠근다 — 자리가 흔들리지 않게. */
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onPick}
      disabled={disabled}
      aria-disabled={disabled}
      className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${
        disabled ? "cursor-default text-muted-2 opacity-60" : `hover:bg-panel-2 ${danger ? "text-err" : "text-fg"}`
      }`}
    >
      {label}
    </button>
  );
}
