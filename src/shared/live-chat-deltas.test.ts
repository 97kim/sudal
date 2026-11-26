import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveTextDeltas, type LiveTextBatch, type LiveTextDelta } from "./live-chat-deltas";
import { initialHistoryState, reduceHistoryEvent, reduceLiveTextBatch } from "./session-history";

const delta = (blockId: string, text: string, ts = 1): LiveTextDelta => ({ type: "text_delta", blockId, text, ts });

test("coalesces only adjacent updates of one block and preserves state and generated IDs", () => {
  const inputs = [delta("a", "Hello", 1), delta("a", " world", 2), delta("b", "other", 3), delta("a", "!", 4)];
  const notice = { type: "notice", level: "notice", message: "done", ts: 5 } as const;
  const batches: LiveTextBatch[] = [];
  const queue = new LiveTextDeltas(batch => batches.push(batch));
  for (const input of inputs) queue.push(input);
  queue.flush(); // live boundary before the notice reaches the reducer
  assert.deepEqual(batches.map(b => b.count), [2, 1, 1]);
  const original = reduceHistoryEvent(inputs.reduce(reduceHistoryEvent, initialHistoryState()), notice);
  const buffered = reduceHistoryEvent(batches.reduce(reduceLiveTextBatch, initialHistoryState()), notice);
  assert.deepEqual(buffered, original);
});

test("limits queued bursts, emits large deltas alone, and cancels on tab disposal", () => {
  const batches: LiveTextBatch[] = [];
  const queue = new LiveTextDeltas(batch => batches.push(batch));
  for (let i = 0; i < 66; i++) queue.push(delta("a", "x"));
  assert.deepEqual(batches.map(b => b.count), [64]);
  queue.push(delta("a", "x".repeat(65_537)));
  assert.deepEqual(batches.map(b => b.count), [64, 2, 1]);
  queue.push(delta("a", "discarded"));
  queue.clear();
  queue.flush();
  assert.equal(batches.length, 3);
});
