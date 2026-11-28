import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "@shared/chat-events";
import { replaySession } from "@shared/session-state";
import { readControlBlocks } from "./control-history";

test("CLI history preserves late card updates, open agent order and generated IDs", async () => {
  const events: ChatEvent[] = [
    { type: "notice", ts: 0, message: "before", level: "notice" },
    { type: "tool_use", ts: 1, toolUseId: "a", name: "Agent", input: {} },
    { type: "tool_use", ts: 2, toolUseId: "b", name: "Agent", input: {} },
    { type: "tool_result", ts: 3, toolUseId: "a", isError: false, output: "" },
    { type: "tool_use", ts: 4, toolUseId: "a", name: "Agent", input: { codexAgent: true, agents: [{ id: "child", status: "running" }] } },
    { type: "subagent_activity", ts: 5, parentToolUseId: "nested", tool: "Bash" },
    { type: "text_delta", ts: 6, blockId: "b", text: "start" },
    { type: "user_message", ts: 7, id: "b", text: "next" },
    { type: "text_delta", ts: 8, blockId: "b", text: " more" },
    { type: "notice", ts: 9, key: "0-0", message: "after", level: "notice" },
    { type: "error", ts: 10, message: "stop" },
  ];
  for (let i = 1; i <= events.length; i++) {
    const prefix = events.slice(0, i);
    assert.deepEqual(await readControlBlocks(prefix), replaySession(prefix).blocks);
  }
});

test("a long CLI history read lets the main loop service another request", async () => {
  let serviced = false;
  const timer = setImmediate(() => { serviced = true; });
  function* history(): Generator<ChatEvent> {
    for (let i = 0; i < 40_000; i++)
      yield { type: "assistant_text", blockId: String(i), ts: i, text: String(i) };
  }
  try {
    const blocks = await readControlBlocks(history());
    assert.equal(serviced, true);
    assert.equal(blocks.length, 40_000);
    assert.equal(blocks.at(-1)?.id, "39999");
  } finally {
    clearImmediate(timer);
  }
});

test("cancelled CLI replay closes the event iterator at its next yield", async () => {
  const abort = new AbortController();
  let closed = false;
  function* source(): Generator<ChatEvent> {
    try {
      for (;;) yield { type: "notice", key: "one", ts: 1, level: "notice", message: "one" };
    } finally { closed = true; }
  }
  const result = readControlBlocks(source(), abort.signal);
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(closed, true);
});
