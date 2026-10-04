import { test } from "node:test";
import assert from "node:assert/strict";
import { appServerUsage, classifyResumeFailure, sudalEnvArgs, mapAppServerNotification, normalizeFileChanges, reasoningSummaryArgs, resumeConflictMessage, type AppServerTurnContext } from "./codex-app-server";

test("normalizeFileChanges: kind 객체/문자열 모두 문자열로, 빠진 값은 빈 문자열, 배열이 아니면 빈 목록", () => {
  assert.deepEqual(normalizeFileChanges([{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" }, { path: "b.ts", kind: "add" }]), [
    { path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
    { path: "b.ts", kind: "add", diff: "" },
  ]);
  assert.deepEqual(normalizeFileChanges([{}]), [{ path: "", kind: "update", diff: "" }]);
  assert.deepEqual(normalizeFileChanges(undefined), []);
});

const ctx = (): AppServerTurnContext => ({ model: "gpt-6-astra", startedAt: 1000, lastUsage: null });

test("mapAppServerNotification: 메시지 델타·완료, 명령 실행 카드, 토큰 사용량 → turn_result", () => {
  const c = ctx();
  assert.deepEqual(mapAppServerNotification("item/agentMessage/delta", { itemId: "m1", delta: "안녕", threadId: "t", turnId: "u" }, 2, c), [
    { type: "text_delta", ts: 2, blockId: "m1", text: "안녕" },
  ]);
  assert.deepEqual(mapAppServerNotification("item/completed", { item: { type: "agentMessage", id: "m1", text: "안녕하세요" } }, 3, c), [
    { type: "assistant_text", ts: 3, blockId: "m1", text: "안녕하세요" },
  ]);
  assert.deepEqual(mapAppServerNotification("item/started", { item: { type: "commandExecution", id: "c1", command: "ls -la", status: "inProgress" } }, 4, c), [
    { type: "tool_use", ts: 4, toolUseId: "c1", name: "Bash", input: { command: "ls -la" } },
  ]);
  const done = mapAppServerNotification("item/completed", { item: { type: "commandExecution", id: "c1", command: "ls -la", status: "completed", exitCode: 0, aggregatedOutput: "a\nb" } }, 5, c);
  assert.equal(done.length, 2);
  assert.deepEqual(done[1], { type: "tool_result", ts: 5, toolUseId: "c1", output: "a\nb", isError: false });
  const declined = mapAppServerNotification("item/completed", { item: { type: "commandExecution", id: "c2", command: "rm x", status: "declined" } }, 6, c);
  assert.equal((declined[1] as { isError: boolean }).isError, true);
  // 사용량은 tokenUsage/updated 의 last 를 turn/completed 에서 쓴다(캐시는 입력에서 뺀다)
  assert.deepEqual(mapAppServerNotification("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 1020 } } }, 7, c), []);
  const [tr] = mapAppServerNotification("turn/completed", { turn: { id: "u", status: "completed", items: [] } }, 1500, c);
  assert.equal(tr.type, "turn_result");
  if (tr.type === "turn_result") {
    assert.deepEqual(tr.usage, { input: 400, output: 20, cacheRead: 600, cacheWrite: 0 });
    assert.equal(tr.durationMs, 500);
    assert.equal(tr.isError, false);
    assert.deepEqual(Object.keys(tr.modelUsage), ["gpt-6-astra"]);
  }
  const [fail] = mapAppServerNotification("turn/completed", { turn: { id: "u", status: "failed", error: { message: "boom" }, items: [] } }, 1600, c);
  assert.equal(fail.type === "turn_result" && fail.isError && fail.errorText, "boom");
  assert.deepEqual(mapAppServerNotification("error", { error: { message: "rate limited" } }, 8, c), [{ type: "error", ts: 8, message: "rate limited", fatal: false }]);
  assert.deepEqual(mapAppServerNotification("thread/status/changed", {}, 9, c), []);
});

test("mapAppServerNotification: 파일 변경·MCP 도구 호출", () => {
  const c = ctx();
  const fc = mapAppServerNotification("item/completed", { item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "+x" }, { path: "b.ts", kind: { type: "add" }, diff: "+y" }] } }, 1, c);
  assert.equal(fc[0].type === "tool_use" && fc[0].name, "ApplyPatch");
  assert.equal(fc[1].type === "tool_result" && fc[1].output, "update a.ts\nadd b.ts");
  const mcp = mapAppServerNotification("item/completed", { item: { type: "mcpToolCall", id: "p1", server: "github", tool: "search", status: "completed", arguments: { q: "x" }, result: { content: [{ type: "text", text: "hit" }] } } }, 2, c);
  assert.equal(mcp[0].type === "tool_use" && mcp[0].name, "github:search");
  assert.equal(mcp[1].type === "tool_result" && mcp[1].output, "hit");
  assert.deepEqual(appServerUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("mapAppServerNotification: reasoning 요약 델타는 thinking_delta, 단락 경계는 줄바꿈", () => {
  const c: AppServerTurnContext = { startedAt: 0, lastUsage: null };
  assert.deepEqual(mapAppServerNotification("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "**파일 찾기**", threadId: "t", turnId: "u" }, 3, c), [{ type: "thinking_delta", ts: 3, text: "**파일 찾기**" }]);
  assert.deepEqual(mapAppServerNotification("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "", threadId: "t", turnId: "u" }, 3, c), []);
  assert.deepEqual(mapAppServerNotification("item/reasoning/summaryPartAdded", { itemId: "r1", threadId: "t", turnId: "u" }, 4, c), [{ type: "thinking_delta", ts: 4, text: "\n" }]);
  assert.deepEqual(mapAppServerNotification("item/reasoning/textDelta", { itemId: "r1", delta: "raw", threadId: "t", turnId: "u" }, 5, c), [], "원문 reasoning 은 노출하지 않는다");
});

test("reasoningSummaryArgs: config 에 model_reasoning_summary 가 없을 때만 auto 를 넘긴다", () => {
  assert.deepEqual(reasoningSummaryArgs({}, 'model_reasoning_effort = "xhigh"\n'), ["-c", 'model_reasoning_summary="auto"']);
  assert.deepEqual(reasoningSummaryArgs({}, ""), ["-c", 'model_reasoning_summary="auto"']);
  assert.deepEqual(reasoningSummaryArgs({}, 'model = "gpt-5"\nmodel_reasoning_summary = "detailed"\n'), []);
  assert.deepEqual(reasoningSummaryArgs({}, '[profiles.x]\nmodel_reasoning_summary = "none"\n'), [], "프로파일 안의 값도 사용자가 손댄 것으로 본다");
});

test("classifyResumeFailure: thread-store 의 writer 충돌은 conflict, 나머지는 missing", () => {
  assert.equal(classifyResumeFailure("thread 01a02222-2222-7222-8222-222222222222 already has an active writer"), "conflict");
  assert.equal(classifyResumeFailure("failed to initialize thread persistence: thread-store conflict"), "conflict");
  assert.equal(classifyResumeFailure("thread not found"), "missing");
  assert.equal(classifyResumeFailure("no rollout file for 01a0…"), "missing");
  assert.match(resumeConflictMessage("01a02222-2222-7222-8222-222222222222", "x"), /01a02222…/);
  assert.match(resumeConflictMessage("01a02222-2222-7222-8222-222222222222", "x"), /\/exit/);
});

test("turn/completed: 완료된 턴에만 forkPoint(thread id + turn id)", () => {
  const c = ctx();
  const [ok] = mapAppServerNotification("turn/completed", { threadId: "th1", turn: { id: "turn-1", status: "completed", items: [] } }, 1500, c) as { forkPoint?: unknown }[];
  assert.deepEqual(ok.forkPoint, { provider: "codex", sessionId: "th1", pointId: "turn-1" });
  const [cut] = mapAppServerNotification("turn/completed", { threadId: "th1", turn: { id: "turn-2", status: "interrupted", items: [] } }, 1600, c) as { forkPoint?: unknown }[];
  assert.equal(cut.forkPoint, undefined);
});

test("sudalEnvArgs: 앱이 넘기는 변수를 Codex 셸의 set 표로 — 사용자가 환경변수 상속을 좁혀 둬도 닿게", () => {
  assert.deepEqual(sudalEnvArgs({}), []);
  assert.deepEqual(sudalEnvArgs({ SUDAL_USERDATA: "/Users/a b/Library/Application Support/Sudal", SUDAL_TAB_ID: "t-1", OTHER: "x" }), [
    "-c",
    'shell_environment_policy.set.SUDAL_USERDATA="/Users/a b/Library/Application Support/Sudal"',
    "-c",
    'shell_environment_policy.set.SUDAL_TAB_ID="t-1"',
  ]);
});
