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
