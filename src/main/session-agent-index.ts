import type { ChatEvent } from '@shared/chat-events';
import type { Provider } from '@shared/ipc';
import { reduceSessionAgents, type SessionAgent } from '@shared/session-agents';
import { readCodexAgentInput } from '@shared/codex-agents';

export interface AgentIndexSnapshot {
  version: 1;
  rows: SessionAgent[];
  provider: Provider;
  outcome?: 'done' | 'failed';
}
export interface AgentIndexStorage {
  load(id: string): AgentIndexSnapshot | null;
  save(id: string, snapshot: AgentIndexSnapshot): void;
}
/** Rebuild in small batches without retaining the conversation. Live updates win over replay. */
export class SessionAgentIndex {
  private rows = new Map<string, SessionAgent[]>();
  private pending = new Map<string, ChatEvent[]>();
  private epochs = new Map<string, number>();
  private outcomes = new Map<string, 'done' | 'failed'>();
  private providers = new Map<string, Provider>();
  private unrestored = new Set<string>();
  outcome(id: string) { return this.outcomes.get(id) ?? 'unknown'; }
  constructor(private changed: () => void, private storage?: AgentIndexStorage) {}
  prepare(ids: string[]) { for (const id of ids) this.unrestored.add(id); }
  persist(id: string) {
    if (this.unrestored.has(id) || this.pending.has(id)) return;
    this.storage?.save(id, {version:1, rows:this.rows.get(id) ?? [], provider:this.providers.get(id) ?? 'claude', outcome:this.outcomes.get(id)});
  }
  snapshot(): Record<string, SessionAgent[]> { return Object.fromEntries(this.rows); }
  reset(id: string) {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.pending.delete(id);
    this.rows.delete(id);
    this.outcomes.delete(id);
    this.providers.delete(id);
    this.unrestored.delete(id);
    this.changed();
  }
  observe(id: string, e: ChatEvent, provider: Provider) {
    this.providers.set(id, e.type === 'session' && e.provider ? e.provider : provider);
    if (e.type === 'turn_result') { this.outcomes.set(id, e.isError ? 'failed' : 'done'); this.changed(); }
    if (!['error', 'status', 'turn_result', 'agent_status', 'tool_use', 'tool_result', 'subagent_activity', 'review', 'fanout', 'orchestration'].includes(e.type)) return;
    if (e.type === 'tool_use' && (e.partial || e.preview || (!readCodexAgentInput(e.input) && !/^(Agent|Task|spawn_agent|delegate_to_agent)$/i.test(e.name)))) return;
    const pending = this.pending.get(id);
    if (pending) {
      // Replay only needs lifecycle metadata, not large tool responses or review prose.
      if (e.type === 'tool_result') pending.push({...e, output:''});
      else if (e.type === 'review') pending.push({...e, text:''});
      else if (e.type === 'tool_use') {
        const codex = readCodexAgentInput(e.input);
        const input = e.input && typeof e.input === 'object' ? e.input as Record<string,unknown> : {};
        const text = (value: unknown) => typeof value === 'string' ? value.slice(0,160) : undefined;
        pending.push({...e, input:codex ? {...codex, agents:codex.agents.map(a=>({id:a.id,status:a.status}))} : {description:text(input.description), prompt:text(input.prompt), task:text(input.task), subagent_type:text(input.subagent_type), run_in_background:input.run_in_background === true}});
      } else if (e.type === 'error') pending.push({...e, message:''});
      else if (e.type === 'turn_result') pending.push({...e, modelUsage:{}});
      else pending.push(e);
    }
    const before = this.rows.get(id) ?? [];
    const after = reduceSessionAgents(before, e, provider);
    if (before !== after) { this.rows.set(id, after); this.changed(); }
  }
  async restore(id: string, events: () => Iterable<ChatEvent>, provider: Provider) {
    const epoch = this.epochs.get(id) ?? 0;
    this.pending.set(id, []);
    let rows: SessionAgent[] = [];
    let outcome: 'done' | 'failed' | undefined;
    try {
      const cached = this.storage?.load(id);
      if (cached) {
        rows = cached.rows;
        provider = cached.provider;
        outcome = cached.outcome;
      }
      let n = 0;
      for (const e of cached ? [] : events()) {
        if ((this.epochs.get(id) ?? 0) !== epoch) return;
        if (e.type === 'session' && e.provider) provider = e.provider;
        if (e.type === 'turn_result') outcome = e.isError ? 'failed' : 'done';
        rows = reduceSessionAgents(rows, e, provider);
        if (++n % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
      if ((this.epochs.get(id) ?? 0) !== epoch) return;
      for (const e of this.pending.get(id) ?? []) rows = reduceSessionAgents(rows, e, provider);
      // A persisted running status is not evidence that a process survived restart.
      const live = this.rows.get(id) ?? [];
      rows = rows.map(a => live.find(b => b.id === a.id) ?? (a.status === 'running' || a.status === 'waiting' ? {...a, status:'unknown' as const} : a));
      this.rows.set(id, rows);
      if (!this.providers.has(id)) this.providers.set(id, provider);
      if (outcome && !this.outcomes.has(id)) this.outcomes.set(id, outcome);
      this.unrestored.delete(id);
      this.changed();
    } finally {
      if ((this.epochs.get(id) ?? 0) === epoch) { this.pending.delete(id); this.persist(id); }
    }
  }
}
