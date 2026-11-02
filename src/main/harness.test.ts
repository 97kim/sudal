import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessService } from "./harness";
import { harnessCriterionStatus } from "@shared/harness";
import type { VerifyEvent } from "@shared/chat-events";
import { verificationRevision } from "./verification-revision";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sudal-harness-test-")), cwd = join(root, "project"), store = join(root, "store");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + store, ...args], { cwd, windowsHide: true, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(cwd, "value.txt"), "initial"); git("add", "."); git("commit", "-qm", "fixture");
  return { cwd, store, service: new HarnessService(store) };
}
const start = { type: "start" as const, goal: "Preserve history", criteria: [{ description: "History survives restart", method: "Integration test" }] };

test("archived conversation confirmation keeps its original time and cannot overwrite current failure", async () => {
  const { cwd, store, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0], criterion = task.criteria[0];
  const action = { type: "confirm" as const, taskId: task.id, criterionId: criterion.id, criterionRevision: 1, note: "checked old code", confirmationBlockId: "source", afterBlockId: "current-message" };
  const original = { type: "user_message" as const, id: "u", ts: 10, text: action.note };
  await assert.rejects(service.mutate(cwd, "tab", action), /Invalid confirmation source/);
  writeFileSync(join(cwd, "value.txt"), "new code");
  const codeRevision = await verificationRevision(cwd);
  await service.mutate(cwd, "tab", { type: "linkVerification", taskId: task.id, runId: "failure", criteria: [{ id: criterion.id, revision: 1 }] }, { type: "verify", runId: "failure", ts: 20, status: "failed", cwd, head: null, codeRevision, commands: [{ cmd: "check", status: "failed", exitCode: 1 }] });
  let state = await service.mutate(cwd, "tab", action, undefined, original);
  const archived = state.tasks[0].evidence.at(-1)!;
  assert.equal(archived.timestamp, 10); assert.equal(archived.result, "unconfirmed"); assert.equal(archived.codeRevision, undefined);
  assert.equal(archived.afterBlockId, "current-message"); assert.ok(archived.recordedAt! > 20);
  assert.equal(harnessCriterionStatus(state.tasks[0], criterion, state.revision), "failed");
  assert.equal(harnessCriterionStatus({ ...state.tasks[0], evidence: state.tasks[0].evidence.map(item => item.confirmationBlockId ? { ...item, timestamp: 20 } : item) }, criterion, state.revision), "failed", "equal timestamps must not let an archived quote mask a real failure");
  await service.mutate(cwd, "tab", action, undefined, original);
  state = await new HarnessService(store).snapshot(cwd, "tab");
  assert.equal(state.tasks[0].evidence.length, 2); assert.equal(state.tasks[0].evidence[1].confirmationBlockId, "source");
  state = await service.mutate(cwd, "tab", { type: "confirm", taskId: task.id, criterionId: criterion.id, criterionRevision: 1, note: "checked current code now" });
  assert.equal(harnessCriterionStatus(state.tasks[0], criterion, state.revision), "passed");
});

test("existing verification linking validates its source, target revisions, ownership and duplicates", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  const action = { type: "linkVerification" as const, taskId: task.id, runId: "run", criteria: task.criteria.map(({ id, revision }) => ({ id, revision })) };
  const result: VerifyEvent = { type: "verify", ts: Date.now(), runId: "run", status: "passed", cwd, head: null, codeRevision: await verificationRevision(cwd), commands: [{ cmd: "check", status: "passed", exitCode: 0 }] };
  await assert.rejects(service.mutate(cwd, "tab", action), /Invalid verification/);
  await assert.rejects(service.mutate(cwd, "other", action, result), /not active/);
  await assert.rejects(service.mutate(cwd, "tab", action, { ...result, status: "running" }), /Invalid verification/);
  await assert.rejects(service.mutate(cwd, "tab", { ...action, criteria: [{ id: task.criteria[0].id, revision: 99 }] }, result), /criteria changed/);
  let state = await service.mutate(cwd, "tab", action, result);
  assert.equal(harnessCriterionStatus(state.tasks[0], state.tasks[0].criteria[0], state.revision), "passed");
  state = await service.mutate(cwd, "tab", action, result);
  assert.equal(state.tasks[0].evidence.length, 1);
  await service.mutate(cwd, "tab", { type: "enable", enabled: false });
  await assert.rejects(service.mutate(cwd, "tab", action, result), /Invalid verification/);
});

test("linking old results keeps original time and cannot turn unknown or changed code into a pass", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  const action = { type: "linkVerification" as const, taskId: task.id, runId: "legacy", criteria: task.criteria.map(({ id, revision }) => ({ id, revision })) };
  const result: VerifyEvent = { type: "verify", ts: 10, runId: "legacy", status: "passed", cwd, head: null, commands: [{ cmd: "check", status: "passed", exitCode: 0 }] };
  let state = await service.mutate(cwd, "tab", action, result);
  assert.equal(harnessCriterionStatus(state.tasks[0], state.tasks[0].criteria[0], state.revision), "unconfirmed");
  const codeRevision = await verificationRevision(cwd);
  state = await service.mutate(cwd, "tab", { ...action, runId: "new-failure" }, { ...result, runId: "new-failure", ts: 30, codeRevision, status: "failed", commands: [{ cmd: "check", status: "failed", exitCode: 1 }] });
  state = await service.mutate(cwd, "tab", { ...action, runId: "old-pass" }, { ...result, runId: "old-pass", ts: 20, codeRevision });
  assert.equal(harnessCriterionStatus(state.tasks[0], state.tasks[0].criteria[0], state.revision), "failed", "linking an older pass must not overwrite newer failure");
  writeFileSync(join(cwd, "value.txt"), "changed after verification");
  state = await service.mutate(cwd, "tab", { ...action, runId: "changed" }, { ...result, runId: "changed", ts: 40, codeRevision });
  assert.equal(harnessCriterionStatus(state.tasks[0], state.tasks[0].criteria[0], state.revision), "stale");
});

test("edited criteria can explicitly accept old results without older-revision evidence masking them", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  const criterion = task.criteria[0];
  const result: VerifyEvent = { type: "verify", ts: 10, runId: "run", status: "passed", cwd, head: null, codeRevision: await verificationRevision(cwd), commands: [{ cmd: "check", status: "passed", exitCode: 0 }] };
  const action = { type: "linkVerification" as const, taskId: task.id, runId: "run", criteria: [{ id: criterion.id, revision: 1 }] };
  await service.mutate(cwd, "tab", action, result);
  await service.mutate(cwd, "tab", { type: "confirm", taskId: task.id, criterionId: criterion.id, note: "Later confirmation" });
  await service.mutate(cwd, "tab", { type: "edit", taskId: task.id, criteria: [{ ...criterion, description: "Clarified condition" }] });
  const state = await service.mutate(cwd, "tab", { ...action, criteria: [{ id: criterion.id, revision: 2 }] }, result);
  assert.equal(state.tasks[0].evidence.length, 3);
  assert.equal(harnessCriterionStatus(state.tasks[0], state.tasks[0].criteria[0], state.revision), "passed");
});

test("bound verification with an explicitly unknown execution revision stays unconfirmed", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  await service.bind(cwd, "tab", task.id, [task.criteria[0].id], "run");
  await service.record("run", "command", "passed", "run", null);
  const state = await service.snapshot(cwd, "tab");
  assert.equal(state.tasks[0].evidence[0].codeRevision, undefined);
  assert.equal(harnessCriterionStatus(state.tasks[0], state.tasks[0].criteria[0], state.revision), "unconfirmed");
});

test("project configuration and enablement remain isolated across restart and disable", async () => {
  const { cwd, store, service } = fixture(), other = join(cwd, "..", "other-project");
  mkdirSync(other);
  const config = { version: 1 as const, documents: ["README.md"], commands: ["node check.cjs"], procedures: ["Check restart before completion"] };
  let state = await service.mutate(cwd, "first", { type: "enable", enabled: true });
  await service.mutate(cwd, "first", { type: "configure", token: state.configToken, config });
  const task = (await service.mutate(cwd, "first", start)).tasks[0];
  const untouched = await service.snapshot(other, "second");
  assert.equal(untouched.enabled, false);
  assert.equal(untouched.tasks.length, 0);
  assert.notDeepEqual(untouched.config, config);
  const otherConfig = { version: 1 as const, documents: [], commands: [], procedures: ["Different project procedure"] };
  await service.mutate(other, "second", { type: "configure", token: untouched.configToken, config: otherConfig });
  await service.mutate(other, "second", { type: "enable", enabled: true });
  const restored = new HarnessService(store);
  state = await restored.snapshot(cwd, "first");
  assert.equal(state.enabled, true);
  assert.deepEqual(state.config, config);
  assert.equal(state.tasks[0].id, task.id);
  await restored.mutate(cwd, "first", { type: "enable", enabled: false });
  const restarted = new HarnessService(store);
  const disabled = await restarted.snapshot(cwd, "first"), independent = await restarted.snapshot(other, "second");
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.config, config);
  assert.equal(disabled.tasks[0].id, task.id);
  assert.equal(restarted.context(cwd, "first"), "");
  assert.equal(independent.enabled, true);
  assert.deepEqual(independent.config, otherConfig);
  assert.equal(independent.tasks.length, 0);
});

test("completion with failed and unconfirmed criteria preserves the reason and evidence after restart", async () => {
  const { cwd, store, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", { ...start, criteria: [
    { description: "Command passes", method: "Run check" },
    { description: "Restart checked", method: "Manual restart" },
  ] })).tasks[0];
  await service.bind(cwd, "tab", task.id, [task.criteria[0].id], "failed-run");
  await service.record("failed-run", "command", "failed", "expected true, received false");
  await assert.rejects(service.mutate(cwd, "tab", { type: "status", taskId: task.id, status: "completed" }), /reason/);
  const reason = "Known command failure and restart check deferred for a follow-up";
  await service.mutate(cwd, "tab", { type: "status", taskId: task.id, status: "completed", reason, afterBlockId: "completion-source" });
  const restored = await new HarnessService(store).snapshot(cwd, "tab"), completed = restored.tasks[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionReason, reason);
  assert.equal(completed.completedAfterBlockId, "completion-source");
  assert.equal(completed.evidence.length, 1);
  assert.equal(completed.evidence[0].reference, "expected true, received false");
  assert.equal(harnessCriterionStatus(completed, completed.criteria[0], restored.revision), "failed");
  assert.equal(harnessCriterionStatus(completed, completed.criteria[1], restored.revision), "unconfirmed");
});

test("stale editors and confirmation drafts cannot overwrite newer criteria", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  const expectedCriteria = task.criteria.map(({ id, revision }) => ({ id, revision }));
  const updated = { ...task.criteria[0], description: "Updated criterion" };
  await service.mutate(cwd, "tab", { type: "edit", taskId: task.id, criteria: [updated], expectedCriteria });
  await assert.rejects(service.mutate(cwd, "tab", { type: "edit", taskId: task.id, criteria: task.criteria, expectedCriteria }), /Task criteria changed/);
  await assert.rejects(service.mutate(cwd, "tab", { type: "confirm", taskId: task.id, criterionId: updated.id, criterionRevision: 1, note: "Checked the old criterion" }), /Task criteria changed/);
  let current = (await service.snapshot(cwd, "tab")).tasks[0];
  assert.equal(current.criteria[0].description, "Updated criterion");
  assert.equal(current.evidence.length, 0);
  await service.mutate(cwd, "tab", { type: "confirm", taskId: task.id, criterionId: updated.id, criterionRevision: 2, note: "Checked the updated criterion" });
  const second = (await service.mutate(cwd, "tab", { ...start, goal: "Second task" })).tasks[1];
  await assert.rejects(service.mutate(cwd, "tab", { type: "edit", taskId: task.id, criteria: task.criteria, expectedCriteria }), /not active/);
  current = (await service.snapshot(cwd, "tab")).tasks[1];
  assert.deepEqual(current.criteria, second.criteria);
});

test("saving an edited unlinked draft consumes only the reviewed draft", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const text = '```sudal-harness\n{"version":1,"documents":[],"commands":[],"procedures":["Draft"]}\n```';
  service.proposal(cwd, "tab", { type: "assistant_text", ts: 1, blockId: "draft", text });
  const state = await service.snapshot(cwd, "tab");
  const saved = await service.mutate(cwd, "tab", { type: "configure", token: state.configToken, draftToken: state.configDraftToken, config: { ...state.configDraft!, procedures: ["Edited"] } });
  assert.equal(saved.configDraft, undefined);
  service.proposal(cwd, "tab", { type: "assistant_text", ts: 2, blockId: "newer", text });
  const preserved = await service.mutate(cwd, "tab", { type: "configure", token: saved.configToken, draftToken: state.configDraftToken, config: saved.config });
  assert.ok(preserved.configDraft);
});

test("disabling during binding preparation rejects dispatch and invalidates existing bindings", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  await service.bind(cwd, "tab", task.id, [task.criteria[0].id], "existing");
  assert.equal(service.bindingActive("existing", "tab"), true);
  const pending = service.bind(cwd, "tab", task.id, [task.criteria[0].id], "pending");
  const rejection = assert.rejects(pending, /Invalid evidence target/);
  await service.mutate(cwd, "tab", { type: "enable", enabled: false });
  await rejection;
  assert.equal(service.bindingActive("existing", "tab"), false);
  assert.equal(service.bindingActive("pending", "tab"), false);
});

test("draft updates retain explicit association but unrelated drafts never inherit it", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const state = await service.mutate(cwd, "tab", { type: "improve", problem: "Check restart" });
  const id = state.improvements[0].id;
  const text = '```sudal-harness\n' + JSON.stringify({ ...state.config, improvementId: id }) + '\n```';
  service.proposal(cwd, "tab", { type: "assistant_text", ts: 1, blockId: "draft", text });
  service.proposal(cwd, "tab", { type: "assistant_text", ts: 2, blockId: "draft", text: text + '\nExplanation' });
  assert.equal((await service.snapshot(cwd, "tab")).configDraftImprovementId, id);
  service.proposal(cwd, "tab", { type: "assistant_text", ts: 3, blockId: "unrelated", text: '```sudal-harness\n' + JSON.stringify(state.config) + '\n```' });
  assert.equal((await service.snapshot(cwd, "tab")).configDraftImprovementId, undefined);
});

test("invalid configuration does not remove active task context", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  await service.mutate(cwd, "tab", start);
  writeFileSync(join(cwd, "sudal.harness.json"), "{");
  assert.match(service.context(cwd, "tab"), /Preserve history/);
});

test("applying another improvement preserves an unrelated pending draft", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  await service.mutate(cwd, "tab", { type: "improve", problem: "First" });
  const state = await service.mutate(cwd, "tab", { type: "improve", problem: "Second" });
  const [first, second] = state.improvements;
  service.proposal(cwd, "tab", { type: "assistant_text", ts: 1, blockId: "second", text: '```sudal-harness\n' + JSON.stringify({ ...state.config, improvementId: second.id, procedures: ["Second draft"] }) + '\n```' });
  const saved = await service.mutate(cwd, "tab", { type: "configure", token: state.configToken, config: state.config, improvementId: first.id });
  assert.equal(saved.improvements[0].status, "applied");
  assert.equal(saved.improvements[1].status, "proposed");
  assert.equal(saved.configDraftImprovementId, second.id);
  assert.deepEqual(saved.configDraft?.procedures, ["Second draft"]);
});

test("local persistence failure restores original configuration bytes", async () => {
  const { cwd, service } = fixture();
  const state = await service.snapshot(cwd, "tab");
  const original = JSON.stringify(state.config);
  writeFileSync(join(cwd, "sudal.harness.json"), original);
  const current = await service.snapshot(cwd, "tab");
  Object.assign(service, { save: () => { throw new Error("injected persistence failure"); } });
  await assert.rejects(service.mutate(cwd, "tab", { type: "configure", token: current.configToken, config: { ...current.config, procedures: ["Changed"] } }), /injected/);
  assert.equal(readFileSync(join(cwd, "sudal.harness.json"), "utf8"), original);
});

test("concurrent rejected mutation cannot discard a successful confirmation", async () => {
  const { cwd, service, store } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const state = await service.mutate(cwd, "tab", start), task = state.tasks[0];
  const results = await Promise.allSettled([
    service.mutate(cwd, "tab", { type: "confirm", taskId: task.id, criterionId: task.criteria[0].id, note: "Checked" }),
    service.mutate(cwd, "other", { type: "start", goal: "", criteria: [] }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal((await service.snapshot(cwd, "tab")).tasks[0].evidence.length, 1);
  assert.equal((await new HarnessService(store).snapshot(cwd, "tab")).tasks[0].evidence.length, 1);
});

test("configuration draft retains improvement association across restart", async () => {
  const { cwd, service, store } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const initial = await service.mutate(cwd, "tab", { type: "improve", problem: "Missed restart check" });
  const id = initial.improvements[0].id;
  service.proposal(cwd, "tab", { type: "assistant_text", ts: Date.now(), blockId: "draft", text: '```sudal-harness\n' + JSON.stringify({version:1,documents:[],commands:[],procedures:["Check restart"],improvementId:id}) + '\n```' });
  const restored = new HarnessService(store), state = await restored.snapshot(cwd, "tab");
  assert.equal(state.configDraftImprovementId, id);
  const applied = await restored.mutate(cwd, "tab", { type: "configure", config: state.configDraft!, token: state.configToken, improvementId: state.configDraftImprovementId });
  assert.equal(applied.improvements[0].status, "applied");
  assert.equal(applied.configDraftImprovementId, undefined);
});

test("invalid configuration remains recoverable with conflict protection", async () => {
  const { cwd, service } = fixture();
  writeFileSync(join(cwd, "sudal.harness.json"), "{");
  const state = await service.snapshot(cwd, "tab");
  assert.ok(state.configError);
  await service.mutate(cwd, "tab", { type: "configure", token: state.configToken, config: state.config });
  assert.equal((await service.snapshot(cwd, "tab")).configError, undefined);
  await assert.rejects(service.mutate(cwd, "tab", { type: "configure", token: state.configToken, config: state.config }), /changed/);
});

test("failed persistence rolls back the in-memory mutation", async () => {
  const { cwd, store } = fixture();
  writeFileSync(store, "not a directory");
  const service = new HarnessService(store);
  await assert.rejects(service.mutate(cwd, "tab", { type: "enable", enabled: true }));
  assert.equal((await service.snapshot(cwd, "tab")).enabled, false);
});

test("oversized serialized configuration is rejected before replacing the existing file", async () => {
  const { cwd, service } = fixture();
  let state = await service.snapshot(cwd, "tab");
  state = await service.mutate(cwd, "tab", { type: "configure", config: state.config, token: state.configToken });
  const before = readFileSync(join(cwd, "sudal.harness.json"), "utf8");
  await assert.rejects(service.mutate(cwd, "tab", { type: "configure", token: state.configToken,
    config: { ...state.config, procedures: Array.from({ length: 33 }, () => "x".repeat(2000)) } }), /too large/);
  assert.equal(readFileSync(join(cwd, "sudal.harness.json"), "utf8"), before);
  assert.deepEqual((await service.snapshot(cwd, "tab")).config, state.config);
});

test("disabled by default; configuration previews do not write files and concurrent edits are rejected", async () => {
  const { cwd, service } = fixture();
  let state = await service.snapshot(cwd, "tab");
  assert.equal(state.enabled, false);
  await assert.rejects(service.mutate(cwd, "tab", start));
  writeFileSync(join(cwd, "sudal.harness.json"), JSON.stringify(state.config));
  await assert.rejects(service.mutate(cwd, "tab", { type: "configure", config: state.config, token: state.configToken }), /changed/);
  state = await service.snapshot(cwd, "tab");
  await service.mutate(cwd, "tab", { type: "configure", config: { ...state.config, procedures: ["Check restart"] }, token: state.configToken });
  assert.match(readFileSync(join(cwd, "sudal.harness.json"), "utf8"), /Check restart/);
});

test("task state restores across service restart without running any checks", async () => {
  const { cwd, service, store } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const state = await service.mutate(cwd, "tab", start), task = state.tasks[0];
  await assert.rejects(service.mutate(cwd, "tab", { type: "status", taskId: task.id, status: "completed" }), /reason/);
  const restored = new HarnessService(store);
  assert.equal((await restored.snapshot(cwd, "tab")).tasks[0].id, task.id);
  assert.match(restored.context(cwd, "tab"), /History survives restart/);
  await restored.mutate(cwd, "tab", { type: "enable", enabled: false });
  assert.equal(restored.context(cwd, "tab"), "");
  assert.equal((await restored.snapshot(cwd, "tab")).tasks.length, 1);
});

test("evidence remains attached to original task even after another task starts", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const first = (await service.mutate(cwd, "tab", start)).tasks[0];
  await service.bind(cwd, "tab", first.id, [first.criteria[0].id], "pending");
  await service.mutate(cwd, "tab", { ...start, goal: "Second task" });
  await service.record("run", "command", "passed", "run");
  await service.rekey("pending", "run");
  let state = await service.snapshot(cwd, "tab");
  assert.equal(state.tasks[0].status, "paused");
  assert.equal(state.tasks[1].evidence.length, 0);
  assert.equal(harnessCriterionStatus(state.tasks[0], first.criteria[0], state.revision), "passed");
  writeFileSync(join(cwd, "value.txt"), "changed");
  state = await service.snapshot(cwd, "tab");
  assert.equal(harnessCriterionStatus(state.tasks[0], first.criteria[0], state.revision), "stale");
});

test("suggestions cannot mutate tasks or configurations without user acceptance", async () => {
  const { cwd, service, store } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const event = { type: "assistant_text" as const, blockId: "block", ts: 1, text: '```sudal-task\n' + JSON.stringify({ goal: start.goal, criteria: start.criteria }) + '\n```' };
  service.proposal(cwd, "tab", event);
  let state = await service.snapshot(cwd, "tab");
  assert.equal(state.tasks.length, 0); assert.equal(state.proposal?.goal, start.goal);
  assert.equal(state.proposal?.blockId, "block");
  assert.equal((await new HarnessService(store).snapshot(cwd, "tab")).proposal?.blockId, "block");
  await service.mutate(cwd, "tab", { type: "dismiss" }); service.proposal(cwd, "tab", event);
  assert.equal((await service.snapshot(cwd, "tab")).proposal, undefined);
  service.proposal(cwd, "tab", { ...event, text: '```sudal-task\n{"goal":"bad","criteria":[]}\n```' });
  assert.equal((await service.snapshot(cwd, "tab")).proposal, undefined);
  service.proposal(cwd, "tab", { ...event, text: '```sudal-harness\n{"version":1,"documents":[],"commands":["node check.cjs"],"procedures":[]}\n```' });
  state = await service.snapshot(cwd, "tab");
  assert.deepEqual(state.configDraft?.commands, ["node check.cjs"]);
  assert.deepEqual(state.config.commands, []);
});

test("directory changes pause the old task; manual confirmation needs a note", async () => {
  const { cwd, store, service } = fixture(), other = join(store, "other"); mkdirSync(other, { recursive: true });
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "tab", start)).tasks[0];
  await assert.rejects(service.mutate(cwd, "tab", { type: "confirm", taskId: task.id, criterionId: task.criteria[0].id, note: "" }));
  await service.snapshot(other, "tab");
  assert.equal((await service.snapshot(cwd, "tab")).tasks[0].status, "paused");
});

test("improvement application is explicit and does not imply verified prevention", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  let state = await service.mutate(cwd, "tab", { type: "improve", problem: "Restart check was missed" });
  const id = state.improvements[0].id;
  assert.equal(state.improvements[0].status, "proposed");
  state = await service.mutate(cwd, "tab", { type: "configure", config: { ...state.config, procedures: ["Check restart on history changes"] }, token: state.configToken, improvementId: id });
  assert.equal(state.improvements[0].status, "applied");
  await assert.rejects(service.mutate(cwd, "tab", { type: "improvementConfirm", improvementId: id, note: "" }));
  state = await service.mutate(cwd, "tab", { type: "improvementConfirm", improvementId: id, note: "Ran the restart scenario" });
  assert.equal(state.improvements[0].status, "confirmed");
});

test("running tasks cannot be silently taken over by another tab", async () => {
  const { cwd, service } = fixture();
  await service.mutate(cwd, "first", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "first", start)).tasks[0];
  await assert.rejects(service.mutate(cwd, "second", { type: "status", taskId: task.id, status: "active" }), /another tab/);
  service.detach("first");
  const resumed = await service.mutate(cwd, "second", { type: "status", taskId: task.id, status: "active" });
  assert.equal(resumed.tasks[0].tabId, "second");
});

test("restored tasks from unavailable tabs become paused and can be resumed explicitly", async () => {
  const { cwd, store, service } = fixture();
  await service.mutate(cwd, "old", { type: "enable", enabled: true });
  const task = (await service.mutate(cwd, "old", start)).tasks[0];
  const restored = new HarnessService(store, tabId => tabId === "new");
  assert.equal((await restored.snapshot(cwd, "new")).tasks[0].status, "paused");
  assert.equal((await restored.mutate(cwd, "new", { type: "status", taskId: task.id, status: "active" })).tasks[0].tabId, "new");
});
