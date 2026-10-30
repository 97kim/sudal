import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import {
  contextUsage,
  contextWarnLevel,
  initialSessionState,
  lastReplyText,
  reduceSession,
  replaySession,
} from "./session-state";

let clock = 1000;

test("Codex 하위 에이전트 상태 갱신은 부모의 응답 스트리밍·reasoning·툴 결과를 보존한다", () => {
  const input = { codexAgent: true, operation: "spawnAgent", description: "검토", agents: [{ id: "child", status: "running" }] };
  const state = replaySession([
    { type: "tool_use", ts: 1, toolUseId: "spawn", name: "Agent", input },
    { type: "tool_result", ts: 2, toolUseId: "spawn", output: "spawned", isError: false },
    { type: "text_delta", ts: 3, blockId: "parent", text: "부모 응답" },
    { type: "thinking_delta", ts: 4, text: "진행 중" },
  ]);
  const next = reduceSession(state, { type: "tool_use", ts: 5, toolUseId: "spawn", name: "Agent", input: { ...input, agents: [{ id: "child", status: "completed" }] } });
  assert.equal(next.reasoning, state.reasoning);
  assert.equal(next.reasoningStale, state.reasoningStale);
  assert.equal(next.blocks[1].kind === "text" && next.blocks[1].streaming, true);
  assert.equal(next.blocks[0].kind === "tool" && next.blocks[0].result?.output, "spawned");
});
const ev = <T extends ChatEvent["type"]>(
  type: T,
  fields: Omit<Extract<ChatEvent, { type: T }>, "type" | "ts">,
): Extract<ChatEvent, { type: T }> =>
  ({ type, ts: clock++, ...fields }) as Extract<ChatEvent, { type: T }>;

test("user_message → user 블록 추가, 스트리밍 중이던 텍스트는 종료", () => {
  const s = replaySession([
    ev("text_delta", { blockId: "m1:0", text: "안녕" }),
    ev("user_message", { id: "u1", text: "질문" }),
  ]);
  assert.equal(s.blocks.length, 2);
  assert.deepEqual(s.blocks[0], { kind: "text", id: "m1:0", text: "안녕", streaming: false });
  assert.equal(s.blocks[1].kind, "user");
});

test("text_delta 는 같은 blockId 에 이어 붙고, assistant_text 는 통째로 교체한다", () => {
  const s = replaySession([
    ev("text_delta", { blockId: "m1:0", text: "안녕" }),
    ev("text_delta", { blockId: "m1:0", text: "하세요" }),
    ev("assistant_text", { blockId: "m1:0", text: "안녕하세요!" }),
  ]);
  assert.equal(s.blocks.length, 1);
  assert.deepEqual(s.blocks[0], {
    kind: "text",
    id: "m1:0",
    text: "안녕하세요!",
    streaming: false,
  });
});

test("tool_use partial → 완성 → tool_result 순서로 한 블록에 누적", () => {
  const s = replaySession([
    ev("tool_use", { toolUseId: "t1", name: "Bash", input: {}, partial: true }),
    ev("tool_use", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }),
    ev("tool_result", { toolUseId: "t1", output: "a\nb", isError: false }),
  ]);
  assert.equal(s.blocks.length, 1);
  const b = s.blocks[0];
  assert.equal(b.kind, "tool");
  if (b.kind !== "tool") return;
  assert.deepEqual(b.input, { command: "ls" });
  assert.equal(b.partial, false);
  assert.deepEqual(b.result, { output: "a\nb", isError: false });
});

test("tool_result 가 tool_use 없이 오면 placeholder 툴 블록을 만든다", () => {
  const s = replaySession([ev("tool_result", { toolUseId: "t9", output: "x", isError: true })]);
  assert.equal(s.blocks[0].kind, "tool");
  if (s.blocks[0].kind === "tool") assert.equal(s.blocks[0].name, "(unknown)");
});

test("permission_request → waiting_permission + pending, resolved → running + 블록 표시", () => {
  const req = ev("permission_request", {
    requestId: "r1",
    toolUseId: "t1",
    tool: "Edit",
    input: { file_path: "a.ts" },
    canAlwaysAllow: true,
  });
  let s = replaySession([
    ev("status", { status: "running" }),
    ev("tool_use", { toolUseId: "t1", name: "Edit", input: { file_path: "a.ts" } }),
    req,
  ]);
  assert.equal(s.status, "waiting_permission");
  assert.equal(s.pendingPermission?.requestId, "r1");
  assert.equal((s.blocks[0] as { permission?: string }).permission, "pending");

  s = reduceSession(s, ev("permission_resolved", { requestId: "r1", behavior: "deny" }));
  assert.equal(s.status, "running");
  assert.equal(s.pendingPermission, null);
  assert.equal((s.blocks[0] as { permission?: string }).permission, "denied");
});

test("permission_resolved 가 다른 requestId 면 pending 유지", () => {
  const s = replaySession([
    ev("permission_request", {
      requestId: "r1",
      toolUseId: "t1",
      tool: "Bash",
      input: {},
      canAlwaysAllow: false,
    }),
    ev("permission_resolved", { requestId: "r0", behavior: "allow" }),
  ]);
  assert.equal(s.status, "waiting_permission");
  assert.equal(s.pendingPermission?.requestId, "r1");
});

test("turn_result → 합계 누적 + sessionId 갱신 + turn 블록", () => {
  const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 };
  const s = replaySession([
    ev("turn_result", {
      usage,
      costUsd: 0.01,
      durationMs: 1200,
      numTurns: 2,
      sessionId: "sess-1",
      modelUsage: {},
      isError: false,
    }),
    ev("turn_result", {
      usage,
      costUsd: 0.02,
      durationMs: 800,
      numTurns: 1,
      modelUsage: {},
      isError: false,
    }),
  ]);
  assert.equal(s.sessionId, "sess-1");
  assert.equal(s.totals.turns, 2);
  assert.equal(s.totals.costUsd, 0.03);
  assert.deepEqual(s.totals.usage, { input: 20, output: 10, cacheRead: 200, cacheWrite: 40 });
  assert.equal(s.blocks.filter((b) => b.kind === "turn").length, 2);
});

test("turn_result: 사용량 0 인 로컬 커맨드 턴은 lastTurn 을 덮어쓰지 않는다", () => {
  const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const s = replaySession([
    ev("turn_result", { usage, costUsd: 0.01, durationMs: 1200, numTurns: 1, modelUsage: {}, isError: false }),
    ev("turn_result", { usage: zero, costUsd: 0, durationMs: 100, numTurns: 0, modelUsage: {}, isError: false }),
  ]);
  assert.deepEqual(s.lastTurn?.usage, usage);
  assert.equal(s.totals.turns, 2);
});

test("error → status error + error 블록, pending 권한은 해제", () => {
  const s = replaySession([
    ev("permission_request", {
      requestId: "r1",
      toolUseId: "t1",
      tool: "Bash",
      input: {},
      canAlwaysAllow: false,
    }),
    ev("error", { message: "boom" }),
  ]);
  assert.equal(s.status, "error");
  assert.equal(s.pendingPermission, null);
  assert.equal(s.blocks.at(-1)?.kind, "error");
});

test("status idle 은 스트리밍 텍스트를 종료하고 pending 을 비운다", () => {
  const s = replaySession([
    ev("text_delta", { blockId: "m1:0", text: "…" }),
    ev("status", { status: "idle" }),
  ]);
  assert.equal(s.status, "idle");
  assert.equal((s.blocks[0] as { streaming: boolean }).streaming, false);
});

test("session 이벤트는 sessionId/model/cwd 를 채우고, provider 가 바뀌면 모델명을 비운다", () => {
  let s = reduceSession(
    initialSessionState(),
    ev("session", { sessionId: "s1", provider: "claude", model: "claude-opus-5", cwd: "/tmp" }),
  );
  assert.equal(s.sessionId, "s1");
  assert.equal(s.model, "claude-opus-5");
  assert.equal(s.cwd, "/tmp");
  s = reduceSession(s, ev("session", { sessionId: "th-1", provider: "codex" }));
  assert.equal(s.provider, "codex");
  assert.equal(s.model, null);
  assert.equal(s.cwd, "/tmp");
});

test("eventCount 는 처리한 이벤트마다 1 증가", () => {
  const s = replaySession([
    ev("status", { status: "running" }),
    ev("text_delta", { blockId: "a", text: "x" }),
  ]);
  assert.equal(s.eventCount, 2);
});

test("contextUsage / contextWarnLevel: 마지막 턴 기준 퍼센트와 경고 단계", () => {
  let s = initialSessionState();
  assert.equal(contextUsage(s), null);
  s = reduceSession(s, {
    type: "turn_result", ts: 1,
    usage: { input: 100_000, output: 10, cacheRead: 60_000, cacheWrite: 0 },
    costUsd: 0, durationMs: 1, numTurns: 1, isError: false,
    modelUsage: { m: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextWindow: 200_000 } },
  });
  // contextTokens 가 없는 옛 기록: 누적치를 요청 수로 나눈 근사치 (numTurns 1 이라 그대로)
  assert.deepEqual(contextUsage(s), { used: 160_000, window: 200_000, pct: 80 });
  // 툴콜 4번 턴: 누적 usage 는 4배지만 contextTokens 가 있으면 그것을 쓴다
  s = reduceSession(s, {
    type: "turn_result", ts: 3,
    usage: { input: 400_000, output: 10, cacheRead: 240_000, cacheWrite: 0 },
    contextTokens: 46_000,
    costUsd: 0, durationMs: 1, numTurns: 4, isError: false,
    modelUsage: { m: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextWindow: 200_000 } },
  });
  assert.deepEqual(contextUsage(s), { used: 46_000, window: 200_000, pct: 23 });
  // contextTokens 없이 numTurns 4 → 누적치/4
  s = reduceSession(s, {
    type: "turn_result", ts: 4,
    usage: { input: 400_000, output: 10, cacheRead: 240_000, cacheWrite: 0 },
    costUsd: 0, durationMs: 1, numTurns: 4, isError: false,
    modelUsage: { m: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextWindow: 200_000 } },
  });
  assert.equal(contextUsage(s)?.used, 160_000);
  // 창 크기: 세션 모델 것을 우선, 모르면 가장 큰 것
  s = reduceSession(s, { type: "session", ts: 5, sessionId: "x", provider: "claude", model: "big" });
  s = reduceSession(s, {
    type: "turn_result", ts: 6,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextTokens: 500_000,
    costUsd: 0, durationMs: 1, numTurns: 1, isError: false,
    modelUsage: {
      small: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextWindow: 200_000 },
      big: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextWindow: 1_000_000 },
    },
  });
  assert.deepEqual(contextUsage(s), { used: 500_000, window: 1_000_000, pct: 50 });
  s = reduceSession(s, { type: "session", ts: 7, sessionId: "x", model: "unknown" });
  assert.equal(contextUsage(s)?.window, 1_000_000);
  // session_reset 은 게이지를 비운다
  s = reduceSession(s, { type: "session_reset", ts: 8 });
  assert.equal(contextUsage(s), null);
  assert.equal(contextWarnLevel(80), "warn");
  assert.equal(contextWarnLevel(79), null);
  assert.equal(contextWarnLevel(95), "critical");
  assert.equal(contextWarnLevel(null), null);
  // Codex 처럼 창 크기를 모르면 pct null
  s = reduceSession(s, {
    type: "turn_result", ts: 2,
    usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0, durationMs: 1, numTurns: 1, isError: false, modelUsage: {},
  });
  assert.deepEqual(contextUsage(s), { used: 5, window: null, pct: null });
});

test("thinking_delta: reasoning 꼬리에 쌓이고, 말·도구·턴 끝·사용자 메시지에서 비워지며, 블록은 만들지 않는다", () => {
  let s = replaySession([ev("user_message", { id: "u1", text: "해줘" }), ev("status", { status: "running" })]);
  s = reduceSession(s, ev("thinking_delta", { text: "먼저 " }));
  s = reduceSession(s, ev("thinking_delta", { text: "파일을 본다" }));
  assert.equal(s.reasoning, "먼저 파일을 본다");
  assert.equal(s.blocks.length, 1, "생각은 블록이 아니다");
  s = reduceSession(s, ev("tool_use", { toolUseId: "t1", name: "Read", input: {} }));
  assert.equal(s.reasoning, "먼저 파일을 본다", "도구가 시작돼도 마지막 생각은 남긴다(도구 실행·결과 확인 중에 보인다)");
  s = reduceSession(s, ev("thinking_delta", { text: "결과를 보니" }));
  assert.equal(s.reasoning, "결과를 보니", "도구 뒤의 새 생각은 이어 붙이지 않고 교체한다");
  s = reduceSession(s, ev("thinking_delta", { text: " 됐다" }));
  assert.equal(s.reasoning, "결과를 보니 됐다");
  s = reduceSession(s, ev("text_delta", { blockId: "b1", text: "답" }));
  assert.equal(s.reasoning, "", "말이 시작되면 비운다");
  s = reduceSession(s, ev("thinking_delta", { text: "x" }));
  s = reduceSession(s, ev("status", { status: "idle" }));
  assert.equal(s.reasoning, "", "턴이 끝나면 비운다");
  // 긴 생각은 꼬리만
  let long = replaySession([ev("status", { status: "running" })]);
  long = reduceSession(long, ev("thinking_delta", { text: "a".repeat(1500) }));
  long = reduceSession(long, ev("thinking_delta", { text: "b".repeat(1500) }));
  assert.equal(long.reasoning.length, 2000);
  assert.ok(long.reasoning.endsWith("b".repeat(1500)));
});

test("tool_use: 앞 텍스트 블록의 스트리밍을 끝내고, 카드의 ts 는 처음 값을 지킨다", () => {
  let s = replaySession([ev("status", { status: "running" }), ev("text_delta", { blockId: "b1", text: "먼저 " })]);
  assert.equal((s.blocks[0] as { streaming: boolean }).streaming, true);
  s = reduceSession(s, { type: "tool_use", ts: 5000, toolUseId: "t1", name: "Bash", input: {}, partial: true });
  assert.equal((s.blocks[0] as { streaming: boolean }).streaming, false, "도구가 시작되면 텍스트 커서가 사라진다");
  s = reduceSession(s, { type: "tool_use", ts: 5100, toolUseId: "t1", name: "Bash", input: { command: "ls" }, partial: true, preview: true });
  s = reduceSession(s, { type: "tool_use", ts: 5200, toolUseId: "t1", name: "Bash", input: { command: "ls -la" } });
  const tool = s.blocks[1] as { ts: number; input: { command: string }; partial: boolean };
  assert.equal(tool.ts, 5000);
  assert.equal(tool.input.command, "ls -la");
  assert.equal(tool.partial, false);
});

test("subagent_activity: 상위 툴카드에 도구 수·마지막 도구·말을 쌓고, id 가 안 맞으면 진행 중인 Skill 카드에 붙는다", () => {
  let s = replaySession([ev("status", { status: "running" }), ev("tool_use", { toolUseId: "sk1", name: "Skill", input: { skill: "codex:rescue" } })]);
  s = reduceSession(s, ev("subagent_activity", { parentToolUseId: "sk1", tool: "Bash", input: { command: "node codex-companion.mjs task" } }));
  s = reduceSession(s, ev("subagent_activity", { parentToolUseId: "nested-unknown", text: "Codex 에 넘겼습니다" }));
  s = reduceSession(s, ev("subagent_activity", { parentToolUseId: "nested-unknown", tool: "Read", input: { file_path: "/x.ts" } }));
  const card = s.blocks[0] as { subagent?: { toolCalls: number; lastTool: { name: string } | null; lastText: string | null } };
  assert.equal(card.subagent?.toolCalls, 2);
  assert.equal(card.subagent?.lastTool?.name, "Read");
  assert.equal(card.subagent?.lastText, "Codex 에 넘겼습니다");
  assert.equal(s.blocks.length, 1, "활동은 블록을 만들지 않는다");
  s = reduceSession(s, ev("tool_result", { toolUseId: "sk1", output: "done", isError: false }));
  assert.equal((s.blocks[0] as { subagent?: { toolCalls: number } }).subagent?.toolCalls, 2, "결과가 와도 활동 요약은 남는다");
  // 진행 중인 Skill 카드가 없으면 무시
  const idle = replaySession([ev("status", { status: "running" })]);
  assert.equal(reduceSession(idle, ev("subagent_activity", { parentToolUseId: "zzz", text: "x" })), idle);
});

test("review: reviewTabId 로 카드 하나를 requested → done 으로 갱신하고, lastReplyText 는 마지막 답만", () => {
  let s = replaySession([ev("user_message", { id: "u1", text: "고쳐" }), ev("assistant_text", { blockId: "a", text: "고쳤습니다" })]);
  s = reduceSession(s, ev("review", { reviewer: "codex", reviewTabId: "r1", status: "requested", text: "", scope: "2개 파일 · +3 −1" }));
  s = reduceSession(s, ev("review", { reviewer: "codex", reviewTabId: "r1", status: "done", text: "## 결과\n문제 없음" }));
  const cards = s.blocks.filter((b) => b.kind === "review") as { status: string; text: string; scope?: string }[];
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "done");
  assert.equal(cards[0].scope, "2개 파일 · +3 −1", "requested 때의 범위를 지킨다");
  assert.equal(lastReplyText([ev("user_message", { id: "u", text: "q" }), ev("assistant_text", { blockId: "b1", text: "A" }), ev("tool_use", { toolUseId: "t", name: "Read", input: {} }), ev("assistant_text", { blockId: "b2", text: "B" })]), "A\n\nB");
});

test("verify: runId 로 같은 카드를 갱신하고 끝난 시각을 남긴다; 진행 중 partial 도 같은 블록", () => {
  const head = { sha: "abc123", branch: "main", dirty: false };
  const s1 = replaySession([
    ev("verify", { runId: "r1", status: "running", cwd: "/repo", head, commands: [{ cmd: "yarn test", status: "running" }] }),
    ev("verify", { runId: "r1", status: "running", cwd: "/repo", head, commands: [{ cmd: "yarn test", status: "running", output: "1 passing" }], partial: true }),
  ]);
  assert.equal(s1.blocks.length, 1);
  const b1 = s1.blocks[0];
  assert.equal(b1.kind, "verify");
  if (b1.kind !== "verify") return;
  assert.equal(b1.status, "running");
  assert.equal(b1.commands[0].output, "1 passing");
  assert.equal(b1.endedAt, undefined);
  const s2 = reduceSession(s1, ev("verify", { runId: "r1", status: "failed", cwd: "/repo", head, commands: [{ cmd: "yarn test", status: "failed", exitCode: 1 }] }));
  const b2 = s2.blocks[0];
  if (b2.kind !== "verify") return;
  assert.equal(b2.status, "failed");
  assert.equal(typeof b2.endedAt, "number");
  assert.equal(b2.ts, b1.ts);
});

test("fanout: fanoutId 로 카드를 갱신하고 adoptedTabId 는 유지된다", () => {
  const variants = [{ tabId: "v1", label: "A", provider: "claude" as const, status: "running" as const }];
  const s1 = replaySession([
    ev("fanout", { fanoutId: "f1", status: "running", prompt: "고쳐줘", policy: "auto_edit", variants }),
    ev("fanout", { fanoutId: "f1", status: "done", prompt: "고쳐줘", policy: "auto_edit", variants: [{ ...variants[0], status: "done", files: 2 }], adoptedTabId: "v1" }),
    ev("fanout", { fanoutId: "f1", status: "cleaned", prompt: "고쳐줘", policy: "auto_edit", variants: [{ ...variants[0], status: "cleaned" }] }),
  ]);
  assert.equal(s1.blocks.length, 1);
  const b = s1.blocks[0];
  if (b.kind !== "fanout") return assert.fail("fanout 블록이어야 함");
  assert.equal(b.status, "cleaned");
  assert.equal(b.adoptedTabId, "v1");
  assert.equal(b.variants[0].status, "cleaned");
});

test("subagent_activity: 로그를 쌓고 via 를 기억한다", () => {
  const s = replaySession([
    ev("tool_use", { toolUseId: "sk", name: "Skill", input: { skill: "codex:rescue" } }),
    ev("subagent_activity", { parentToolUseId: "sk", tool: "Bash", input: { command: "node companion.mjs task" } }),
    ev("subagent_activity", { parentToolUseId: "sk", tool: "Bash", input: { command: "yarn test" }, via: "codex" }),
    ev("subagent_activity", { parentToolUseId: "sk", text: "고쳤습니다", via: "codex" }),
  ]);
  const b = s.blocks[0];
  if (b.kind !== "tool") return assert.fail("tool");
  assert.equal(b.subagent?.toolCalls, 2);
  assert.equal(b.subagent?.via, "codex");
  assert.deepEqual(b.subagent?.log, ["Bash node companion.mjs task", "Codex · Bash yarn test", "Codex · 고쳤습니다"]);
});

test("병렬 승인 요청: 답이 온 것만 짚어 풀고, 남은 것은 계속 물어본다", () => {
  // "전부 자동" 으로 바꾸면 밀려 있던 요청들이 한꺼번에 풀린다. 예전에는 마지막 요청 하나만 기준으로
  // 삼아 나머지 카드가 "권한 대기" 로 굳었다 — 카드는 결과보다 권한을 먼저 보므로 도구가 끝나도 그대로였다.
  const req = (n: number) =>
    ev("permission_request", { requestId: `r${n}`, toolUseId: `t${n}`, tool: "WebFetch", input: {}, canAlwaysAllow: false });
  const s = replaySession([
    ev("tool_use", { toolUseId: "t1", name: "WebFetch", input: {} }),
    ev("tool_use", { toolUseId: "t2", name: "WebFetch", input: {} }),
    ev("tool_use", { toolUseId: "t3", name: "WebFetch", input: {} }),
    req(1),
    req(2),
    req(3),
    // 창에는 먼저 온 것이 떠 있어야 한다 — 나중 것이 앞의 것을 밀어내면 앞의 것은 답할 길이 없다.
  ]);
  assert.equal(s.pendingPermission?.requestId, "r1");
  assert.equal(s.permissionWaits.length, 3);

  // 정책을 바꾸면 밀린 순서대로 풀린다. 각 승인 뒤에 어댑터가 running 을 내보낸다.
  const after = [
    ev("permission_resolved", { requestId: "r1", behavior: "allow" as const }),
    ev("status", { status: "running" as const }),
    ev("permission_resolved", { requestId: "r2", behavior: "allow" as const }),
    ev("status", { status: "running" as const }),
  ].reduce(reduceSession, s);

  assert.equal(after.pendingPermission?.requestId, "r3", "아직 답 없는 것이 창에 남는다");
  assert.deepEqual(after.permissionWaits.map((w) => w.requestId), ["r3"]);
  const perm = (id: string) => after.blocks.find((b) => b.kind === "tool" && b.id === id) as { permission?: string };
  assert.equal(perm("t1").permission, "allowed");
  assert.equal(perm("t2").permission, "allowed");
  assert.equal(perm("t3").permission, "pending", "답이 안 온 것은 그대로 기다린다");

  const done = reduceSession(after, ev("permission_resolved", { requestId: "r3", behavior: "allow" as const }));
  assert.equal(done.pendingPermission, null);
  assert.equal(done.permissionWaits.length, 0);
  assert.equal(perm2(done, "t3"), "allowed");
});

function perm2(s: ReturnType<typeof initialSessionState>, id: string): string | undefined {
  const b = s.blocks.find((x) => x.kind === "tool" && x.id === id) as { permission?: string } | undefined;
  return b?.permission;
}

test("턴이 끝나면 결과 못 받은 도구도 끝난 것으로 적는다", () => {
  // 중단했는데 도구 카드가 "실행 중" 으로 남아 경과 시간만 올라가던 자리다.
  // 카드는 result 가 없으면 실행 중으로 그리므로, 턴이 닫힐 때 같이 닫아 줘야 한다.
  const s = replaySession([
    ev("tool_use", { toolUseId: "t1", name: "Bash", input: { command: "sleep 999" } }),
    ev("tool_use", { toolUseId: "t2", name: "Read", input: { file_path: "/a" } }),
    ev("tool_result", { toolUseId: "t2", output: "ok", isError: false }),
    ev("turn_result", {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: true,
    }),
  ]);
  const tool = (id: string) => s.blocks.find((b) => b.kind === "tool" && b.id === id) as { result?: { output: string; isError: boolean } };
  assert.equal(tool("t1").result?.isError, true, "결과를 못 받은 도구는 오류로 닫힌다");
  assert.match(tool("t1").result?.output ?? "", /결과를 받지 못했습니다/);
  assert.deepEqual(tool("t2").result, { output: "ok", isError: false }, "이미 받은 결과는 그대로다");
});

test("입력을 만들던 중(partial)에 턴이 끝난 도구도 닫는다 — partial 은 남겨 덜 만든 입력으로 실행 버튼이 붙지 않게", () => {
  // 중단했는데 카드가 "입력 생성 중" 으로 남던 자리다.
  const s = replaySession([
    ev("tool_use", { toolUseId: "t1", name: "Bash", input: { command: "grep -rn" }, partial: true, preview: true }),
    ev("turn_result", {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: true,
    }),
  ]);
  const tool = s.blocks.find((b) => b.kind === "tool" && b.id === "t1") as { partial: boolean; result?: { output: string; isError: boolean } };
  assert.equal(tool.partial, true);
  assert.equal(tool.result?.isError, true);
  assert.match(tool.result?.output ?? "", /실행하지 않았습니다/);
});

test("치명적 오류로 끝나도 돌던 도구를 닫는다 — 경고는 건드리지 않는다", () => {
  const running = () => ev("tool_use", { toolUseId: "t1", name: "Bash", input: {} });
  const warn = replaySession([running(), ev("error", { message: "경고", fatal: false })]);
  const fatal = replaySession([running(), ev("error", { message: "죽음", fatal: true })]);
  const res = (s: ReturnType<typeof replaySession>) =>
    (s.blocks.find((b) => b.kind === "tool") as { result?: unknown }).result;
  assert.equal(res(warn), undefined, "경고는 턴이 끝난 것이 아니다 — 도구는 계속 돈다");
  assert.ok(res(fatal), "치명적 오류면 닫는다");
});

test("notice: 턴은 계속되고, 같은 key 면 한 줄을 갱신한다", () => {
  const s = replaySession([
    ev("status", { status: "running" }),
    ev("notice", { message: "진행 1/3", level: "notice", key: "t1" }),
    ev("notice", { message: "진행 2/3", level: "notice", key: "t1" }),
    ev("notice", { message: "요금 한도에 가까워요", level: "warning" }),
  ]);
  const notices = s.blocks.filter((b) => b.kind === "notice") as { message: string; level: string }[];
  assert.deepEqual(notices.map((n) => n.message), ["진행 2/3", "요금 한도에 가까워요"]);
  assert.equal(s.status, "running");
});


test("Background agent stays running after the parent turn ends", () => {
  const state = replaySession([
    ev("tool_use", { toolUseId: "spawn", name: "Agent", input: { codexAgent: true, operation: "spawnAgent", description: "review", agents: [{ id: "child", status: "running" }] } }),
    ev("turn_result", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 10, numTurns: 1, modelUsage: {}, isError: false }),
  ]);
  const card = state.blocks.find((block) => block.kind === "tool");
  assert.equal(card?.kind === "tool" && card.result, undefined);
});
