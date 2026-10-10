// 터미널 패널의 배치 규칙 — 어느 터미널이 첫 칸(active)이고 어느 것이 나뉜 둘째 칸(split)인가.
// 불변식: 한 터미널이 두 자리에 있을 수 없고, 나뉜 상태에서는 두 칸 모두 살아 있는 터미널을 가리킨다.
// 채팅 탭을 오가면 패널이 다시 마운트되므로 배치는 kv 에 탭별로 저장해 두고 살아 있는 터미널 목록에 맞춰 되살린다.

import { kvGet, kvKeys, kvSet } from "./kv-store";

export type SplitDir = "row" | "col";

export interface PaneLayout {
  active: string | null;
  split: { dir: SplitDir; id: string } | null;
}

export interface SavedLayout extends PaneLayout {
  height: number;
  ratio: number;
}

/** 탭 막대에서 터미널을 고른다. 둘째 칸의 터미널을 고르면 분할을 풀고 그것을 한 화면으로 — 첫 칸이 비어 버리지 않게. */
export function selectPane(l: PaneLayout, id: string): PaneLayout {
  if (l.split?.id === id) return { active: id, split: null };
  return { ...l, active: id };
}

/** 터미널 하나를 닫은 뒤의 배치. ids 는 닫기 전 탭 순서. 나뉜 한쪽이 닫히면 남은 쪽이 한 화면을 차지한다. */
export function removePane(l: PaneLayout, ids: string[], id: string): PaneLayout {
  const rest = ids.filter((x) => x !== id);
  const last = rest[rest.length - 1] ?? null;
  if (l.split && (l.split.id === id || l.active === id)) {
    const remain = l.split.id === id ? l.active : l.split.id;
    return { active: remain && rest.includes(remain) ? remain : last, split: null };
  }
  if (l.active === id) return { ...l, active: last };
  return l;
}

const LAYOUT_PREFIX = "terminal.layout.";
const OPEN_PREFIX = "terminal.open.";
const DOCK_KEY = "terminal.dock";
const WIDTH_KEY = "terminal.width";
export const TERMINAL_DOCK_EVENT = "sudal:terminal-dock";

/** 터미널 패널 자리 — 채팅 아래(기본) 또는 오른쪽. 탭마다가 아니라 앱 전체에서 하나. */
export type TerminalDock = "bottom" | "right";

export function loadTerminalDock(): TerminalDock {
  return kvGet(DOCK_KEY) === "right" ? "right" : "bottom";
}

/** 저장하고 알린다 — 분할 화면의 다른 칸도 같은 자리로 따라온다. */
export function saveTerminalDock(dock: TerminalDock): void {
  kvSet(DOCK_KEY, dock === "right" ? "right" : null);
  window.dispatchEvent(new Event(TERMINAL_DOCK_EVENT));
}

export const TERMINAL_MIN_WIDTH = 280;
const DEFAULT_WIDTH = 520;

/** 오른쪽에 둘 때의 폭. 창이 좁으면 격자가 알아서 줄이므로 여기선 아래쪽만 자른다. */
export function loadTerminalWidth(): number {
  const w = Number(kvGet(WIDTH_KEY));
  return Number.isFinite(w) && w > 0 ? Math.max(TERMINAL_MIN_WIDTH, Math.round(w)) : DEFAULT_WIDTH;
}

export function saveTerminalWidth(width: number): void {
  kvSet(WIDTH_KEY, String(Math.round(width)));
}

export function loadTerminalOpen(tabId: string): boolean {
  return kvGet(OPEN_PREFIX + tabId) === "1";
}

export function saveTerminalOpen(tabId: string, open: boolean): void {
  kvSet(OPEN_PREFIX + tabId, open ? "1" : null);
}

export function saveTerminalLayout(tabId: string, l: SavedLayout): void {
  kvSet(LAYOUT_PREFIX + tabId, JSON.stringify(l));
}

/**
 * 저장해 둔 배치를 지금 살아 있는 터미널 목록(live)에 맞춘다. 없는 터미널을 가리키면 그 부분만 버린다.
 * 높이·비율은 화면 밖으로 나가지 않게 범위를 자른다.
 */
export function loadTerminalLayout(
  tabId: string,
  live: string[],
  fallback: { active: string | null; height: number },
  bounds: { minHeight: number; maxHeight: number },
): SavedLayout {
  const out: SavedLayout = { active: fallback.active, split: null, height: fallback.height, ratio: 50 };
  const raw = kvGet(LAYOUT_PREFIX + tabId);
  if (!raw) return out;
  let saved: Partial<SavedLayout>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    saved = parsed as Partial<SavedLayout>;
  } catch {
    return out;
  }
  if (typeof saved.height === "number" && Number.isFinite(saved.height))
    out.height = Math.min(bounds.maxHeight, Math.max(bounds.minHeight, Math.round(saved.height)));
  if (typeof saved.ratio === "number" && Number.isFinite(saved.ratio)) out.ratio = Math.min(85, Math.max(15, saved.ratio));
  if (typeof saved.active === "string" && live.includes(saved.active)) out.active = saved.active;
  const s = saved.split;
  if (
    s &&
    typeof s === "object" &&
    (s.dir === "row" || s.dir === "col") &&
    typeof s.id === "string" &&
    live.includes(s.id) &&
    s.id !== out.active &&
    out.active !== null
  )
    out.split = { dir: s.dir, id: s.id };
  return out;
}

/** 닫힌 채팅 탭의 항목을 치운다(입력창 초안과 같은 시점에). */
export function pruneTerminalState(liveTabIds: Set<string>): void {
  for (const prefix of [LAYOUT_PREFIX, OPEN_PREFIX])
    for (const k of kvKeys(prefix)) if (!liveTabIds.has(k.slice(prefix.length))) kvSet(k, null);
}

// "터미널에서 이어가기" 를 막 눌렀다: CLI 탭이 생기면 그것을 고른다. 패널이 그 사이 내려갔다(다른 채팅 탭) 다시 떠도
// 남아 있도록 화면 밖(모듈)에 둔다. 그 밖의 복원에서는 사용자가 고른 탭을 그대로 둔다.
const cliFocus = new Set<string>();
export function requestCliFocus(tabId: string): void {
  cliFocus.add(tabId);
}
export function takeCliFocus(tabId: string): boolean {
  return cliFocus.delete(tabId);
}
