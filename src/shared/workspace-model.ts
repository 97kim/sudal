// 워크스페이스(=작업 디렉토리) > 탭(=세션/스레드) 모델. 순수 함수 — main 이 영속화하고 renderer 가 그린다.

import type { PermissionPolicy, SessionStatus } from "./chat-events";
import { baseName } from "./path-display";
import type { Provider } from "./ipc";


/** 워크스페이스 = 업무 단위 이름표. path 는 새 세션의 기본 작업 경로(없으면 ""), 실제 경로는 탭마다 정한다. */
export interface Workspace {
  id: string;
  path: string;
  name: string;
  addedAt: number;
  lastUsedAt: number;
  /** 검증 명령(한 번에 순서대로 실행). 없으면 저장소 매니페스트에서 추천한다. */
  verifyCommands?: string[];
  /** 앱이 만든 자리. 이름은 만든 때의 언어로 저장되므로 이름이 아니라 이 값으로 찾는다. */
  builtin?: "schedules";
}

export interface TabMeta {
  id: string;
  workspaceId: string;
  /** 첫 사용자 메시지에서 따오거나 사용자가 붙인 이름. 없으면 "새 세션". */
  title: string | null;
  /** 사용자가 직접 붙인 이름이면 true — 첫 메시지 자동 제목·대화 비우기가 덮어쓰지 않는다. */
  titleCustom?: boolean;
  provider: Provider;
  model?: string;
  policy: PermissionPolicy;
  /** 이 탭의 작업 경로. 없으면 워크스페이스 기본 경로를 쓴다. */
  cwd?: string;
  /** 격리 세션: 이 탭 전용 git worktree. cwd 가 그 경로다. 정리하면 지워진다. */
  worktree?: WorktreeMeta;
  /** provider 세션 id — 재시작 후 resume 에 쓴다. */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  /** false 면 닫힌 탭. 사이드바 "최근" 에서 다시 열 수 있다. */
  open: boolean;
}

export interface WorktreeMeta {
  /** 원본 저장소 루트. */
  repo: string;
  /** worktree 경로 (= 탭 cwd). */
  path: string;
  /** 이 세션의 브랜치 (sudal/<slug>). */
  branch: string;
  /** 갈라져 나온 브랜치. 가져오기(merge) 대상. */
  base: string;
}

export interface WorkspaceModel {
  version: 1;
  workspaces: Workspace[];
  tabs: TabMeta[];
  /** 열린 탭의 표시 순서. */
  openTabIds: string[];
  activeTabId: string | null;
}

export const MAX_RECENT_TABS = 50;

export function emptyModel(): WorkspaceModel {
  return { version: 1, workspaces: [], tabs: [], openTabIds: [], activeTabId: null };
}

/**
 * 이 경로를 작업 경로로 쓰는 탭 전부. worktree 탭에서 분기하면 분기 탭도 같은 폴더를 쓰지만 worktree 정보는 없다 —
 * 하나만 찾으면(닫힌 원본을 먼저 만나면) 열린 분기 탭을 놓쳐 쓰는 중인 폴더를 지운다. 열린 탭을 앞에 둔다.
 */
export function tabsUsingPath(model: WorkspaceModel, path: string): TabMeta[] {
  const users = model.tabs.filter((t) => t.worktree?.path === path || t.cwd === path);
  return [...users.filter((t) => t.open !== false), ...users.filter((t) => t.open === false)];
}

/** untitled 는 이름 없는 탭에 보일 문구(`shared.untitledTab`) — 호출처가 번역한 값을 넘긴다. 제목이 "없는지"는 이 문구와 비교하지 말고 tab.title 로 판단한다. */
export function tabTitle(tab: TabMeta, untitled: string): string {
  return tab.title?.trim() || untitled;
}

export function workspaceOf(m: WorkspaceModel, tabId: string): Workspace | null {
  const tab = m.tabs.find((t) => t.id === tabId);
  return tab ? (m.workspaces.find((w) => w.id === tab.workspaceId) ?? null) : null;
}

export function activeWorkspace(m: WorkspaceModel): Workspace | null {
  if (m.activeTabId) return workspaceOf(m, m.activeTabId);
  // 열린 탭이 없으면 가장 최근에 쓴 워크스페이스.
  return [...m.workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null;
}


/** 같은 경로가 이미 있으면 그것을 돌려주고 lastUsedAt 만 갱신한다. */
export function addWorkspace(
  m: WorkspaceModel,
  path: string,
  now: number,
  id: string,
): { model: WorkspaceModel; workspace: Workspace } {
  const normalized = path.replace(/\/+$/, "");
  const existing = m.workspaces.find((w) => w.path === normalized);
  if (existing) {
    const workspace = { ...existing, lastUsedAt: now };
    return {
      model: { ...m, workspaces: m.workspaces.map((w) => (w.id === existing.id ? workspace : w)) },
      workspace,
    };
  }
  const workspace: Workspace = { id, path: normalized, name: baseName(normalized), addedAt: now, lastUsedAt: now };
  return { model: { ...m, workspaces: [...m.workspaces, workspace] }, workspace };
}

/** 이름만으로 워크스페이스를 만든다 (기본 경로 없음). 같은 이름이 있어도 별개. */
export function createWorkspace(
  m: WorkspaceModel,
  name: string,
  now: number,
  id: string,
  builtin?: Workspace["builtin"],
): { model: WorkspaceModel; workspace: Workspace } {
  const workspace: Workspace = { id, path: "", name: name.trim(), addedAt: now, lastUsedAt: now, ...(builtin ? { builtin } : {}) };
  return { model: { ...m, workspaces: [...m.workspaces, workspace] }, workspace };
}

export function updateWorkspace(m: WorkspaceModel, workspaceId: string, patch: Partial<Pick<Workspace, "name" | "path" | "verifyCommands" | "builtin">>): WorkspaceModel {
  if (!m.workspaces.some((w) => w.id === workspaceId)) return m;
  return {
    ...m,
    workspaces: m.workspaces.map((w) =>
      w.id === workspaceId
        ? {
            ...w,
            ...(patch.name !== undefined ? { name: patch.name.trim() || w.name } : {}),
            ...(patch.path !== undefined ? { path: patch.path.replace(/\/+$/, "") } : {}),
            ...(patch.verifyCommands !== undefined ? { verifyCommands: patch.verifyCommands.slice() } : {}),
            ...(patch.builtin !== undefined ? { builtin: patch.builtin } : {}),
          }
        : w,
    ),
  };
}

/** 탭의 실제 작업 경로: 탭에 정한 경로 → 워크스페이스 기본 경로 → 없음. */
export function tabCwd(m: WorkspaceModel, tab: TabMeta): string | null {
  if (tab.cwd) return tab.cwd;
  const ws = m.workspaces.find((w) => w.id === tab.workspaceId);
  return ws?.path || null;
}

/**
 * 새 탭이 이어받을 작업 경로. 같은 워크스페이스의 탭에서 만들면 그 탭의 경로를 쓴다.
 * 다른 워크스페이스에서 만들면(사이드바에서 A 의 + 를 B 탭을 보며 누른 경우) 활성 탭 경로는 남의 것이라 쓰지 않는다 —
 * 그 워크스페이스에 기본 경로가 있으면 그걸 따르게 비워 두고(undefined), 없으면 그 워크스페이스에서 가장 최근에 쓴
 * 탭의 경로를 쓴다. worktree 격리 탭의 경로는 임시 사본이라 건너뛴다.
 */
export function inheritedCwd(m: WorkspaceModel, workspaceId: string, activeTabId: string | null): string | undefined {
  const active = activeTabId ? m.tabs.find((t) => t.id === activeTabId) : undefined;
  if (active && active.workspaceId === workspaceId) return tabCwd(m, active) ?? undefined;
  const ws = m.workspaces.find((w) => w.id === workspaceId);
  if (ws?.path) return undefined;
  const recent = m.tabs
    .filter((t) => t.workspaceId === workspaceId && t.cwd && !t.worktree)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return recent?.cwd ?? undefined;
}

/** 워크스페이스와 그 탭을 모두 제거한다. 제거된 탭 id 를 함께 돌려줘 스레드 파일을 지울 수 있게 한다. */
export function removeWorkspace(
  m: WorkspaceModel,
  workspaceId: string,
): { model: WorkspaceModel; removedTabIds: string[] } {
  const removedTabIds = m.tabs.filter((t) => t.workspaceId === workspaceId).map((t) => t.id);
  const removed = new Set(removedTabIds);
  const openTabIds = m.openTabIds.filter((id) => !removed.has(id));
  const activeTabId =
    m.activeTabId && removed.has(m.activeTabId) ? (openTabIds[0] ?? null) : m.activeTabId;
  return {
    model: {
      ...m,
      workspaces: m.workspaces.filter((w) => w.id !== workspaceId),
      tabs: m.tabs.filter((t) => !removed.has(t.id)),
      openTabIds,
      activeTabId,
    },
    removedTabIds,
  };
}

export function createTab(
  m: WorkspaceModel,
  workspaceId: string,
  now: number,
  id: string,
  defaults: { provider?: Provider; model?: string; policy?: PermissionPolicy; cwd?: string } = {},
): { model: WorkspaceModel; tab: TabMeta } {
  const tab: TabMeta = {
    id,
    workspaceId,
    title: null,
    provider: defaults.provider ?? "claude",
    ...(defaults.model ? { model: defaults.model } : {}),
    ...(defaults.cwd ? { cwd: defaults.cwd } : {}),
    policy: defaults.policy ?? "ask",
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    open: true,
  };
  return {
    model: {
      ...m,
      workspaces: m.workspaces.map((w) => (w.id === workspaceId ? { ...w, lastUsedAt: now } : w)),
      tabs: pruneClosed([...m.tabs, tab]),
      openTabIds: [...m.openTabIds, id],
      activeTabId: id,
    },
    tab,
  };
}

/** 닫힌 탭은 최근 순으로 MAX_RECENT_TABS 개만 남긴다. */
function pruneClosed(tabs: TabMeta[]): TabMeta[] {
  const closed = tabs.filter((t) => !t.open).sort((a, b) => b.updatedAt - a.updatedAt);
  if (closed.length <= MAX_RECENT_TABS) return tabs;
  const drop = new Set(closed.slice(MAX_RECENT_TABS).map((t) => t.id));
  return tabs.filter((t) => !drop.has(t.id));
}

/** 탭을 닫는다. 활성 탭이었으면 오른쪽 이웃, 없으면 왼쪽 이웃을 활성화한다. */
export function closeTab(m: WorkspaceModel, tabId: string, now: number): WorkspaceModel {
  const idx = m.openTabIds.indexOf(tabId);
  if (idx === -1) return m;
  const openTabIds = m.openTabIds.filter((id) => id !== tabId);
  let activeTabId = m.activeTabId;
  if (activeTabId === tabId) activeTabId = openTabIds[idx] ?? openTabIds[idx - 1] ?? null;
  // 메시지를 한 번도 보내지 않은 탭(제목·세션 없음)은 다시 열 내용이 없으므로 "최근" 에 남기지 않고 버린다.
  const tab = m.tabs.find((t) => t.id === tabId);
  const discard = tab !== undefined && tab.title === null && tab.sessionId === null;
  return {
    ...m,
    tabs: discard
      ? m.tabs.filter((t) => t.id !== tabId)
      : m.tabs.map((t) => (t.id === tabId ? { ...t, open: false, updatedAt: now } : t)),
    openTabIds,
    activeTabId,
  };
}

/** 탭을 모델에서 완전히 지운다 ("최근" 에서도 사라짐). 열려 있었으면 closeTab 처럼 이웃 탭을 활성화. */
export function deleteTab(m: WorkspaceModel, tabId: string, now: number): WorkspaceModel {
  if (!m.tabs.some((t) => t.id === tabId)) return m;
  const closed = m.openTabIds.includes(tabId) ? closeTab(m, tabId, now) : m;
  return { ...closed, tabs: closed.tabs.filter((t) => t.id !== tabId) };
}

/** 닫혀 있는데 메시지도 세션도 없는 탭을 버린다 (이전 버전이 남긴 빈 "새 세션" 정리). 변화 없으면 같은 객체. */
export function pruneEmptyClosedTabs(m: WorkspaceModel): WorkspaceModel {
  const keep = m.tabs.filter((t) => t.open || t.title !== null || t.sessionId !== null);
  return keep.length === m.tabs.length ? m : { ...m, tabs: keep };
}

export function reopenTab(m: WorkspaceModel, tabId: string, now: number): WorkspaceModel {
  const tab = m.tabs.find((t) => t.id === tabId);
  if (!tab) return m;
  if (tab.open) return { ...m, activeTabId: tabId };
  return {
    ...m,
    tabs: m.tabs.map((t) => (t.id === tabId ? { ...t, open: true, updatedAt: now } : t)),
    openTabIds: [...m.openTabIds, tabId],
    activeTabId: tabId,
  };
}

export function activateTab(m: WorkspaceModel, tabId: string): WorkspaceModel {
  if (!m.openTabIds.includes(tabId)) return m;
  return { ...m, activeTabId: tabId };
}

export function updateTab(
  m: WorkspaceModel,
  tabId: string,
  patch: Partial<Omit<TabMeta, "id" | "workspaceId" | "createdAt">>,
  now: number,
): WorkspaceModel {
  if (!m.tabs.some((t) => t.id === tabId)) return m;
  return {
    ...m,
    tabs: m.tabs.map((t) => (t.id === tabId ? { ...t, ...patch, updatedAt: now } : t)),
  };
}

/**
 * 사이드바에서 끌어 옮긴 워크스페이스 순서. 낡은 요청이 와도 목록을 잃지 않게,
 * 모르는 id 는 무시하고 빠진 것은 뒤에 붙인다(reorderTabs 와 같은 규칙).
 */
export function reorderWorkspaces(m: WorkspaceModel, workspaceIds: string[]): WorkspaceModel {
  const rest = new Map(m.workspaces.map((w) => [w.id, w]));
  const next: Workspace[] = [];
  for (const id of workspaceIds) {
    const w = rest.get(id);
    if (w) {
      next.push(w);
      rest.delete(id);
    }
  }
  for (const w of m.workspaces) if (rest.has(w.id)) next.push(w);
  return { ...m, workspaces: next };
}

export function reorderTabs(m: WorkspaceModel, openTabIds: string[]): WorkspaceModel {
  const current = new Set(m.openTabIds);
  const next = openTabIds.filter((id) => current.has(id));
  // 누락된 탭은 뒤에 붙인다 — 재정렬 요청이 낡았어도 탭을 잃지 않게.
  for (const id of m.openTabIds) if (!next.includes(id)) next.push(id);
  return { ...m, openTabIds: next };
}

/** ⌘1~9: n 번째 열린 탭. */
export function nthOpenTab(m: WorkspaceModel, n: number): string | null {
  return m.openTabIds[n - 1] ?? null;
}

/** 첫 사용자 메시지에서 제목을 만든다. 한 줄, 60자. */
export function titleFromMessage(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

// ===== 사이드바 "최근" 그룹 =====

export type RecentGroup = "today" | "yesterday" | "week" | "older";

export function recentGroup(ts: number, now: number): RecentGroup {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dayStart = start.getTime();
  if (ts >= dayStart) return "today";
  if (ts >= dayStart - 86_400_000) return "yesterday";
  if (ts >= dayStart - 6 * 86_400_000) return "week";
  return "older";
}

export interface RecentEntry {
  tab: TabMeta;
  workspace: Workspace | null;
  group: RecentGroup;
}

/** updatedAt 내림차순, 워크스페이스 정보와 날짜 그룹을 붙여서. */
export function recentTabs(m: WorkspaceModel, now: number, limit = 30): RecentEntry[] {
  return [...m.tabs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((tab) => ({
      tab,
      workspace: m.workspaces.find((w) => w.id === tab.workspaceId) ?? null,
      group: recentGroup(tab.updatedAt, now),
    }));
}

/** 사이드바 워크스페이스 트리용: 열린 탭은 탭바 순서대로 먼저, 닫힌 탭은 최근 순으로 뒤에. */
export function workspaceTabs(m: WorkspaceModel, workspaceId: string): TabMeta[] {
  const open = m.openTabIds
    .map((id) => m.tabs.find((t) => t.id === id))
    .filter((t): t is TabMeta => t !== undefined && t.workspaceId === workspaceId);
  const closed = m.tabs
    .filter((t) => t.workspaceId === workspaceId && !t.open)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return [...open, ...closed];
}

/** 탭 상태 배지 우선순위 — 여러 탭이 있을 때 사이드바/독 배지에 쓸 대표 상태. */
export function worstStatus(statuses: SessionStatus[]): SessionStatus {
  const order: SessionStatus[] = ["waiting_permission", "error", "running", "queued", "idle"];
  for (const s of order) if (statuses.includes(s)) return s;
  return "idle";
}
