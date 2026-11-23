import { test } from "node:test";
import assert from "node:assert/strict";
import { ZERO_USAGE } from "@shared/chat-events";
import { CodexPredictions } from "./codex-prediction";

test("canceling a stalled prediction frees the slot without letting its result affect a new tab", async () => {
  const predictions = new CodexPredictions();
  for (const tabId of ["a", "b"]) {
    predictions.observe(tabId, { type: "user_message", ts: 1, id: "u", text: "a question" });
    predictions.observe(tabId, { type: "assistant_text", ts: 2, blockId: "a", text: "an answer" });
    predictions.observe(tabId, {
      type: "turn_result", ts: 3, isError: false, usage: ZERO_USAGE, costUsd: 0, durationMs: 5, numTurns: 1, modelUsage: {},
      forkPoint: { provider: "codex", sessionId: "session-" + tabId, pointId: "turn-" + tabId },
    });
  }
  let releaseFirst!: (value: string) => void;
  let canceled = false;
  const first = predictions.request("a", "turn-a", "session-a", (_context, signal) => {
    signal.addEventListener("abort", () => { canceled = true; }, { once: true });
    return new Promise(resolve => { releaseFirst = resolve; });
  });

  predictions.cancelExcept("b");
  assert.equal(canceled, true);
  assert.equal(await predictions.request("b", "turn-b", "old-session", async () => { throw Error("stale session"); }), null);
  let releaseSecond!: (value: string) => void;
  const second = predictions.request("b", "turn-b", "session-b", () => new Promise(resolve => { releaseSecond = resolve; }));
  releaseFirst("stale");
  assert.equal(await first, null);
  releaseSecond("current");
  assert.equal(await second, "current");
});
