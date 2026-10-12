import { test } from "node:test";
import assert from "node:assert/strict";
import { nestJobs } from "./background-jobs";

test("nestJobs: 하위 에이전트가 띄운 작업은 그 아래로, 모르는 부모는 맨 위로", () => {
  const j = (id: string, parentId?: string) => ({ id, sessionId: "s", label: id, title: id, status: "running" as const, summary: "", startedAt: 0, completedAt: null, root: "/r", ...(parentId ? { parentId } : {}) });
  const out = nestJobs([j("cmd1", "agentA"), j("agentA"), j("agentB"), j("cmd2", "agentB"), j("orphan", "gone"), j("deep", "cmd1")]);
  assert.deepEqual(out.map((o) => `${o.job.id}:${o.depth}`), ["agentA:0", "cmd1:1", "deep:2", "agentB:0", "cmd2:1", "orphan:0"]);
  // 서로를 부모로 가리키는 고리도 빠뜨리지 않고 한 번씩만
  assert.deepEqual(nestJobs([j("x", "y"), j("y", "x")]).map((o) => o.job.id).sort(), ["x", "y"]);
});
