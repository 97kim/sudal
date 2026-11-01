import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationFeedbackStore } from "./verification-feedback-store";
import type { VerificationFeedback } from "@shared/verification-feedback";

test("escaped outputs remain restorable without modifying live feedback", () => {
  const store = new VerificationFeedbackStore(mkdtempSync(join(tmpdir(), "sudal-feedback-store-")));
  const state: VerificationFeedback = { id: "job", tabId: "tab", cwd: "project", commands: ["node check.cjs"], phase: "failed", attempt: 1, maxAttempts: 2, updatedAt: 1, startedAt: 1, reason: null,
    verification: { type: "verify", ts: 1, cwd: "project", head: null, runId: "run", status: "failed", commands: [{ cmd: "node check.cjs", status: "failed", exitCode: 1, output: "\x1b".repeat(12000) }] } };
  state.failure = structuredClone(state.verification);
  store.save(state);
  const restored = store.load("tab");
  assert.ok(restored);
  assert.equal(restored.phase, "failed");
  assert.equal(restored.verification?.commands[0].truncated, true);
  assert.equal(state.verification?.commands[0].output?.length, 12000);
});
