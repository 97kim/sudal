import { setImmediate as yieldToMain } from "node:timers/promises";
import type { ChatEvent } from "@shared/chat-events";
import { initialSessionState, reduceSession, type Block, type SessionState } from "@shared/session-state";

// A reducer event can update its named card and finalize open tools or streaming
// text. Finished cards keep their original positions for late ID-based updates.
function targetKey(event: ChatEvent, state: SessionState): string | undefined {
  switch (event.type) {
    case "assistant_text":
    case "text_delta": return "text:" + event.blockId;
    case "tool_use":
    case "permission_request":
    case "tool_review":
    case "tool_result": return "tool:" + event.toolUseId;
    case "subagent_activity": return "tool:" + event.parentToolUseId;
    case "permission_resolved": {
      const wait = state.permissionWaits.find(w => w.requestId === event.requestId);
      return wait && "tool:" + wait.toolUseId;
    }
    case "review": return "review:" + event.reviewTabId;
    case "verify": return "verify:" + event.runId;
    case "fanout": return "fanout:" + event.fanoutId;
    case "orchestration": return "orchestration:" + event.runId;
    case "notice": return "notice:notice-" + (event.key || event.ts + "-" + state.eventCount);
    case "agent_status":
    case "user_message":
    case "thinking_delta":
    case "session":
    case "status":
    case "error":
    case "session_reset":
    case "turn_result":
    case "compacted": return undefined;
    default: return event satisfies never;
  }
}

export async function readControlBlocks(events: Iterable<ChatEvent>, signal?: AbortSignal): Promise<Block[]> {
  const blocks: Block[] = [];
  const byKey = new Map<string, number>();
  const active = new Set<number>();
  let state = initialSessionState();
  let deadline = performance.now() + 8;
  let batch = 0;
  signal?.throwIfAborted();
  for (const event of events) {
    const key = targetKey(event, state);
    const target = key === undefined ? undefined : byKey.get(key);
    const indices = [...active];
    if (target !== undefined && !active.has(target)) indices.push(target);
    // Nested subagent activity falls back to the most recent unfinished agent.
    if (indices.length > 1) indices.sort((a, b) => a - b);
    const previous = indices.map(i => blocks[i]);
    // CLI responses expose result status and user text, never raw tool output or images.
    const input = event.type === "tool_result" ? { ...event, output: "" }
      : event.type === "user_message" && event.images ? { ...event, images: undefined } : event;
    state = reduceSession({ ...state, blocks: previous }, input);
    for (let i = 0; i < state.blocks.length; i++) {
      const block = state.blocks[i];
      if (block === previous[i]) continue;
      const index = indices[i] ?? blocks.length;
      if (index === blocks.length) byKey.set(block.kind + ":" + block.id, index);
      blocks[index] = block;
      if ((block.kind === "tool" && !block.result) || (block.kind === "text" && block.streaming)) active.add(index);
      else active.delete(index);
    }
    if (++batch >= 1024 || performance.now() >= deadline) {
      await yieldToMain();
      signal?.throwIfAborted();
      batch = 0;
      deadline = performance.now() + 8;
    }
  }
  return blocks;
}
