import { useTranslation } from 'react-i18next';
import type { WorkspaceStateDto } from '@shared/ipc';
import { agentStatus, orderedSessionAgents, type SessionAgent } from '@shared/session-agents';
import type { TabMeta } from '@shared/workspace-model';
import type { ReactNode } from 'react';
import { ProviderLogo } from './ProviderLogo';
import { requestReveal } from '../reveal';
import { openSubagentHistory } from '../subagent-history';

export function SessionAgentList({ tabId, rows, ws, parents, onOpen, renderTab }: {
  rows: SessionAgent[];
  tabId: string; ws: WorkspaceStateDto; parents: Map<string,string>; onOpen: (id:string)=>void;
  renderTab: (tab: TabMeta, agent: SessionAgent) => ReactNode;
}) {
  const { t } = useTranslation();
  return <ul className="ml-4 border-l border-line pl-2" aria-label={t('nav.sidebar.agents')}>
    {orderedSessionAgents(rows, ws.model).map(row => {
      const child = row.tabId ? ws.model.tabs.find(tab => tab.id === row.tabId) : undefined;
      if (child && parents.get(child.id) === tabId) return <li key={row.id} data-session-agent={row.id}>{renderTab(child, row)}</li>;
      const live = child?.open ? ws.statuses[child.id] : undefined;
      const status = live && ['running','queued','waiting_permission','error'].includes(live) ? (live === 'error' ? 'failed' : agentStatus(live)) : row.status;
      const title = row.title || t(`nav.sidebar.agentKind.${row.kind}`);
      return <li key={row.id}>
        <button type="button" data-session-agent={row.id}
          onClick={() => { if (child) onOpen(child.id); else if (row.kind === 'internal' && (row.provider === 'codex' || row.provider === 'claude')) openSubagentHistory({ tabId, agentId: row.id }); else { if (row.blockId) requestReveal(tabId, row.blockId); onOpen(tabId); } }}
          title={`${title} · ${t(`nav.sidebar.agentStatus.${status}`)}`}
          className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-panel-2/60 focus-visible:outline focus-visible:outline-accent ${child?.id === ws.model.activeTabId ? 'bg-panel-2 text-fg' : 'text-muted'}`}>
          <ProviderLogo provider={row.provider} size={12}/>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className={`shrink-0 text-[10px] ${status === 'failed' ? 'text-err' : status === 'waiting' ? 'text-warn' : status === 'running' ? 'text-accent' : 'text-muted-2'}`}>{t(`nav.sidebar.agentStatus.${status}`)}</span>
        </button>
      </li>;
    })}
  </ul>;
}
