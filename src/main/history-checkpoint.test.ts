import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./persistence";
import { SessionManager } from "./session-manager";
import { replaySession } from "@shared/session-state";
import type { ChatEvent } from "@shared/chat-events";

function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-compact-cache-")); return { dir, store: new Store(dir) }; }
function manager(store: Store) { return new SessionManager({ store, emit() {}, claudeRuntime: async () => { throw Error("unused"); }, codexRuntime: async () => { throw Error("unused"); } }); }

test("reopening compacted history reads only the tail and loads original bodies on demand", async () => {
  const { dir, store } = fixture();
  const events: ChatEvent[] = Array.from({ length: 450 }, (_, i) => ({ type: "user_message", id: `u${i}`, ts: i, text: `original ${i}:` + "x".repeat(30000) }));
  events.push({ type: "user_message", ts: 500, id: "command", text: "/compact" }, { type: "compacted", ts: 501, trigger: "manual" });
  for (const event of events) store.appendEvent("tab", event);
  const indexed = await store.historyCheckpoint("tab"); assert.ok(indexed);
  assert.equal(indexed.loadedStart, 450, "a short compacted tail never points into slim history");
  const offset = indexed.offset;
  const next: ChatEvent = { type: "user_message", ts: 502, id: "recent", text: "recent question" };
  store.appendEvent("tab", next); store.flush();
  class CountedStore extends Store {
    offsets: number[] = []; count = 0;
    override *iterateEvents(id: string, from = 0) { this.offsets.push(from); for (const event of super.iterateEvents(id, from)) { this.count++; yield event; } }
  }
  const reopened = new CountedStore(dir), sessions = manager(reopened);
  const page = await sessions.history("tab");
  assert.equal(reopened.offsets.every(value => value === offset), true);
  assert.equal(reopened.count, 2, "restoration and display each read only one post-compact event");
  assert.deepEqual(page.state.blocks.filter(block => block.kind === "user").map(block => block.text), ["/compact", "recent question"]);
  assert.equal(page.hasMore, false);
  assert.equal(page.compactBoundary?.hiddenCount, 450);
  assert.equal(page.prefix.every(block => block.kind !== "user" || block.text === ""), true);
  const older = await sessions.history("tab", page.before!, true);
  assert.equal(older.state.blocks.some(block => block.kind === "user" && block.text.startsWith("original")), true);
  const all = await sessions.history("tab", undefined, true);
  assert.equal(all.state.blocks.some(block => block.kind === "user" && block.text.startsWith("original")), true);
  assert.equal(all.hasMore, true);
  assert.deepEqual(page.state.totals, replaySession([...events, next]).totals);
  sessions.shutdown();
});

test("corrupt checkpoints and externally rewritten logs rebuild from the JSONL source", async () => {
  const { dir, store } = fixture();
  store.appendEvent("tab", { type: "user_message", ts: 1, id: "first", text: "first" });
  store.appendEvent("tab", { type: "compacted", ts: 2, trigger: "auto" });
  await store.historyCheckpoint("tab");
  fs.writeFileSync(store.threadPath("tab") + ".compact-state.json", '{"broken":true}');
  const rebuilt = await new Store(dir).historyCheckpoint("tab"); assert.ok(rebuilt?.state.blocks.some(block => block.kind === "compacted"));
  fs.writeFileSync(store.threadPath("tab"), JSON.stringify({ type: "user_message", ts: 3, id: "replacement", text: "replacement" }) + "\n");
  const sessions = manager(new Store(dir));
  assert.deepEqual((await sessions.history("tab")).state.blocks.map(block => block.id), ["replacement"]);
  sessions.shutdown();
});

test("rebuilt compact caches retain the recent tail and resume at EOF", async () => {
  const { store } = fixture();
  store.appendEvent("tab", { type: "user_message", id: "old", ts: 1, text: "original" });
  store.appendEvent("tab", { type: "user_message", id: "command", ts: 2, text: "/compact 要点" });
  store.appendEvent("tab", { type: "compacted", ts: 3, trigger: "manual" });
  for (let i = 0; i < 350; i++) store.appendEvent("tab", { type: "user_message", id: `tail-${i}`, ts: i + 4, text: `tail body ${i}` });
  const checkpoint = await store.historyCheckpoint("tab");
  assert.ok(checkpoint);
  assert.equal(checkpoint.offset, fs.statSync(store.threadPath("tab")).size);
  const sessions = manager(store);
  const page = await sessions.history("tab");
  assert.equal(page.state.blocks.length, 200);
  assert.equal(page.state.blocks[0].kind === "user" && page.state.blocks[0].text, "tail body 150");
  assert.equal(page.hasMore, true);
  sessions.shutdown();
});

test("cached restoration retains pending verification output and clears stale runs", async () => {
  const { dir, store } = fixture();
  store.appendEvent("tab", { type: "verify", ts: 1, runId: "check", cwd: dir, head: null, status: "running", commands: [{ cmd: "check", status: "running", output: "original diagnostic" }] });
  store.appendEvent("tab", { type: "compacted", ts: 2, trigger: "auto" });
  await store.historyCheckpoint("tab");
  const reopened = new Store(dir), sessions = manager(reopened);
  await sessions.history("tab");
  const result = reopened.readEvents("tab").findLast(event => event.type === "verify");
  assert.equal(result?.type === "verify" && result.status, "aborted");
  assert.equal(result?.type === "verify" && result.commands[0].output, "original diagnostic");
  sessions.shutdown();
});

test("a trailing record is replayed from its line boundary rather than cached halfway through", async () => {
  for (const trailing of ['{"type":"user_message","id":"tail","ts":2,"text":"tail"}', '{"type":']) {
    const { dir, store } = fixture();
    store.appendEvent("tab", { type: "user_message", ts: 1, id: "first", text: "first" }); store.flush();
    fs.appendFileSync(store.threadPath("tab"), trailing);
    const before = manager(new Store(dir));
    assert.deepEqual(JSON.parse(JSON.stringify((await before.history("tab")).state.blocks)), JSON.parse(JSON.stringify(replaySession(store.readEvents("tab")).blocks)));
    before.shutdown();
    const writer = new Store(dir);
    writer.appendEvent("tab", { type: "user_message", ts: 3, id: "next", text: "next" }); writer.flush();
    const after = manager(writer);
    assert.deepEqual(JSON.parse(JSON.stringify((await after.history("tab")).state.blocks)), JSON.parse(JSON.stringify(replaySession(writer.readEvents("tab")).blocks)));
    after.shutdown();
  }
});

test("clear during checkpoint construction cannot resurrect the old cache", async () => {
  const { store } = fixture();
  for (let i = 0; i < 1000; i++) store.appendEvent("tab", { type: "user_message", id: `u${i}`, text: "old", ts: i });
  store.appendEvent("tab", { type: "compacted", ts: 1001, trigger: "manual" });
  const pending = store.historyCheckpoint("tab");
  store.resetThread("tab");
  assert.equal(await pending, null);
  assert.equal(await store.historyCheckpoint("tab"), null);
  assert.equal(fs.existsSync(store.threadPath("tab") + ".compact-meta.json"), false);
});
