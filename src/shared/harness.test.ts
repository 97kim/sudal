import { test } from "node:test";
import assert from "node:assert/strict";
import { completeHarnessTask, harnessCriterionStatus, latestCompletedHarnessTask, type HarnessTask } from "./harness";

const fixture = (): HarnessTask => ({ id: "task", project: "project", tabId: "tab", goal: "Preserve requests", status: "active",
  criteria: [{ id: "history", description: "Survives restart", method: "Integration test", revision: 1 }], evidence: [] });

test("the most recently completed task wins even when an older task is resumed", () => {
  const older = fixture(), newer = { ...fixture(), id: "newer" };
  const first = completeHarnessTask(older, undefined, "manual", 100);
  const second = completeHarnessTask(newer, undefined, "manual", 200);
  assert.equal(latestCompletedHarnessTask([first, second], "tab")?.id, newer.id);
  const resumed = completeHarnessTask({ ...first, status: "active" }, undefined, "checked again", 300);
  assert.equal(latestCompletedHarnessTask([resumed, second], "tab")?.id, older.id);
  assert.equal(latestCompletedHarnessTask([{ ...resumed, tabId: "other" }, second], "tab")?.id, newer.id);
  assert.equal(latestCompletedHarnessTask([{ ...older, status: "completed" }, { ...newer, status: "completed" }], "tab")?.id, newer.id);
});

test("completion preserves unverified criteria and requires an explicit reason", () => {
  const task = fixture();
  assert.throws(() => completeHarnessTask(task, "code", " "));
  const completed = completeHarnessTask(task, "code", "Manual test deferred");
  assert.equal(completed.status, "completed");
  assert.equal(harnessCriterionStatus(completed, completed.criteria[0], "code"), "unconfirmed");
  assert.equal(task.status, "active");
});

test("agent reports and reviews do not silently pass criteria", () => {
  for (const source of ["agent", "review"] as const) {
    const task = fixture();
    task.evidence.push({ id: "report", criterionId: "history", criterionRevision: 1, source, result: "passed", reference: "message", timestamp: 1 });
    assert.equal(harnessCriterionStatus(task, task.criteria[0]), "unconfirmed");
  }
});

test("code and criterion changes invalidate old proof without deleting it", () => {
  const task = fixture();
  task.evidence.push({ id: "run", criterionId: "history", criterionRevision: 1, source: "command", result: "passed", reference: "run-id", timestamp: 1, codeRevision: "before" });
  assert.equal(harnessCriterionStatus(task, task.criteria[0], "before"), "passed");
  assert.equal(harnessCriterionStatus(task, task.criteria[0], "after"), "stale");
  assert.equal(harnessCriterionStatus(task, task.criteria[0]), "stale");
  assert.equal(harnessCriterionStatus(task, { ...task.criteria[0], revision: 2 }, "before"), "stale");
  assert.equal(task.evidence.length, 1);
});
