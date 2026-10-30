import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import { staleRunEvents } from "./stale-runs";
import { createI18n } from "./i18n";
const { t } = createI18n("ko");

test("staleRunEvents: 진행 중으로 남은 verify/fanout/review 만 닫는 이벤트를 만든다", () => {
  const events: ChatEvent[] = [
    { type: "verify", ts: 1, runId: "v1", status: "running", cwd: "/r", head: null, commands: [{ cmd: "a", status: "passed" }, { cmd: "b", status: "running", output: "x" }, { cmd: "c", status: "pending" }] },
    { type: "verify", ts: 2, runId: "v2", status: "running", cwd: "/r", head: null, commands: [{ cmd: "a", status: "running" }] },
    { type: "verify", ts: 3, runId: "v2", status: "passed", cwd: "/r", head: null, commands: [{ cmd: "a", status: "passed" }] },
    { type: "fanout", ts: 4, fanoutId: "f1", status: "running", prompt: "p", policy: "ask", variants: [{ tabId: "t1", label: "A", provider: "claude", status: "done" }, { tabId: "t2", label: "B", provider: "codex", status: "waiting" }] },
    { type: "review", ts: 5, reviewer: "codex", reviewTabId: "rv", status: "requested", text: "" },
    { type: "review", ts: 6, reviewer: "codex", reviewTabId: "rv2", status: "done", text: "ok" },
  ];
  const out = staleRunEvents(t, events, 100);
  assert.deepEqual(out.map((e) => e.type), ["verify", "fanout", "review"]);
  const v = out[0];
  if (v.type !== "verify") return assert.fail("verify");
  assert.equal(v.runId, "v1");
  assert.equal(v.status, "aborted");
  assert.deepEqual(v.commands.map((c) => c.status), ["passed", "aborted", "skipped"]);
  // 안내는 출력과 따로 남긴다 — 그릴 때 지금 언어로 번역된다
  assert.match(v.commands[1].note ?? "", /재시작/);
  assert.deepEqual(v.commands[1].noteMsg, { key: "session.msg.stale" });
  const f = out[1];
  if (f.type !== "fanout") return assert.fail("fanout");
  assert.equal(f.status, "done");
  assert.deepEqual(f.variants.map((x) => x.status), ["done", "failed"]);
  const r = out[2];
  if (r.type !== "review") return assert.fail("review");
  assert.equal(r.reviewTabId, "rv");
  assert.equal(r.status, "failed");
  assert.deepEqual(staleRunEvents(t, []), []);
});

test("staleRunEvents: 결과가 오지 않은 도구와 도는 중으로 남은 상태를 닫는다", () => {
  const events: ChatEvent[] = [
    { type: "status", ts: 1, status: "running" },
    { type: "tool_use", ts: 2, toolUseId: "t1", name: "Bash", input: {} },
    { type: "tool_result", ts: 3, toolUseId: "t1", output: "ok", isError: false },
    { type: "tool_use", ts: 4, toolUseId: "t2", name: "Bash", input: {} },
    { type: "tool_use", ts: 5, toolUseId: "t2", name: "Bash", input: { cmd: "…" }, partial: true },
  ];
  const out = staleRunEvents(t, events, 100);
  // 끝나지 않은 t2 하나만 닫는다(같은 toolUseId 가 여러 번 와도 카드는 하나다)
  const results = out.filter((e) => e.type === "tool_result");
  assert.equal(results.length, 1);
  const r = results[0];
  if (r.type !== "tool_result") return assert.fail("tool_result");
  assert.equal(r.toolUseId, "t2");
  assert.equal(r.isError, true);
  assert.match(r.output, /재시작/);
  // 끊겼다는 것을 글로 남기고 상태를 내린다 — 조용히 idle 로 바꾸면 끝난 것처럼 보인다
  const tail = out.slice(-2);
  assert.equal(tail[0].type, "error");
  if (tail[0].type !== "error") return assert.fail("error");
  assert.match(tail[0].message, /중단됨/);
  assert.equal(tail[0].fatal, false);
  assert.deepEqual(tail[1], { type: "status", ts: 100, status: "idle" });
});

test("staleRunEvents: 정상으로 끝난 기록에는 아무것도 더하지 않는다", () => {
  const events: ChatEvent[] = [
    { type: "status", ts: 1, status: "running" },
    { type: "tool_use", ts: 2, toolUseId: "t1", name: "Bash", input: {} },
    { type: "tool_result", ts: 3, toolUseId: "t1", output: "ok", isError: false },
    { type: "status", ts: 4, status: "idle" },
  ];
  assert.deepEqual(staleRunEvents(t, events, 100), []);
});


test("staleRunEvents closes a Codex background card after restart even if its parent is idle", () => {
  const events: ChatEvent[] = [
    { type: "tool_use", ts: 1, toolUseId: "agent", name: "Agent", input: { codexAgent: true, operation: "spawnAgent", description: "review", agents: [{ id: "child", status: "running" }] } },
    { type: "status", ts: 2, status: "idle" },
  ];
  const out = staleRunEvents(t, events, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0].type === "tool_result" && out[0].toolUseId, "agent");
  assert.equal(out[0].type === "tool_result" && out[0].isError, true);
  assert.deepEqual(staleRunEvents(t, [...events, ...out], 4), []);
});
