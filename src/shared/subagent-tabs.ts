import type { WorkspaceStateDto } from './ipc';
import type { TabMeta } from './workspace-model';

export interface SubagentTabRef { parentTabId: string; agentId: string; title: string }
export interface SubagentTabsState { tabs: SubagentTabRef[]; activeId: string | null }
export const isSubagentTabId = (id: string) => id.startsWith('subagent-view:');
export const subagentTabId = (ref: Pick<SubagentTabRef, 'parentTabId' | 'agentId'>) => `subagent-view:${encodeURIComponent(ref.parentTabId)}:${encodeURIComponent(ref.agentId)}`;

export function openSubagentTab(state: SubagentTabsState, ref: SubagentTabRef): SubagentTabsState {
  const id = subagentTabId(ref);
  return { tabs: state.tabs.some(tab => subagentTabId(tab) === id) ? state.tabs.map(tab => subagentTabId(tab) === id ? ref : tab) : [...state.tabs, ref], activeId: id };
}

/** View metadata belongs to the renderer; provider sessions and persisted workspace tabs stay untouched. */
export function subagentTabWorkspace(source: WorkspaceStateDto, state: SubagentTabsState): WorkspaceStateDto {
  const viewers: TabMeta[] = [];
  const byParent = new Map<string, string[]>();
  for (const ref of state.tabs) {
    const parent = source.model.tabs.find(tab => tab.id === ref.parentTabId);
    if (!parent) continue;
    const row = source.agents?.[parent.id]?.find(row => row.id === ref.agentId);
    const id = subagentTabId(ref);
    viewers.push({ id, workspaceId:parent.workspaceId, title:`↳ ${row?.title || ref.title}`, provider:row?.provider ?? parent.provider,
      policy:'ask', sessionId:null, createdAt:parent.createdAt, updatedAt:parent.updatedAt, open:true });
    byParent.set(parent.id, [...(byParent.get(parent.id) ?? []), id]);
  }
  const openTabIds = source.model.openTabIds.flatMap(id => [id, ...(byParent.get(id) ?? [])]);
  for (const viewer of viewers) if (!openTabIds.includes(viewer.id)) openTabIds.push(viewer.id);
  return { ...source, model:{...source.model, tabs:[...source.model.tabs,...viewers], openTabIds,
    activeTabId:viewers.some(tab=>tab.id===state.activeId) ? state.activeId : source.model.activeTabId} };
}

export function parseSubagentTabs(raw: string | null): SubagentTabsState {
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<SubagentTabsState>;
    const tabs: SubagentTabRef[] = [];
    if (Array.isArray(value.tabs)) for (const tab of value.tabs.slice(0,100)) {
      if (!tab || typeof tab.parentTabId !== 'string' || typeof tab.agentId !== 'string' || typeof tab.title !== 'string') continue;
      const ref = {parentTabId:tab.parentTabId, agentId:tab.agentId, title:tab.title.slice(0,160)};
      if (!tabs.some(tab=>subagentTabId(tab)===subagentTabId(ref))) tabs.push(ref);
    }
    return {tabs,activeId:typeof value.activeId==='string' && tabs.some(tab=>subagentTabId(tab)===value.activeId) ? value.activeId : null};
  } catch { return {tabs:[],activeId:null}; }
}
