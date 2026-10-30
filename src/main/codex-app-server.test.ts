import { test } from "node:test";
import assert from "node:assert/strict";
import { appServerUsage, classifyResumeFailure, sudalEnvArgs, mapAppServerNotification, normalizeFileChanges, reasoningSummaryArgs, resumeConflictMessage, type AppServerTurnContext } from "./codex-app-server";
import { mapCodexChildNotification } from "./codex-app-server";
import { readCodexAgentInput } from "@shared/codex-agents";
import { replaySession } from "@shared/session-state";
import type { ChatEvent } from "@shared/chat-events";

const collab = (id: string, tool: string, states: Record<string, { status: string; message?: string }>) => ({
  type: "collabAgentToolCall", id, tool, senderThreadId: "parent", receiverThreadIds: Object.keys(states),
  status: "completed", prompt: "코드 조사", agentsStates: states,
});

test("Codex 하위 에이전트: 생성 호출 완료는 작업 완료가 아니며 wait가 각 생성 카드도 갱신한다", () => {
  const c = ctx();
  const first = mapAppServerNotification("item/completed", { item: collab("spawn-a", "spawnAgent", { a: { status: "running" } }) }, 1, c);
  const second = mapAppServerNotification("item/completed", { item: collab("spawn-b", "spawnAgent", { b: { status: "running" } }) }, 2, c);
  assert.equal(first.some((event) => event.type === "tool_result"), false);
  assert.equal(first[0].type === "tool_use" && readCodexAgentInput(first[0].input)?.agents[0].status, "running");
  const waited = mapAppServerNotification("item/completed", { item: collab("wait", "wait", { a: { status: "completed", message: "검토 완료" }, b: { status: "errored", message: "실행 실패" } }) }, 3, c);
  const replay = replaySession([...first, ...second, ...waited]);
  assert.equal(replay.blocks.filter((block) => block.kind === "tool").length, 2);
  const a = replay.blocks.find((block) => block.kind === "tool" && block.id === "spawn-a");
  const b = replay.blocks.find((block) => block.kind === "tool" && block.id === "spawn-b");
  assert.equal(a?.kind === "tool" && readCodexAgentInput(a.input)?.agents[0].status, "completed");
  assert.equal(a?.kind === "tool" && a.result?.isError, false);
  assert.equal(b?.kind === "tool" && readCodexAgentInput(b.input)?.agents[0].status, "errored");
  assert.equal(b?.kind === "tool" && readCodexAgentInput(b.input)?.agents[0].message, "실행 실패");
});

test("Codex 하위 에이전트: 여러 대상의 상태를 한 카드에 보존하고 다른 턴에서도 수명 주기를 반영한다", () => {
  const c = ctx();
  mapAppServerNotification("item/completed", { item: collab("spawn", "spawnAgent", { a: { status: "running" }, b: { status: "pendingInit" } }) }, 1, c);
  const next: AppServerTurnContext = { ...ctx(), codexAgents: c.codexAgents };
  mapAppServerNotification("item/completed", { item: collab("wait", "wait", { a: { status: "completed" }, b: { status: "running" } }) }, 2, next);
  const updated = mapAppServerNotification("item/completed", { item: { type: "subAgentActivity", id: "activity", agentThreadId: "b", agentPath: "/b", kind: "interrupted" } }, 3, next);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].type === "tool_use" && updated[0].toolUseId, "spawn");
  assert.deepEqual(updated[0].type === "tool_use" && readCodexAgentInput(updated[0].input)?.agents.map((a) => a.status), ["completed", "interrupted"]);
});

test("Codex 하위 에이전트: 오류·중단 호출과 알 수 없는 상태를 성공으로 해석하지 않는다", () => {
  for (const status of ["failed", "interrupted"]) {
    const events = mapAppServerNotification("item/completed", { item: { ...collab("bad", "spawnAgent", { a: { status: "newFutureState" } }), status } }, 1, ctx());
    assert.equal(events[0].type === "tool_use" && readCodexAgentInput(events[0].input)?.agents[0].status, "unknown");
    assert.equal(events.at(-1)?.type === "tool_result" && (events.at(-1) as Extract<ChatEvent, { type: "tool_result" }>).isError, true);
  }
  assert.equal(readCodexAgentInput({ codexAgent: true, agents: [null, {}, { id: "a", status: "future" }] })?.agents.length, 1);
  assert.equal(readCodexAgentInput({ agents: [] }), null);
});

test("Codex 자식 알림: 도구·최종 응답만 원래 카드에 붙이고 사용량·reasoning·턴 완료는 합치지 않는다", () => {
  const c = ctx();
  mapAppServerNotification("item/completed", { item: collab("spawn", "spawnAgent", { child: { status: "running" } }) }, 1, c);
  const events = mapCodexChildNotification("item/started", { threadId: "child", item: { id: "cmd", type: "commandExecution", command: "yarn test" } }, 2, c);
  assert.deepEqual(events, [{ type: "subagent_activity", ts: 2, parentToolUseId: "spawn", tool: "Bash", input: { command: "yarn test" } }]);
  assert.deepEqual(mapCodexChildNotification("item/completed", { threadId: "child", item: { id: "reply", type: "agentMessage", text: "첫 줄\n완료했어요" } }, 3, c).filter((event) => event.type === "subagent_activity"), [{ type: "subagent_activity", ts: 3, parentToolUseId: "spawn", text: "완료했어요" }]);
  for (const method of ["thread/tokenUsage/updated", "turn/completed", "item/reasoning/textDelta"]) assert.deepEqual(mapCodexChildNotification(method, { threadId: "child" }, 4, c), []);
  assert.deepEqual(mapCodexChildNotification("item/started", { threadId: "unrelated", item: { id: "cmd", type: "commandExecution", command: "x" } }, 5, c), []);
});

test("Codex 하위 에이전트: spawn 정보가 없는 수명 주기와 상태 없는 wait도 처리한다", () => {
  const c = ctx();
  const activity = mapAppServerNotification("item/completed", { item: { type: "subAgentActivity", id: "activity", agentThreadId: "a", agentPath: "/review", kind: "started" } }, 1, c);
  assert.equal(activity[0].type === "tool_use" && readCodexAgentInput(activity[0].input)?.agents[0].status, "running");
  mapAppServerNotification("item/started", { item: { type: "collabAgentToolCall", id: "wait", tool: "wait", receiverThreadIds: ["a"], agentsStates: {} } }, 2, c);
  assert.equal(c.codexAgents?.get("a")?.input.agents[0].status, "running");
});

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


test("Codex wait reuses the original card across completion and resume", () => {
  const c = ctx();
  const events: ChatEvent[] = [];
  const send = (id: string, operation: string, status: string) => {
    const next = mapAppServerNotification("item/completed", { item: collab(id, operation, { child: { status } }) }, events.length + 1, c);
    events.push(...next);
    return replaySession(events).blocks.filter((block) => block.kind === "tool");
  };
  assert.equal(send("orphan-wait", "wait", "running").length, 0);
  assert.equal(send("spawn", "spawnAgent", "running")[0].result, undefined);
  assert.equal(send("wait-timeout", "wait", "running")[0].result, undefined);
  assert.equal(send("wait-done", "wait", "completed")[0].result?.isError, false);
  const resumed = send("resume", "resumeAgent", "running");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].result, undefined);
  assert.equal(send("wait-error", "wait", "errored")[0].result?.isError, true);
});


test("Closing an agent preserves the completed answer", () => {
  const c = ctx();
  const events: ChatEvent[] = [];
  for (const [id, operation, state] of [
    ["spawn", "spawnAgent", { status: "running" }],
    ["wait", "wait", { status: "completed", message: "review result" }],
    ["close", "closeAgent", { status: "shutdown" }],
  ] as const) events.push(...mapAppServerNotification("item/completed", { item: collab(id, operation, { child: state }) }, 1, c));
  const card = replaySession(events).blocks.find((block) => block.kind === "tool");
  assert.equal(card?.kind === "tool" && card.result?.output, "review result");
});

test("Child final response is retained when later status notifications have no message", () => {
  const c = ctx();
  const events = mapAppServerNotification("item/completed", { item: collab("spawn", "spawnAgent", { child: { status: "running" } }) }, 1, c);
  events.push(...mapCodexChildNotification("item/completed", { threadId: "child", item: { type: "agentMessage", text: "full response" } }, 2, c));
  events.push(...mapCodexChildNotification("turn/completed", { threadId: "child", turn: { status: "completed" } }, 3, c));
  const card = replaySession(events).blocks.find((block) => block.kind === "tool");
  assert.equal(card?.kind === "tool" && card.result?.output, "full response");
});


test("Closing an agent preserves failure and treats unfinished work as interrupted", () => {
  for (const status of ["errored", "interrupted", "notFound", "running", "pendingInit"] as const) {
    const c = ctx();
    const events = mapAppServerNotification("item/completed", { item: collab("spawn", "spawnAgent", { child: { status, message: "work result" } }) }, 1, c);
    events.push(...mapAppServerNotification("item/completed", { item: collab("close", "closeAgent", { child: { status: "shutdown" } }) }, 2, c));
    const card = replaySession(events).blocks.find((block) => block.kind === "tool");
    assert.equal(card?.kind === "tool" && card.result?.isError, true, status);
    assert.equal(card?.kind === "tool" && card.result?.output, "work result", status);
  }
});
