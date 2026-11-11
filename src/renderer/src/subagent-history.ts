import { createContext } from 'react';

export interface SubagentHistoryTarget { tabId: string; agentId?: string; blockId?: string }
export const SubagentHistoryContext = createContext<{ tabId: string; provider: string } | null>(null);
const OPEN = 'sudal:subagent-history';
export function openSubagentHistory(target: SubagentHistoryTarget) {
  window.dispatchEvent(new CustomEvent<SubagentHistoryTarget>(OPEN, { detail: target }));
}
export function onSubagentHistory(listener: (target: SubagentHistoryTarget) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<SubagentHistoryTarget>).detail);
  window.addEventListener(OPEN, handler);
  return () => window.removeEventListener(OPEN, handler);
}
