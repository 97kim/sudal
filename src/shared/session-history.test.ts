import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseCompactedHistory, createHistoryReplay, historyPage, prependHistory, replayHistory, initialHistoryState, mergeHistoryPage, reduceHistoryEvent } from "./session-history";
import { initialSessionState, replaySession, type Block } from "./session-state";
import { ZERO_USAGE, type ChatEvent } from "./chat-events";

test("compact boundaries hide old bodies, retain the explicit command, and allow later hydration", () => {
  const events: ChatEvent[] = [
    { type: "user_message", ts: 1, id: "old", text: "old body" },
    { type: "user_message", ts: 2, id: "command", text: "/compact" },
    { type: "compacted", ts: 3, trigger: "manual" },
    { type: "user_message", ts: 4, id: "new", text: "new body" },
  ];
  const replay = createHistoryReplay(undefined, undefined, false);
  events.forEach(replay.push);
  const page = replay.finish();
  assert.deepEqual(replayHistory(events), historyPage(replaySession(events)));
  assert.deepEqual(page.state.blocks.map(block => block.id).filter(id => id === "old"), []);
  assert.equal(page.prefix.length, 1);
  assert.equal(page.prefix[0].kind === "user" && page.prefix[0].text, "");
  assert.equal(page.hasMore, false);
  assert.equal(page.compactBoundary?.hiddenCount, 1);
  const live = events.reduce(reduceHistoryEvent, initialHistoryState());
  assert.equal(live.state.blocks.some(block => block.id === "old"), false);
  assert.equal(live.prefix[0].kind === "user" && live.prefix[0].text, "");
  const older = replayHistory(events, page.before!);
  const expanded = mergeHistoryPage(live, older, true, []);
  assert.equal(expanded.state.blocks.find(block => block.id === "old")?.kind, "user");
  const collapsed = collapseCompactedHistory(expanded);
  assert.deepEqual(collapsed.state.blocks, live.state.blocks);
});

test("compact focus arguments stay visible and survive a slim checkpoint", () => {
  const events: ChatEvent[] = [
    { type: "user_message", id: "old", ts: 1, text: "old body" },
    { type: "user_message", id: "command", ts: 2, text: "/compact 기능 변경 위주" },
    { type: "compacted", ts: 3, trigger: "manual" },
  ];
  const replay = createHistoryReplay(undefined, undefined, false);
  events.forEach(replay.push);
  const page = replay.finish();
  assert.equal(page.state.blocks[0].kind === "user" && page.state.blocks[0].text, "/compact 기능 변경 위주");
  assert.equal(page.prefix[0].kind === "user" && page.prefix[0].text, "");
  assert.equal(page.compactBoundary?.hiddenCount, 1);
});

test("recent pages stop at the newest compaction while archive pages can pass earlier boundaries", () => {
  const events: ChatEvent[] = [{ type: "user_message", ts: 1, id: "old", text: "old" }, { type: "compacted", ts: 2, trigger: "auto" }];
  for (let i = 0; i < 300; i++) events.push({ type: "user_message", ts: i + 3, id: `recent-${i}`, text: "recent" });
  const read = (before?: string, include = false) => { const replay = createHistoryReplay(before, undefined, include); events.forEach(replay.push); return replay.finish(); };
  const first = read(); assert.equal(first.state.blocks.length, 200); assert.equal(first.hasMore, true);
  const second = read(first.before!); assert.equal(second.state.blocks.length, 101); assert.equal(second.hasMore, false);
  const archive = read(second.before!, true); assert.equal(archive.state.blocks[0].id, "old");
});

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

test("off-page agent metadata drops large prompts and messages but keeps running status and restores full input on demand", () => {
  const large = "x".repeat(8 * 1024 * 1024);
  const input = { codexAgent: true, operation: "spawnAgent", description: large, prompt: large, agents: [{ id: "child", status: "running", message: large }] };
  const events: ChatEvent[] = [{ type: "tool_use", ts: 0, toolUseId: "agent", name: "Agent", input }];
  for (let i = 0; i < 220; i++) events.push({ type: "assistant_text", ts: i + 1, blockId: `a${i}`, text: "small" });
  events.push({ type: "turn_result", ts: 222, usage: ZERO_USAGE, modelUsage: {}, costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
  const latest = replayHistory(events);
  assert.ok(JSON.stringify(latest.prefix).length < 16 * 1024, "off-page bodies do not bypass the page byte budget");
  const agent = latest.prefix[0];
  assert.equal(agent.kind, "tool");
  if (agent.kind !== "tool") return;
  assert.deepEqual(agent.input, { codexAgent: true, agents: [{ id: "child", status: "running" }] });
  assert.equal(agent.result, undefined, "a running background agent survives the parent turn ending");
  let current = mergeHistoryPage(initialHistoryState(), latest, false, []);
  const update: ChatEvent = { type: "tool_use", ts: 223, toolUseId: "agent", name: "Agent", input: { ...input, agents: [{ id: "child", status: "completed", message: large }] } };
  current = reduceHistoryEvent(current, update);
  assert.ok(JSON.stringify(current.prefix).length < 16 * 1024, "live updates also discard off-page body data");
  let before = latest.before!;
  for (;;) {
    const page = replayHistory([...events, update], before);
    assert.ok(JSON.stringify(page.suffix).length < 128 * 1024, "newer context is also kept lightweight");
    current = mergeHistoryPage(current, page, true, []);
    if (!page.hasMore) break;
    before = page.before!;
  }
  assert.deepEqual(current.state.blocks, replaySession([...events, update]).blocks);
});

test("older-page replay routes explicit and nested subagent activity to its snapshot target only", () => {
  const agentInput = { codexAgent: true, operation: "spawnAgent", description: "background", agents: [{ id: "child", status: "running" }] };
  const events: ChatEvent[] = [];
  for (let i = 0; i < 450; i++) events.push(i === 100 || i === 400
    ? { type: "tool_use", ts: i, toolUseId: `agent-${i}`, name: "Agent", input: agentInput }
    : { type: "assistant_text", ts: i, blockId: `text-${i}`, text: "message" });
  const latest = replayHistory(events);
  const older = replayHistory(events, latest.before!);
  for (const parentToolUseId of ["agent-400", "nested-child", "agent-100"]) {
    let current = mergeHistoryPage(initialHistoryState(), latest, false, []);
    const activity: ChatEvent = { type: "subagent_activity", ts: 500, parentToolUseId, tool: "Bash", input: { command: "echo activity" } };
    current = reduceHistoryEvent(current, activity);
    current = mergeHistoryPage(current, older, true, [activity]);
    const expected = replaySession([...events, activity]);
    assert.deepEqual(current.state.blocks, expected.blocks.slice(50), `activity from ${parentToolUseId} stays on its actual target`);
    const intendedId = parentToolUseId === "agent-100" ? "agent-100" : "agent-400";
    for (const block of current.state.blocks) if (block.kind === "tool") assert.equal(block.subagent?.toolCalls, block.id === intendedId ? 1 : undefined);
  }
});
