// 사이드바 세션 여러 개 고르기. 파인더·탐색기와 같은 규칙: ⌘(Ctrl)+클릭은 하나를 넣고 빼고, Shift+클릭은 기준점부터 범위.

export interface TabSelection {
  ids: ReadonlySet<string>;
  /** Shift+클릭 범위의 시작. 마지막으로 ⌘(Ctrl)+클릭하거나 그냥 연 탭. */
  anchor: string | null;
}

export const EMPTY_SELECTION: TabSelection = { ids: new Set(), anchor: null };

/** ⌘(Ctrl)+클릭: 넣거나 뺀다. 처음 고를 때는 지금 보고 있던 탭(current)도 함께 넣는다 — 그 탭이 눈에 고른 것처럼 보여서다. */
export function toggleSelection(sel: TabSelection, id: string, current: string | null): TabSelection {
  const ids = new Set(sel.ids);
  if (ids.size === 0 && current && current !== id) ids.add(current);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift+클릭: 기준점부터 id 까지 화면 순서(order)대로 고른다. 기준점이 없거나 목록에 없으면(접혔거나 지워짐)
 * 지금 보고 있던 탭을 기준으로, 그것도 없으면 id 하나만. 기준점은 그대로 둔다 — 다시 Shift+클릭하면 범위를 바꾼다.
 */
export function rangeSelection(sel: TabSelection, id: string, order: readonly string[], current: string | null): TabSelection {
  const from = [sel.anchor, current].find((x): x is string => !!x && order.includes(x));
  const to = order.indexOf(id);
  if (!from || to < 0) return { ids: new Set([id]), anchor: id };
  const a = order.indexOf(from);
  const [lo, hi] = a <= to ? [a, to] : [to, a];
  return { ids: new Set(order.slice(lo, hi + 1)), anchor: from };
}

/** 지워졌거나 안 보이게 된 탭은 선택에서 뺀다. */
export function pruneSelection(sel: TabSelection, order: readonly string[]): TabSelection {
  const ids = [...sel.ids].filter((x) => order.includes(x));
  if (ids.length === sel.ids.size) return sel;
  return { ids: new Set(ids), anchor: sel.anchor && order.includes(sel.anchor) ? sel.anchor : null };
}
