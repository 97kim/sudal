// 검색 결과 → 특정 블록으로 이동. App 이 예약(set)하고, 그 탭의 MessageList 가 마운트·재생되며 소비(take)한다.
// window 이벤트 대신 예약 방식인 이유: 닫힌 세션은 ChatView 가 새로 마운트되고 이벤트 재생이 끝나야 블록이 생기기 때문.
let pending: { tabId: string; blockId: string } | null = null;
const listeners = new Set<() => void>();

export function requestReveal(tabId: string, blockId: string): void {
  pending = { tabId, blockId };
  for (const l of listeners) l();
}

export function pendingReveal(tabId: string): string | null {
  return pending && pending.tabId === tabId ? pending.blockId : null;
}

/** Cancel only this tab's navigation when another pane may still be seeking a block. */
export function clearReveal(tabId?: string): void {
  if (tabId === undefined || pending?.tabId === tabId) pending = null;
}

export function onReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
