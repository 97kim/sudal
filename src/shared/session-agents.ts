import type { ChatEvent } from './chat-events';
import type { Provider } from './ipc';
import { readCodexAgentInput } from './codex-agents';
import type { TabMeta, WorkspaceModel } from './workspace-model';
import { STALE_NOTE, STALE_NOTE_KEY } from './stale-runs';

export type AgentStatus = 'running' | 'waiting' | 'done' | 'failed' | 'unknown';
export interface SessionAgent {
  id: string;
  provider: Provider;
  title: string;
  status: AgentStatus;
  blockId: string;
  tabId?: string;
  backgroundId?: string;
  background?: boolean;
  kind: 'internal' | 'review' | 'fanout' | 'worker';
}
/** Preserve internal call order and use the existing tab order for child sessions. */
export function orderedSessionAgents(rows: SessionAgent[], model: WorkspaceModel): SessionAgent[] {
  const tabs = new Map(model.tabs.map(tab => [tab.id, tab]));
  const order = new Map(model.openTabIds.map((id, i) => [id, i]));
  return [...rows].sort((a,b) => {
    const left = a.tabId ? tabs.get(a.tabId) : undefined;
    const right = b.tabId ? tabs.get(b.tabId) : undefined;
    if (!left || !right) return Number(!!left) - Number(!!right);
    const li = order.get(left.id), ri = order.get(right.id);
    if (li !== undefined || ri !== undefined) return (li ?? Infinity) - (ri ?? Infinity);
    return right.updatedAt - left.updatedAt;
  });
}
/** Only hide a child when its parent exists in the same workspace; reject cycles. */
export function agentParents(tabs: TabMeta[], agents: Record<string, SessionAgent[]>): Map<string, string> {
  const parents = new Map<string, string>();
  const byId = new Map(tabs.map(t => [t.id, t]));
  for (const parent of tabs) for (const row of agents[parent.id] ?? []) {
    const child = row.tabId && byId.get(row.tabId);
    if (!child || child.workspaceId !== parent.workspaceId || parents.has(child.id)) continue;
    let ancestor: string | undefined = parent.id;
    while (ancestor && ancestor !== child.id) ancestor = parents.get(ancestor);
    if (!ancestor) parents.set(child.id, parent.id);
  }
  return parents;
}
const short = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 160) : '';
export function agentStatus(s: string): AgentStatus {
  if (['running', 'pendingInit', 'started', 'active'].includes(s)) return 'running';
  if (['waiting', 'waiting_permission', 'waiting_reply', 'limit_wait', 'blocked', 'queued', 'pending'].includes(s)) return 'waiting';
  if (['done', 'completed', 'succeeded', 'cleaned'].includes(s)) return 'done';
  if (['failed', 'error', 'errored', 'interrupted', 'notFound', 'abandoned', 'shutdown'].includes(s)) return 'failed';
  return 'unknown';
}

/** Keep only agent summaries; never retain prompts, tool outputs or chat text. */
export function reduceSessionAgents(rows: SessionAgent[], e: ChatEvent, provider: Provider): SessionAgent[] {
  const put = (row: SessionAgent) => {
    const i = rows.findIndex(a => a.id === row.id);
    if (i >= 0 && JSON.stringify(rows[i]) === JSON.stringify(row)) return;
    rows = i < 0 ? [...rows, row] : rows.map((a, n) => n === i ? row : a);
  };
  if (e.type === 'review') put({id: `tab:${e.reviewTabId}`, tabId:e.reviewTabId, blockId:e.reviewTabId, provider:e.reviewer, title:short(e.scope), status:e.status === 'requested' ? 'running' : e.status, kind:'review'});
  if (e.type === 'agent_status') {
    const matches = rows.filter(a => a.backgroundId === e.agentId || (!!e.toolUseId && a.id === `tool:${e.toolUseId}`));
    const old = matches.find(a => a.id === `tool:${e.toolUseId}`) ?? matches[0];
    const id = e.toolUseId ? `tool:${e.toolUseId}` : old?.id ?? `background:${e.agentId}`;
    // A snapshot may arrive before task_started supplies the launch tool ID.
    // Once that link is known, both provisional identities become a single row.
    rows = rows.filter(a => !matches.includes(a) || a.id === id);
    put({ ...old, id, blockId:e.toolUseId ?? old?.blockId ?? '', backgroundId:e.background === false ? undefined : e.agentId, background:e.background !== false, provider:e.provider, title:short(e.title) || old?.title || '', status:e.status, kind:'internal' });
  }
  if (e.type === 'fanout') for (const v of e.variants) put({id:`tab:${v.tabId}`, tabId:v.tabId, blockId:e.fanoutId, provider:v.provider, title:short(e.prompt), status:agentStatus(v.status), kind:'fanout'});
  if (e.type === 'orchestration') for (const task of e.tasks) {
    if (task.tabId && task.provider) put({id:`tab:${task.tabId}`, tabId:task.tabId, blockId:e.runId, provider:task.provider, title:short(task.spec), status:agentStatus(['succeeded','failed','abandoned'].includes(task.status) ? task.status : task.execution ?? task.status), kind:'worker'});
  }
  if (e.type === 'tool_use' && !e.partial && !e.preview) {
    const codex = readCodexAgentInput(e.input);
    if (codex) for (const a of codex.agents) put({id:`codex:${a.id}`, blockId:e.toolUseId, provider:'codex', title:short(codex.description), status:agentStatus(a.status), kind:'internal'});
    else if (/^(Agent|Task|spawn_agent|delegate_to_agent)$/i.test(e.name)) {
      const input = e.input && typeof e.input === 'object' ? e.input as Record<string, unknown> : {};
      const old = rows.find(a => a.id === `tool:${e.toolUseId}`);
      put({...old, id:`tool:${e.toolUseId}`, blockId:e.toolUseId, provider, title:short(input.description || input.prompt || input.task || input.subagent_type), status:old?.status ?? 'running', background:old?.background || input.run_in_background === true, kind:'internal'});
    }
  }
  if (e.type === 'tool_result') {
    const old = rows.find(a => a.id === `tool:${e.toolUseId}`);
    if (old && !old.backgroundId) put({...old, status:e.outputMsg?.key === STALE_NOTE_KEY || e.output === STALE_NOTE ? 'unknown' : e.isError ? 'failed' : old.background ? 'unknown' : 'done'});
  }
  if (e.type === 'subagent_activity' && !rows.some(a => a.blockId === e.parentToolUseId)) put({id:`tool:${e.parentToolUseId}`, blockId:e.parentToolUseId, provider:e.via === 'codex' ? 'codex' : provider, title:'', status:'running', kind:'internal'});
  const lostProcess = e.type === 'error' && e.fatal !== false || e.type === 'status' && e.status === 'error';
  const interrupted = e.type === 'error' && e.msg?.key === 'session.msg.interrupted';
  if (lostProcess || interrupted || e.type === 'turn_result' && e.isError) {
    rows = rows.map(a => a.kind === 'internal' && (a.status === 'running' || a.status === 'waiting') && (lostProcess || !a.background) ? {...a, status:'unknown'} : a);
  }
  return rows;
}
