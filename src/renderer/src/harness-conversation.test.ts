import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationConfirmations, conversationVerificationLinks } from "./harness-conversation";
import type { HarnessTask } from "@shared/harness";
import type { Block } from "@shared/session-state";
const task: HarnessTask = { id: "t", project: "p", tabId: "tab", goal: "goal", status: "active", criteria: [{ id: "c", revision: 2, description: "works", method: "manual" }], evidence: [] };
const quote = "재시작해도 기록이 유지되는 것을 확인했어";
const suggestion = (overrides = {}) => '```sudal-confirm\n' + JSON.stringify({ taskId: "t", criterionId: "c", criterionRevision: 2, quote, ...overrides }) + '\n```';
const blocks = (text: string, streaming = false): Block[] => [{ kind: "user", id: "u", text: quote, ts: 1 }, { kind: "text", id: "a", text, streaming }];

test("verification link proposals require a real same-project result and current criterion revisions", () => {
  const payload = (overrides = {}) => '```sudal-evidence\n' + JSON.stringify({ taskId: "t", runId: "run", criteria: [{ id: "c", revision: 2 }], ...overrides }) + '\n```';
  const run: Block = { kind: "verify", id: "run", status: "passed", cwd: "p", head: null, commands: [{ cmd: "check", status: "passed", exitCode: 0 }], ts: 2 };
  const source = (text: string): Block[] => [blocks(text)[0], run, blocks(text)[1]];
  assert.deepEqual(conversationVerificationLinks(source(payload()), task)[0]?.criteria, [{ id: "c", revision: 2 }]);
  for (const invalid of [{ taskId: "wrong" }, { runId: "invented" }, { criteria: [{ id: "c", revision: 1 }] }, { criteria: [{ id: "unknown", revision: 2 }] }, { criteria: [] }, { criteria: [{ id: "c", revision: 2 }, { id: "c", revision: 2 }] }]) assert.deepEqual(conversationVerificationLinks(source(payload(invalid)), task), []);
  assert.deepEqual(conversationVerificationLinks([source(payload())[0], { ...run, status: "running" }, source(payload())[2]], task), []);
  assert.deepEqual(conversationVerificationLinks([source(payload())[0], { ...run, cwd: "other" }, source(payload())[2]], task), []);
  assert.deepEqual(conversationVerificationLinks([...source(payload()), { kind: "user", id: "next", ts: 3, text: "다른 작업" }], task), []);
  const linked = { ...task, evidence: [{ id: "e", criterionId: "c", criterionRevision: 2, source: "command" as const, result: "passed" as const, reference: "run", timestamp: 2 }] };
  assert.deepEqual(conversationVerificationLinks(source(payload()), linked), []);
});
test("accepts only completed suggestions quoting a real preceding user message", () => {
  assert.equal(conversationConfirmations(blocks(suggestion()), task).length, 1);
  for (const overrides of [{ taskId: "other" }, { criterionId: "other" }, { criterionRevision: 1 }, { quote: "AI가 확인했다고 함" }]) assert.deepEqual(conversationConfirmations(blocks(suggestion(overrides)), task), []);
  assert.deepEqual(conversationConfirmations(blocks(suggestion(), true), task), []);
  assert.deepEqual(conversationConfirmations(blocks("```sudal-confirm\n{bad}\n```"), task), []);
});
test("does not repeat saved evidence and never uses an older user's quote", () => {
  const changed = blocks(suggestion());
  changed.splice(1, 0, { kind: "user", id: "u2", text: "다른 작업 해줘", ts: 2 });
  assert.deepEqual(conversationConfirmations(changed, task), []);
  const confirmed = { ...task, evidence: [{ id: "e", criterionId: "c", criterionRevision: 2, source: "user" as const, result: "passed" as const, reference: quote, timestamp: 2 }] };
  assert.deepEqual(conversationConfirmations(blocks(suggestion()), confirmed), []);
  const repeated = blocks(suggestion());
  if (repeated[0].kind === "user") repeated[0].ts = 3;
  assert.equal(conversationConfirmations(repeated, confirmed).length, 1);
  const nextTurn: Block[] = [...blocks(suggestion()), { kind: "user", id: "next", text: "코드를 다시 수정해줘", ts: 4 }];
  assert.deepEqual(conversationConfirmations(nextTurn, task), []);
});
