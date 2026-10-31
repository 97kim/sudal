import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessService } from "./harness";
import { harnessCriterionStatus } from "@shared/harness";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sudal-harness-test-")), cwd = join(root, "project"), store = join(root, "store");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + store, ...args], { cwd, windowsHide: true, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(cwd, "value.txt"), "initial"); git("add", "."); git("commit", "-qm", "fixture");
  return { cwd, store, service: new HarnessService(store) };
}
const start = { type: "start" as const, goal: "Preserve history", criteria: [{ description: "History survives restart", method: "Integration test" }] };

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
  const { cwd, service } = fixture();
  await service.mutate(cwd, "tab", { type: "enable", enabled: true });
  const event = { type: "assistant_text" as const, blockId: "block", ts: 1, text: '```sudal-task\n' + JSON.stringify({ goal: start.goal, criteria: start.criteria }) + '\n```' };
  service.proposal(cwd, "tab", event);
  let state = await service.snapshot(cwd, "tab");
  assert.equal(state.tasks.length, 0); assert.equal(state.proposal?.goal, start.goal);
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
