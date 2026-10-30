import { initialSessionState, reduceSession, type SessionState, type Block } from "./session-state";
import type { ChatEvent } from "./chat-events";
import { readCodexAgentInput } from "./codex-agents";

export const HISTORY_PAGE_SIZE = 200;
export const HISTORY_PAGE_BYTES = 4 * 1024 * 1024;

export interface SessionHistoryPage {
  state: SessionState;
  /** Lightweight identities/state for older blocks, never rendered as messages. */
  prefix: Block[];
  /** Newer block state keeps replay targets accurate when an older page is fetched. */
  suffix: Block[];
  /** ID of the first block; request blocks before it to load older history. */
  before: string | null;
  hasMore: boolean;
  sequence?: number;
}

export function historyPage(state: SessionState, before?: string, size = HISTORY_PAGE_SIZE): SessionHistoryPage {
  const found = before ? state.blocks.findIndex((b) => b.id === before) : -1;
  const end = found < 0 ? state.blocks.length : found;
  const start = Math.max(0, end - Math.max(1, Math.min(HISTORY_PAGE_SIZE, Math.floor(size) || HISTORY_PAGE_SIZE)));
  const blocks = state.blocks.slice(start, end);
  return { state: { ...state, blocks }, prefix: state.blocks.slice(0, start).map(slimHistoryBlock), suffix: state.blocks.slice(end).map(slimHistoryBlock), before: blocks[0]?.id ?? null, hasMore: start > 0 };
}

export interface HistoryState { state: SessionState; prefix: Block[] }

export function initialHistoryState(): HistoryState {
  return { state: initialSessionState(), prefix: [] };
}

/** Keep updates to unloaded cards at their original positions, without their bodies. */
export function reduceHistoryEvent(history: HistoryState, event: ChatEvent): HistoryState {
  const { state, prefix } = history;
  if (!prefix.length) return { state: reduceSession(state, event), prefix };
  const next = reduceSession({ ...state, blocks: [...prefix, ...state.blocks] }, event);
  return {
    state: { ...next, blocks: next.blocks.slice(prefix.length) },
    prefix: next.blocks.slice(0, prefix.length).map((block, index) => block === prefix[index] ? block : slimHistoryBlock(block)),
  };
}

/** Replay pushes after the page's snapshot before merging it with the live tail. */
export function mergeHistoryPage(current: HistoryState, page: SessionHistoryPage, older: boolean, events: ChatEvent[]): HistoryState {
  // The reducer can route nested activity to the last running Agent when its
  // explicit parent is absent. Include the snapshot's newer card identities so
  // a partial older page cannot redirect that activity to an unrelated card.
  let fetched: HistoryState = { state: { ...page.state, blocks: [...page.state.blocks, ...page.suffix] }, prefix: page.prefix };
  for (const event of events) fetched = reduceHistoryEvent(fetched, event);
  return older
    ? { state: { ...current.state, blocks: prependHistory(fetched.state.blocks.slice(0, page.state.blocks.length), current.state.blocks) }, prefix: fetched.prefix }
    : fetched;
}

/** Older pages may overlap live updates. Preserve the current version of a block. */
export function prependHistory(older: Block[], current: Block[]): Block[] {
  const seen = new Set(current.map((b) => `${b.kind}:${b.id}`));
  return [...older.filter((b) => !seen.has(`${b.kind}:${b.id}`)), ...current];
}

/** Replay from disk without retaining every event or off-page message body.
 * Lightweight old block identities preserve reducer semantics, stable generated
 * IDs, totals, and updates that arrive after a tool's original creation. */
export function replayHistory(events: Iterable<ChatEvent>, before?: string): SessionHistoryPage {
  const replay = createHistoryReplay(before);
  for (const event of events) replay.push(event);
  return replay.finish();
}

export function createHistoryReplay(before?: string) {
  let state = initialSessionState();
  let end: number | undefined;
  let start = 0;
  const slimmed = new WeakSet<Block>();
  const byteSizes = new WeakMap<Block, number>();
  const push = (event: ChatEvent) => {
    const next = reduceSession(state, event);
    if (next.blocks !== state.blocks) {
      if (end === undefined && before) {
        if (next.blocks.at(-1)?.id === before) end = next.blocks.length - 1;
      }
      const stop = end ?? next.blocks.length;
      start = Math.max(start, stop - HISTORY_PAGE_SIZE);
      let bytes = 0;
      for (let i = stop - 1; i >= start; i--) {
        const block = next.blocks[i];
        let size = byteSizes.get(block);
        if (size === undefined) { size = historyBlockBytes(block); byteSizes.set(block, size); }
        bytes += size;
        // A single large block stays readable; never silently drop its content.
        if (bytes > HISTORY_PAGE_BYTES && i < stop - 1) { start = i + 1; break; }
      }
      next.blocks = next.blocks.map((b, index) => {
        if ((index >= start && index < stop) || slimmed.has(b)) return b;
        const slim = slimHistoryBlock(b);
        slimmed.add(slim);
        return slim;
      });
    }
    state = next;
  };
  return { push, finish(): SessionHistoryPage {
    const stop = end ?? state.blocks.length;
    const blocks = state.blocks.slice(start, stop);
    return { state: { ...state, blocks }, prefix: state.blocks.slice(0, start), suffix: state.blocks.slice(stop), before: blocks[0]?.id ?? null, hasMore: start > 0 };
  } };
}

function historyBlockBytes(block: Block): number {
  let bytes = 0;
  const pending: unknown[] = [block];
  while (pending.length && bytes <= HISTORY_PAGE_BYTES) {
    const value = pending.pop();
    if (typeof value === "string") bytes += value.length * 2;
    else if (value && typeof value === "object") {
      bytes += 32;
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return bytes;
}

function slimHistoryBlock(b: Block): Block {
  switch (b.kind) {
    case "user": return { ...b, text: "", images: undefined };
    case "text": return { ...b, text: "" };
    case "tool": {
      const agent = readCodexAgentInput(b.input);
      // Only agent status is needed by finalizeRunningTools. Prompts, summaries
      // and agent messages can be large and belong to the body loaded on demand.
      const input = agent ? { codexAgent: true, agents: agent.agents.map(({ id, status }) => ({ id, status })) } : {};
      return { ...b, input, result: b.result ? { ...b.result, output: "" } : undefined, subagent: undefined };
    }
    case "review": return { ...b, text: "", scope: undefined };
    case "verify": return { ...b, commands: b.commands.map((c) => ({ ...c, output: "" })) };
    case "fanout": return { ...b, prompt: "", variants: b.variants.map((v) => ({ ...v, summary: undefined })) };
    case "orchestration": return { ...b, objective: "", tasks: [] };
    case "error": return { ...b, message: "" };
    case "notice": return { ...b, message: "" };
    default: return b;
  }
}
