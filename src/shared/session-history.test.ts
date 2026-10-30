import { test } from "node:test";
import assert from "node:assert/strict";
import { historyPage, prependHistory, replayHistory, initialHistoryState, mergeHistoryPage, reduceHistoryEvent } from "./session-history";
import { initialSessionState, replaySession, type Block } from "./session-state";
import { ZERO_USAGE, type ChatEvent } from "./chat-events";

test("history pages keep metadata and use stable block cursors while new messages arrive", () => {
  const blocks: Block[] = Array.from({ length: 551 }, (_, i) => ({ kind: "text", id: `b${i}`, text: `message ${i}`, streaming: false }));
  const state = { ...initialSessionState(), blocks, status: "running" as const };
  const tail = historyPage(state);
  assert.equal(tail.state.blocks.length, 200);
  assert.equal(tail.before, "b351");
  assert.equal(tail.state.status, "running");
  const appended = { ...state, blocks: [...blocks, { ...blocks[0], id: "new" }] };
  const older = historyPage(appended, tail.before!);
  assert.equal(older.before, "b151");
  assert.deepEqual(older.state.blocks.map((b) => b.id), blocks.slice(151, 351).map((b) => b.id));
  const first = historyPage(state, older.before!);
  assert.equal(first.hasMore, false);
  assert.equal(first.state.blocks.length, 151);
  assert.deepEqual(prependHistory(first.state.blocks, prependHistory(older.state.blocks, tail.state.blocks)), blocks);
});

test("overlapping old pages preserve the latest live block contents", () => {
  const old: Block = { kind: "text", id: "one", text: "old", streaming: true };
  const latest = { ...old, text: "new", streaming: false };
  assert.deepEqual(prependHistory([old], [latest]), [latest]);
});

test("streamed history matches full replay on every page, including late revisions and totals", () => {
  const events: ChatEvent[] = [];
  for (let i = 0; i < 240; i++) {
    events.push({ type: "user_message", ts: i * 10, id: `u${i}`, text: `user ${i}`, images: [{ dataUrl: "data:image/png;base64,abc" }] });
    events.push({ type: "text_delta", ts: i * 10 + 1, blockId: `a${i}`, text: "first " });
    events.push({ type: "text_delta", ts: i * 10 + 2, blockId: `a${i}`, text: `answer ${i}` });
    events.push({ type: "tool_use", ts: i * 10 + 3, toolUseId: `t${i}`, name: "Bash", input: { command: `echo ${i}` } });
    events.push({ type: "tool_result", ts: i * 10 + 4, toolUseId: `t${i}`, output: `output ${i}`, isError: false });
    events.push({ type: "turn_result", ts: i * 10 + 5, usage: { ...ZERO_USAGE, input: i }, modelUsage: {}, costUsd: 1, durationMs: 1, numTurns: 1, isError: false });
    if (i % 20 === 0) events.push({ type: "error", ts: i * 10 + 6, fatal: false, message: `notice ${i}` });
  }
  events.push({ type: "tool_result", ts: 5000, toolUseId: "t155", output: "late update", isError: true });
  const full = replaySession(events);
  let before: string | undefined;
  for (;;) {
    const page = replayHistory((function* () { yield* events; })(), before);
    assert.deepEqual(page, historyPage(full, before));
    if (!page.hasMore) break;
    before = page.before!;
  }
});

test("history pages bound large bodies without losing oversized messages or older history", () => {
  const events: ChatEvent[] = Array.from({ length: 90 }, (_, i) => ({ type: "assistant_text", ts: i, blockId: `a${i}`, text: `${i}:` + "x".repeat(i === 45 ? 3_000_000 : 100_000) }));
  const full = replaySession(events);
  let before: string | undefined;
  let blocks: Block[] = [];
  let pages = 0;
  for (;;) {
    const page = replayHistory(events, before);
    assert.ok(page.state.blocks.length > 0);
    blocks = prependHistory(page.state.blocks, blocks);
    pages++;
    if (!page.hasMore) break;
    before = page.before!;
  }
  assert.ok(pages > 3, "body budget splits history before the count limit");
  assert.deepEqual(blocks, full.blocks);
});

test("late results stay in the unloaded prefix and recover the tool's name, input and position", () => {
  const events: ChatEvent[] = [{ type: "tool_use", ts: 1, toolUseId: "background", name: "Bash", input: { command: "long-running-command" } }];
  for (let i = 0; i < 220; i++) events.push({ type: "user_message", ts: i + 2, id: `u${i}`, text: `message ${i}` });
  const page = replayHistory(events);
  const result: ChatEvent = { type: "tool_result", ts: 300, toolUseId: "background", output: "finished", isError: false };
  let current = mergeHistoryPage(initialHistoryState(), page, false, []);
  current = reduceHistoryEvent(current, result);
  assert.equal(current.state.blocks.length, 200, "an unloaded update must not append an unknown card");
  assert.equal(current.prefix[0].kind === "tool" && current.prefix[0].result?.output, "", "old output bodies are not cached");
  const older = replayHistory([...events, result], page.before!);
  current = mergeHistoryPage(current, older, true, []);
  assert.deepEqual(current.state, replaySession([...events, result]));
  assert.equal(current.prefix.length, 0);
});

test("updates during older-page loading are replayed on the hydrated card without double counting live events", () => {
  const events: ChatEvent[] = [{ type: "tool_use", ts: 1, toolUseId: "background", name: "Bash", input: { command: "sleep" } }];
  for (let i = 0; i < 220; i++) events.push({ type: "user_message", ts: i + 2, id: `u${i}`, text: `message ${i}` });
  const latest = replayHistory(events);
  let current = mergeHistoryPage(initialHistoryState(), latest, false, []);
  const pendingPage = replayHistory(events, latest.before!);
  const pushes: ChatEvent[] = [
    { type: "tool_result", ts: 300, toolUseId: "background", output: "late result", isError: false },
    { type: "text_delta", ts: 301, blockId: "live", text: "new response" },
    { type: "turn_result", ts: 302, usage: ZERO_USAGE, modelUsage: {}, costUsd: 1, durationMs: 1, numTurns: 1, isError: false },
  ];
  for (const event of pushes) current = reduceHistoryEvent(current, event);
  current = mergeHistoryPage(current, pendingPage, true, pushes);
  assert.deepEqual(current.state, replaySession([...events, ...pushes]));
});
