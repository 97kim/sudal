import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationConfirmations, conversationVerificationLinks, harnessBlockBefore, harnessProposalBlock, harnessReadyBlock } from "./harness-conversation";
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
  assert.equal(conversationVerificationLinks([...source(payload()), { kind: "user", id: "next", ts: 3, text: "다른 작업" }], task)[0]?.blockId, "a");
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
  assert.equal(conversationConfirmations(nextTurn, task)[0]?.blockId, "a");
  const longFollowup: Block[] = Array.from({ length: 120 }, (_, i) => ({ kind: "user", id: `later-${i}`, text: "follow-up", ts: 5 + i }));
  assert.equal(conversationConfirmations([...nextTurn, ...longFollowup], task)[0]?.blockId, "a");
});

test("harness cards retain their source instead of following later messages", () => {
  const history: Block[] = [...blocks("answer"), { kind: "turn", id: "turn", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 1, numTurns: 1, isError: false }, { kind: "user", id: "later", ts: 10, text: "next" }];
  assert.equal(harnessBlockBefore(history, 5), "turn");
  assert.equal(harnessBlockBefore(history, undefined), undefined);
  assert.equal(harnessBlockBefore(history.slice(-1), 5), undefined);
  const proposal = { goal: "goal", criteria: [{ description: "works", method: "manual" }] };
  const source = blocks('```sudal-task\n' + JSON.stringify(proposal) + '\n```');
  assert.equal(harnessProposalBlock([...source, history.at(-1)!], proposal), "a");
  assert.equal(harnessProposalBlock(source, { ...proposal, criteria: [{ ...proposal.criteria[0], id: "stored-id", revision: 1 }] } as typeof proposal), "a");
  assert.equal(harnessProposalBlock(history, { ...proposal, blockId: "not-loaded" }), "not-loaded");
  assert.equal(harnessProposalBlock(history, proposal), undefined);
});

test("corrected and repeated proposals replace the original source, including already saved latest proposals", () => {
  const run: Block = { kind: "verify", id: "run", status: "passed", cwd: "p", head: null, commands: [], ts: 2 };
  const expanded = { ...task, criteria: [...task.criteria, { id: "other", description: "other", method: "", revision: 1 }] };
  const payload = (id: string, revision: number) => '```sudal-evidence\n' + JSON.stringify({ taskId: "t", runId: "run", criteria: [{ id, revision }] }) + '\n```';
  const source: Block[] = [blocks("")[0], run, { kind: "text", id: "first", text: payload("c", 2), streaming: false }, { kind: "user", id: "next", text: "correct to other", ts: 3 }, { kind: "text", id: "corrected", text: payload("other", 1), streaming: false }];
  assert.equal(conversationVerificationLinks(source, expanded)[0]?.blockId, "corrected");
  assert.equal(conversationVerificationLinks(source, expanded)[0]?.criteria[0].id, "other");
  const repeated: Block[] = [...blocks(suggestion()), { kind: "user", id: "u2", text: quote, ts: 3 }, { kind: "text", id: "a2", text: suggestion(), streaming: false }];
  assert.equal(conversationConfirmations(repeated, task)[0]?.blockId, "a2");
  const saved: HarnessTask = { ...task, evidence: [{ id: "e", criterionId: "c", criterionRevision: 2, source: "user", result: "unconfirmed", reference: quote, timestamp: 3, confirmationBlockId: "a2" }] };
  assert.deepEqual(conversationConfirmations(repeated, saved), []);
});

test("ready card uses attachment location while result precedence retains the old verification time", () => {
  const history: Block[] = [{ kind: "user", id: "old", text: "old", ts: 10 }, { kind: "user", id: "now", text: "link old result", ts: 100 }, { kind: "text", id: "now-answer", text: "ready", streaming: false }];
  const linked: HarnessTask = { ...task, evidence: [{ id: "e", criterionId: "c", criterionRevision: 2, source: "command", result: "passed", reference: "run", timestamp: 10, recordedAt: 110, afterBlockId: "now-answer" }] };
  assert.equal(harnessReadyBlock(history, linked), "now-answer");
  assert.equal(harnessReadyBlock([...history, { kind: "user", id: "later", text: "later", ts: 120 }], linked), "now-answer");
  assert.equal(harnessReadyBlock(history, { ...linked, evidence: [{ ...linked.evidence[0], afterBlockId: undefined }] }), "now-answer");
  assert.equal(linked.evidence[0].timestamp, 10);
  const ignoredOldResult = { ...linked.evidence[0], id: "older", timestamp: 5, recordedAt: 200, afterBlockId: "wrong-later-place" };
  assert.equal(harnessReadyBlock(history, { ...linked, evidence: [...linked.evidence, ignoredOldResult] }), "now-answer");
});
