import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceApi, WorkspaceStateDto } from '@shared/ipc';
import { isSubagentTabId, openSubagentTab, parseSubagentTabs, subagentTabId, subagentTabWorkspace } from '@shared/subagent-tabs';
import { kvGet, kvSet } from '../kv-store';
import { onSubagentHistory, type SubagentHistoryTarget } from '../subagent-history';

const KEY = 'subagentTabs.v1';
export function useSubagentTabs(source: WorkspaceStateDto, onOpen: () => void, onUnavailable: () => void) {
  const { t } = useTranslation();
  const [state, setState] = useState(() => parseSubagentTabs(kvGet(KEY)));
  const latest = useRef({source,state,onOpen,onUnavailable,t});
  latest.current = {source,state,onOpen,onUnavailable,t};
  const hydrated = useRef(false);
  if (source.model.tabs.length || source.model.workspaces.length) hydrated.current = true;
  useEffect(() => {
    if (!hydrated.current) return;
    setState(old => {
      const tabs = old.tabs.filter(ref=>source.model.tabs.some(tab=>tab.id===ref.parentTabId));
      return tabs.length===old.tabs.length ? old : {tabs,activeId:tabs.some(ref=>subagentTabId(ref)===old.activeId) ? old.activeId : null};
    });
  }, [source.model.tabs]);
  useEffect(() => { kvSet(KEY, state.tabs.length ? JSON.stringify(state) : null); }, [state]);
  const open = useCallback((target: SubagentHistoryTarget) => {
    const {source,t,onOpen,onUnavailable} = latest.current;
    const rows = (source.agents?.[target.tabId] ?? []).filter(row=>row.kind==='internal' && (row.provider==='claude'||row.provider==='codex') && (target.agentId ? row.id===target.agentId : row.blockId===target.blockId));
    if (!source.model.tabs.some(tab=>tab.id===target.tabId)) return;
    if (!rows.length) { onUnavailable(); return; }
    setState(old => {
      let next = old;
      // Multiple children from a single call get independent tabs. Focus the first.
      for (const row of rows) next = openSubagentTab(next,{parentTabId:target.tabId,agentId:row.id,title:row.title || t('nav.subagentHistory.title')});
      return rows.length ? {...next,activeId:subagentTabId({parentTabId:target.tabId,agentId:rows[0].id})} : old;
    });
    if (rows.length) onOpen();
  }, []);
  useEffect(() => onSubagentHistory(open), [open]);
  const native = window.sudal.workspaces;
  const activateTab = useCallback(async (id: string) => {
    if (isSubagentTabId(id)) {
      setState(old => old.tabs.some(tab=>subagentTabId(tab)===id) ? {...old,activeId:id} : old);
    } else {
      setState(old => old.activeId ? {...old,activeId:null} : old);
      await native.activateTab(id);
    }
  }, [native]);
  const closeTab = useCallback(async (id: string) => {
    if (!isSubagentTabId(id)) { await native.closeTab(id); return; }
    const {source,state} = latest.current;
    const closing = state.tabs.find(tab=>subagentTabId(tab)===id);
    const ids = subagentTabWorkspace(source,state).model.openTabIds;
    const index = ids.indexOf(id);
    const neighbor = closing && source.model.openTabIds.includes(closing.parentTabId) ? closing.parentTabId : ids[index+1] ?? ids[index-1];
    setState(old => ({ tabs:old.tabs.filter(tab=>subagentTabId(tab)!==id), activeId:old.activeId===id ? null : old.activeId }));
    if (state.activeId===id && neighbor) await activateTab(neighbor);
  }, [native,activateTab]);
  const api = useMemo<WorkspaceApi>(() => ({
    ...native, activateTab, closeTab,
    async reopenTab(id) { if (isSubagentTabId(id)) await activateTab(id); else {setState(old=>({...old,activeId:null}));await native.reopenTab(id);} },
    setVisibleTabs(ids) { return native.setVisibleTabs(ids.filter(id=>!isSubagentTabId(id))); },
    reorderTabs(ids) { return native.reorderTabs(ids.filter(id=>!isSubagentTabId(id))); },
    async createTab(workspaceId) {
      const {source,state} = latest.current;
      const ref = state.tabs.find(tab=>subagentTabId(tab)===state.activeId);
      const parent = ref && source.model.tabs.find(tab=>tab.id===ref.parentTabId);
      setState(old=>({...old,activeId:null}));
      if (parent?.open) await native.activateTab(parent.id);
      return native.createTab(workspaceId ?? parent?.workspaceId);
    },
    async create(name) {setState(old=>({...old,activeId:null}));return native.create(name);},
  }), [native,activateTab,closeTab]);
  const ws = useMemo(()=>subagentTabWorkspace(source,state), [source,state]);
  return {ws,api,tabs:state.tabs};
}
