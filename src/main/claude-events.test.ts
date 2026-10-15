import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeEventMapper, mergeRateLimit, parseClaudeRateLimit, previewToolInput, subagentActivity, parseJsonLoose, parseResetTime, parseUsageText, toolResultText } from "./claude-events";

type SDKMessage = import("@anthropic-ai/claude-agent-sdk").SDKMessage;

// 테스트에서는 필요한 필드만 채운 느슨한 객체를 쓴다.
const m = (o: object) => o as unknown as SDKMessage;

const stream = (event: object) =>
  m({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" });

test("system/init → session 이벤트", () => {
  const ev = new ClaudeEventMapper().map(
    m({ type: "system", subtype: "init", session_id: "sess", model: "claude-opus-5", cwd: "/w" }),
    1,
  );
  assert.deepEqual(ev, [
    { type: "session", ts: 1, sessionId: "sess", provider: "claude", model: "claude-opus-5", cwd: "/w" },
  ]);
});

test("system/local_command_output → assistant_text (빈 출력은 무시)", () => {
  const mapper = new ClaudeEventMapper();
  const ev = mapper.map(
    m({ type: "system", subtype: "local_command_output", content: " 총 사용량: 12k \n", uuid: "u1", session_id: "s" }),
    5,
  );
  assert.deepEqual(ev, [{ type: "assistant_text", ts: 5, blockId: "local:u1", text: "총 사용량: 12k" }]);
  assert.deepEqual(
    mapper.map(m({ type: "system", subtype: "local_command_output", content: "  ", uuid: "u2", session_id: "s" }), 6),
    [],
  );
});

test("텍스트 스트림: message_start → block_start → delta 들 → 최종 assistant 는 dedupe", () => {
  const mapper = new ClaudeEventMapper();
  const out = [
    stream({ type: "message_start", message: { id: "msg_1" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "안녕" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } }),
    stream({ type: "content_block_stop", index: 0 }),
    m({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "msg_1", content: [{ type: "text", text: "안녕!" }] },
    }),
  ].flatMap((x) => mapper.map(x, 0));
  assert.deepEqual(out, [
    { type: "text_delta", ts: 0, blockId: "msg_1:0", text: "안녕" },
    { type: "text_delta", ts: 0, blockId: "msg_1:0", text: "!" },
  ]);
});

test("tool_use 스트림: block_start 에 partial, input_json_delta 누적 후 stop 에 완성 input", () => {
  const mapper = new ClaudeEventMapper();
  const out = [
    stream({ type: "message_start", message: { id: "msg_2" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"ls -la"}' },
    }),
    stream({ type: "content_block_stop", index: 0 }),
  ].flatMap((x) => mapper.map(x, 5));
  assert.deepEqual(out, [
    { type: "tool_use", ts: 5, toolUseId: "toolu_1", name: "Bash", input: {}, partial: true },
    // 값이 보이기 시작하면 미리보기(화면 전용)
    { type: "tool_use", ts: 5, toolUseId: "toolu_1", name: "Bash", input: { command: "ls -la" }, partial: true, preview: true },
    { type: "tool_use", ts: 5, toolUseId: "toolu_1", name: "Bash", input: { command: "ls -la" } },
  ]);
});

test("스트림 없이 온 최종 assistant 메시지는 블록으로 만든다", () => {
  const out = new ClaudeEventMapper().map(
    m({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_3",
        content: [
          { type: "text", text: "결과" },
          { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a" } },
        ],
      },
    }),
    7,
  );
  assert.deepEqual(out, [
    { type: "assistant_text", ts: 7, blockId: "msg_3:0", text: "결과" },
    { type: "tool_use", ts: 7, toolUseId: "toolu_2", name: "Read", input: { file_path: "a" } },
  ]);
});

test("서브에이전트(parent_tool_use_id) 메시지는 텍스트·툴 블록을 만들지 않고 카드용 활동 이벤트만 흘린다", () => {
  const mapper = new ClaudeEventMapper();
  assert.deepEqual(
    mapper.map(
      m({
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: { id: "msg_4", content: [{ type: "text", text: "x" }] },
      }),
      0,
    ),
    [{ type: "subagent_activity", ts: 0, parentToolUseId: "toolu_parent", text: "x" }],
  );
  // 서브에이전트의 스트림 조각과 tool_result 는 여전히 버린다
  assert.deepEqual(mapper.map(m({ type: "stream_event", parent_tool_use_id: "toolu_parent", uuid: "u", session_id: "s", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y" } } }), 0), []);
});

test("user 메시지의 tool_result → tool_result 이벤트 (string / block[] / is_error)", () => {
  const out = new ClaudeEventMapper().map(
    m({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "plain" },
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [{ type: "text", text: "a" }, { type: "image" }],
            is_error: true,
          },
          { type: "text", text: "무시" },
        ],
      },
    }),
    9,
  );
  assert.deepEqual(out, [
    { type: "tool_result", ts: 9, toolUseId: "t1", output: "plain", isError: false },
    { type: "tool_result", ts: 9, toolUseId: "t2", output: "a\n[image]", isError: true },
  ]);
});

test("result(success) → turn_result 에 usage/cost/modelUsage", () => {
  const [out] = new ClaudeEventMapper().map(
    m({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1500,
      num_turns: 3,
      result: "done",
      total_cost_usd: 0.05,
      session_id: "sess",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
      },
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 40,
          costUSD: 0.05,
          contextWindow: 200000,
        },
      },
    }),
    11,
  );
  assert.deepEqual(out, {
    type: "turn_result",
    ts: 11,
    usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 },
    costUsd: 0.05,
    durationMs: 1500,
    numTurns: 3,
    sessionId: "sess",
    modelUsage: {
      "claude-opus-5": {
        input: 10,
        output: 20,
        cacheRead: 300,
        cacheWrite: 40,
        costUsd: 0.05,
        contextWindow: 200000,
      },
    },
    isError: false,
    errorText: undefined,
  });
});

test("result(error_max_turns) → isError + 한국어 설명", () => {
  const [out] = new ClaudeEventMapper().map(
    m({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      duration_ms: 1,
      num_turns: 5,
      total_cost_usd: 0,
      session_id: "s",
      usage: {},
      modelUsage: {},
    }),
    0,
  );
  assert.equal(out.type, "turn_result");
  if (out.type !== "turn_result") return;
  assert.equal(out.isError, true);
  assert.match(out.errorText ?? "", /최대 턴/);
});

test("assistant.error → error 이벤트", () => {
  const out = new ClaudeEventMapper().map(
    m({
      type: "assistant",
      parent_tool_use_id: null,
      error: { type: "rate_limit", message: "too many" },
      message: { id: "m", content: [] },
    }),
    0,
  );
  assert.deepEqual(out, [{ type: "error", ts: 0, message: "too many" }]);
});

test("parseJsonLoose / toolResultText 헬퍼", () => {
  assert.deepEqual(parseJsonLoose(""), {});
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose("{broken"), { _raw: "{broken" });
  assert.equal(toolResultText(null), "");
  assert.equal(toolResultText({ x: 1 }), '{"x":1}');
});

test("parseClaudeRateLimit: unifiedWindows 의 5시간/주간/모델별 주간 창을 퍼센트로", () => {
  const info = {
    status: "allowed",
    resetsAt: 1788531000,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.125, resetsAt: 1788531000 },
      seven_day: { utilization: 0.24, resetsAt: 1788951600 },
      seven_day_overage_included: { utilization: 0.37, resetsAt: 1788951600 },
    },
  };
  assert.deepEqual(parseClaudeRateLimit(info, 1000), {
    session: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1788531000 },
    weekly: { usedPercent: 24, windowMinutes: 10080, resetsAt: 1788951600 },
    modelWeekly: { usedPercent: 37, windowMinutes: 10080, resetsAt: 1788951600, label: "Fable" },
    observedAt: 1000,
  });
  const noModel = { ...info, unifiedWindows: { five_hour: info.unifiedWindows.five_hour } };
  assert.equal(parseClaudeRateLimit(noModel, 1)?.modelWeekly, null);
});

test("parseClaudeRateLimit: unifiedWindows 없으면 최상위 rateLimitType 하나만, 정보 없으면 null", () => {
  assert.deepEqual(parseClaudeRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 1.2, resetsAt: 5 }, 1), {
    session: null,
    weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: 5 },
    modelWeekly: null,
    observedAt: 1,
  });
  assert.deepEqual(parseClaudeRateLimit({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.5, resetsAt: 5 }, 1), {
    session: null,
    weekly: null,
    modelWeekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: 5, label: "Opus" },
    observedAt: 1,
  });
  assert.equal(parseClaudeRateLimit({ status: "allowed" }, 1), null);
  assert.equal(parseClaudeRateLimit(undefined, 1), null);
});

test("parseUsageText: /usage 출력에서 세션·전체 주간·모델 주간 창을 읽는다", () => {
  const now = new Date(2026, 8, 4, 18, 0).getTime();
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 3% used · resets Sep 4 at 11:10pm (Asia/Seoul)",
    "Current week (all models): 25% used · resets Sep 9 at 8pm (Asia/Seoul)",
    "Current week (Fable): 37% used · resets Sep 9 at 8pm (Asia/Seoul)",
    "",
    "What's contributing to your limits usage?",
  ].join("\n");
  const r = parseUsageText(text, now);
  assert.ok(r);
  assert.equal(r.session?.usedPercent, 3);
  assert.equal(r.session?.resetsAt, Math.floor(new Date(2026, 8, 4, 23, 10).getTime() / 1000));
  assert.equal(r.weekly?.usedPercent, 25);
  assert.equal(r.weekly?.resetsAt, Math.floor(new Date(2026, 8, 9, 20, 0).getTime() / 1000));
  assert.deepEqual(r.modelWeekly, { usedPercent: 37, windowMinutes: 10080, resetsAt: r.weekly?.resetsAt, label: "Fable" });
  assert.equal(r.observedAt, now);
  assert.equal(parseUsageText("Not logged in", now), null);
  assert.equal(parseUsageText("Current week (Sonnet only): 10% used", now)?.modelWeekly?.label, "Sonnet");
  assert.equal(parseUsageText("Current week (Sonnet only): 10% used", now)?.modelWeekly?.resetsAt, 0);
});

test("parseResetTime: 연도 경계는 다음 해로, 못 읽으면 0", () => {
  const dec = new Date(2026, 11, 30, 12, 0).getTime();
  assert.equal(parseResetTime("Jan 2 at 3pm (Asia/Seoul)", dec), Math.floor(new Date(2027, 0, 2, 15, 0).getTime() / 1000));
  assert.equal(parseResetTime("someday", dec), 0);
});

test("result 의 contextTokens 는 메인 루프 마지막 assistant 메시지의 usage (서브에이전트 제외)", () => {
  const mapper = new ClaudeEventMapper();
  mapper.map(
    m({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "a1", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } },
    }),
    0,
  );
  mapper.map(
    m({ type: "assistant", parent_tool_use_id: "sub", message: { id: "a2", content: [], usage: { input_tokens: 999 } } }),
    0,
  );
  const r = mapper.map(
    m({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {},
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 3,
      session_id: "s",
      result: "",
    }),
    1,
  );
  assert.equal(r[0].type, "turn_result");
  assert.equal((r[0] as { contextTokens?: number }).contextTokens, 45);
});

test("parseClaudeRateLimit: 거절 이벤트는 utilization 이 없어도 걸린 창을 100% 로 채운다", () => {
  assert.deepEqual(parseClaudeRateLimit({ status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: 9 }, 1), {
    session: null,
    weekly: null,
    modelWeekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: 9, label: "Fable" },
    observedAt: 1,
    rejectedResetsAt: 9,
  });
  // 창 종류조차 없으면 재시도 예약용 리셋 시각만
  assert.deepEqual(parseClaudeRateLimit({ status: "rejected", resetsAt: 9 }, 1), {
    session: null,
    weekly: null,
    modelWeekly: null,
    observedAt: 1,
    rejectedResetsAt: 9,
  });
});

test("mergeRateLimit: 새 값에 없는 창은 이전 관측값을 유지하고, 있는 창은 새 값으로", () => {
  const prev = {
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: 1 },
    weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: 2 },
    modelWeekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: 2, label: "Fable" },
    observedAt: 100,
  };
  const rejected = {
    session: null,
    weekly: null,
    modelWeekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: 2, label: "Fable" },
    observedAt: 200,
    rejectedResetsAt: 2,
  };
  assert.deepEqual(mergeRateLimit(prev, rejected), {
    session: prev.session,
    weekly: prev.weekly,
    modelWeekly: rejected.modelWeekly,
    observedAt: 200,
    rejectedResetsAt: 2,
  });
  assert.equal(mergeRateLimit(prev, null), prev);
  assert.equal(mergeRateLimit(null, rejected), rejected);
  assert.equal(mergeRateLimit(undefined, null), null);
});

test("thinking_delta: 생각 블록의 조각은 thinking_delta 로, 텍스트 블록엔 영향 없음", () => {
  const mapper = new ClaudeEventMapper();
  const stream = (event: Record<string, unknown>) => mapper.map(m({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }), 1);
  stream({ type: "message_start", message: { id: "msg1" } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  assert.deepEqual(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "먼저 파일을 " } }), [{ type: "thinking_delta", ts: 1, text: "먼저 파일을 " }]);
  assert.deepEqual(stream({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } }), []);
  stream({ type: "content_block_start", index: 1, content_block: { type: "text" } });
  assert.deepEqual(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "답" } }), [{ type: "text_delta", ts: 1, blockId: "msg1:1", text: "답" }]);
});

test("previewToolInput: 잘린 JSON 에서 문자열 필드만 뽑고, 끝이 잘린 이스케이프는 뗀다", () => {
  assert.deepEqual(previewToolInput('{"command":"cd ~ && echo \\"hi\\" | grep -'), { command: 'cd ~ && echo "hi" | grep -' });
  assert.deepEqual(previewToolInput('{"description":"Locate endpoints","command":"grep -rn \\'), { description: "Locate endpoints", command: "grep -rn " });
  assert.deepEqual(previewToolInput('{"file_path":"/a/b.ts","offset":12,"limit":'), { file_path: "/a/b.ts" });
  assert.deepEqual(previewToolInput('{"comm'), {});
  assert.deepEqual(previewToolInput(""), {});
});

test("input_json_delta: 명령이 만들어지는 대로 preview 붙은 partial tool_use 를 흘리고, 값이 안 바뀌면 안 보낸다", () => {
  const mapper = new ClaudeEventMapper();
  const stream = (event: Record<string, unknown>) => mapper.map(m({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }), 1);
  stream({ type: "message_start", message: { id: "msg1" } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } });
  assert.deepEqual(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } }), [], "값이 아직 없다");
  assert.deepEqual(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls -' } }), [
    { type: "tool_use", ts: 1, toolUseId: "t1", name: "Bash", input: { command: "ls -" }, partial: true, preview: true },
  ]);
  assert.deepEqual(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "la" } }), [
    { type: "tool_use", ts: 1, toolUseId: "t1", name: "Bash", input: { command: "ls -la" }, partial: true, preview: true },
  ]);
  assert.deepEqual(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"}' } }), [], "닫는 따옴표·괄호만 오면 값이 같다");
  assert.deepEqual(stream({ type: "content_block_stop", index: 0 }), [{ type: "tool_use", ts: 1, toolUseId: "t1", name: "Bash", input: { command: "ls -la" } }]);
});

test("하위 에이전트(parent_tool_use_id) 메시지는 카드용 subagent_activity 로: 도구는 이름+잘린 입력, 말은 마지막 줄", () => {
  assert.deepEqual(
    subagentActivity("toolu_parent", [
      { type: "text", text: "먼저 보겠습니다.\n파일을 읽는 중" },
      { type: "tool_use", id: "x", name: "Bash", input: { command: "node codex-companion.mjs task \"" + "a".repeat(300) + "\"", timeout: 600000 } },
    ], 7),
    [
      { type: "subagent_activity", ts: 7, parentToolUseId: "toolu_parent", text: "파일을 읽는 중" },
      { type: "subagent_activity", ts: 7, parentToolUseId: "toolu_parent", tool: "Bash", input: { command: ("node codex-companion.mjs task \"" + "a".repeat(300)).slice(0, 200) + "…" } },
    ],
  );
  const mapper = new ClaudeEventMapper();
  const out = mapper.map(m({ type: "assistant", parent_tool_use_id: "toolu_parent", uuid: "u", session_id: "s", message: { id: "sub1", role: "assistant", content: [{ type: "tool_use", id: "y", name: "Read", input: { file_path: "/a.ts" } }] } }), 8);
  assert.deepEqual(out, [{ type: "subagent_activity", ts: 8, parentToolUseId: "toolu_parent", tool: "Read", input: { file_path: "/a.ts" } }]);
});

test("스트림이 끊겨 블록 이벤트가 안 와도 완성 메시지에서 툴 호출을 메운다", () => {
  // 실제로 겪은 일: message_start 만 오고 content_block_start/stop 이 오지 않았다.
  // 메시지 단위로 "스트림에서 봤다" 를 판단하면 이 호출이 통째로 사라지고, 결과만 남아 이름 없는 카드가 된다.
  const mapper = new ClaudeEventMapper();
  mapper.map(stream({ type: "message_start", message: { id: "msg_broken" } }), 1);
  const ev = mapper.map(
    m({
      type: "assistant",
      message: { id: "msg_broken", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
      parent_tool_use_id: null,
      uuid: "u",
      session_id: "s",
    }),
    2,
  );
  assert.deepEqual(ev, [{ type: "tool_use", ts: 2, toolUseId: "toolu_1", name: "Bash", input: { command: "ls" } }]);
});

test("정상 스트림이면 완성 메시지에서 같은 툴 호출을 두 번 내지 않는다", () => {
  const mapper = new ClaudeEventMapper();
  const evs = [
    stream({ type: "message_start", message: { id: "msg_ok" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "Bash" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
    stream({ type: "content_block_stop", index: 0 }),
  ].flatMap((x) => mapper.map(x, 1));
  const done = evs.filter((e) => e.type === "tool_use" && !e.partial);
  assert.equal(done.length, 1);

  const after = mapper.map(
    m({
      type: "assistant",
      message: { id: "msg_ok", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } }] },
      parent_tool_use_id: null,
      uuid: "u",
      session_id: "s",
    }),
    2,
  );
  assert.deepEqual(after, []);
});

test("스트림으로 흐른 글자는 완성 메시지에서 다시 내지 않는다", () => {
  const mapper = new ClaudeEventMapper();
  mapper.map(stream({ type: "message_start", message: { id: "msg_t" } }), 1);
  mapper.map(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), 1);
  mapper.map(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "안녕" } }), 1);
  const after = mapper.map(
    m({
      type: "assistant",
      message: { id: "msg_t", content: [{ type: "text", text: "안녕" }] },
      parent_tool_use_id: null,
      uuid: "u",
      session_id: "s",
    }),
    2,
  );
  assert.deepEqual(after, []);
});

test("progressNotes: 글이 있는 thinking 블록은 끝날 때 채팅 텍스트로 한 번 남기고, 완성 메시지에서 다시 내지 않는다", () => {
  const mapper = new ClaudeEventMapper({ progressNotes: true });
  const st = (event: Record<string, unknown>) => mapper.map(m({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }), 1);
  st({ type: "message_start", message: { id: "msg1" } });
  st({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  st({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "파일을 확인했어요. " } });
  st({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "이제 고칩니다.\n" } });
  assert.deepEqual(st({ type: "content_block_stop", index: 0 }), [{ type: "assistant_text", ts: 1, blockId: "msg1:0", text: "파일을 확인했어요. 이제 고칩니다." }]);
  // 빈 thinking(추론을 숨긴 블록)은 남기지 않는다
  st({ type: "content_block_start", index: 1, content_block: { type: "thinking" } });
  assert.deepEqual(st({ type: "content_block_stop", index: 1 }), []);
  const done = mapper.map(m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg1", content: [{ type: "thinking", thinking: "파일을 확인했어요. 이제 고칩니다." }, { type: "thinking", thinking: "" }] } }), 2);
  assert.deepEqual(done, [], "스트림으로 이미 낸 것은 다시 내지 않는다");
});

test("progressNotes: CLI 가 완성 메시지를 블록마다 쪼개 보내도(순번이 0 으로 바뀌어도) 다시 내지 않는다", () => {
  const mapper = new ClaudeEventMapper({ progressNotes: true });
  const st = (event: Record<string, unknown>) => mapper.map(m({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }), 1);
  const done = (content: unknown[]) => mapper.map(m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg4", content } }), 2);
  st({ type: "message_start", message: { id: "msg4" } });
  st({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  st({ type: "content_block_stop", index: 0 });
  assert.deepEqual(done([{ type: "thinking", thinking: "" }]), []);
  st({ type: "content_block_start", index: 1, content_block: { type: "thinking" } });
  st({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "서버를 고칠게요." } });
  assert.equal(st({ type: "content_block_stop", index: 1 }).length, 1);
  assert.deepEqual(done([{ type: "thinking", thinking: "서버를 고칠게요." }]), [], "쪼갠 메시지(msg4:0)로 다시 와도 한 번만");
});

test("progressNotes: 스트림이 끊겨 블록 끝을 못 봤으면 완성 메시지에서 메우고, 꺼져 있으면 아무것도 남기지 않는다", () => {
  const on = new ClaudeEventMapper({ progressNotes: true });
  on.map(m({ type: "stream_event", event: { type: "message_start", message: { id: "msg2" } }, parent_tool_use_id: null, uuid: "u", session_id: "s" }), 1);
  const msg = m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg2", content: [{ type: "thinking", thinking: "원인을 찾았어요." }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } });
  const ev = on.map(msg, 2);
  assert.deepEqual(ev[0], { type: "assistant_text", ts: 2, blockId: "msg2:0", text: "원인을 찾았어요." });
  const off = new ClaudeEventMapper();
  const ev2 = off.map(m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg3", content: [{ type: "thinking", thinking: "추론 요약" }] } }), 3);
  assert.deepEqual(ev2, [], "showThinkingSummaries 일 때(기본 꺼짐)는 추론 요약을 채팅에 남기지 않는다");
});

test("system/informational: notice·suggestion·warning 은 알림으로, info 와 빈 글은 버린다", () => {
  const mapper = new ClaudeEventMapper();
  const info = (level: string, content: string, extra: Record<string, unknown> = {}) =>
    mapper.map(m({ type: "system", subtype: "informational", level, content, uuid: "u", session_id: "s", ...extra }), 1);
  assert.deepEqual(info("warning", " 컨텍스트가 곧 찹니다 "), [{ type: "notice", ts: 1, message: "컨텍스트가 곧 찹니다", level: "warning" }]);
  assert.deepEqual(info("notice", "훅이 막았습니다", { tool_use_id: "t1" }), [{ type: "notice", ts: 1, message: "훅이 막았습니다", level: "notice", key: "t1" }]);
  assert.deepEqual(info("info", "기록 보기 전용"), []);
  assert.deepEqual(info("warning", "  "), []);
});

test("system/init 의 plugin_errors 는 경고 한 줄로(key 고정), 없으면 세션 이벤트만", () => {
  const mapper = new ClaudeEventMapper();
  const init = (extra: Record<string, unknown>) =>
    mapper.map(m({ type: "system", subtype: "init", session_id: "s", model: "opus", cwd: "/r", uuid: "u", ...extra }), 1);
  assert.equal(init({}).length, 1);
  const ev = init({ plugin_errors: [{ plugin: "codex@openai", type: "dependency-unsatisfied", message: "node 가 없습니다" }, { plugin: "inline[0]", type: "path-not-found", message: "" }] });
  assert.deepEqual(ev[1], { type: "notice", ts: 1, level: "warning", key: "plugin-errors", message: "플러그인 2개를 불러오지 못했습니다: codex@openai (node 가 없습니다), inline[0]", msg: { key: "session.msg.pluginErrors.all", params: { count: 2, shown: "codex@openai (node 가 없습니다), inline[0]" } } });
});

test("forkPoint: 정상 턴의 마지막 최상위 체인 항목 uuid 를 붙이고, 서브에이전트 메시지는 빼며, 결과 뒤엔 비운다", () => {
  const mapper = new ClaudeEventMapper();
  const result = (extra: Record<string, unknown> = {}) =>
    mapper.map(m({ type: "result", subtype: "success", is_error: false, duration_ms: 1, num_turns: 1, result: "", total_cost_usd: 0, session_id: "sess", usage: {}, modelUsage: {}, ...extra }), 9)[0] as { forkPoint?: unknown };
  const asst = (uuid: string, parent: string | null = null) =>
    mapper.map(m({ type: "assistant", uuid, parent_tool_use_id: parent, message: { id: `msg-${uuid}`, content: [] } }), 1);
  const toolResult = (uuid: string) => mapper.map(m({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: [] } }), 1);
  asst("a1");
  toolResult("u1");
  asst("sub", "toolu_x"); // 서브에이전트
  assert.deepEqual(result().forkPoint, { provider: "claude", sessionId: "sess", pointId: "u1" });
  assert.equal(result().forkPoint, undefined, "체인 항목이 없는 턴(압축만 등)은 앞 턴 것을 다시 쓰지 않는다");
  asst("a2");
  assert.equal(result({ subtype: "error_during_execution", is_error: true }).forkPoint, undefined, "오류·중단 턴은 분기 지점이 없다");
});

test("parseClaudeRateLimit: 추가 사용량 켜짐·쓰는 중·다 씀을 읽고, 합칠 때 이전 값을 지킨다", () => {
  const on = parseClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 100, overageEnabled: true, overageStatus: "allowed" }, 1);
  assert.deepEqual(on?.overage, { enabled: true, inUse: false, status: "allowed" });
  const using = parseClaudeRateLimit({ status: "rejected", resetsAt: 100, isUsingOverage: true, overageStatus: "allowed_warning", overageResetsAt: 200 }, 2);
  assert.deepEqual(using?.overage, { enabled: true, inUse: true, status: "allowed_warning", resetsAt: 200 });
  // 쓸 수 없는 이유를 함께 남긴다(크레딧 없음과 꺼짐을 나눠 보여 준다)
  assert.deepEqual(parseClaudeRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.76, overageEnabled: true, overageStatus: "rejected", overageDisabledReason: "out_of_credits" }, 6)?.overage, { enabled: true, inUse: false, status: "rejected", disabledReason: "out_of_credits" });
  // 추가 사용량 정보만 와도 버리지 않는다
  assert.equal(parseClaudeRateLimit({ status: "allowed", overageEnabled: false }, 3)?.overage?.enabled, false);
  // 예전 CLI 처럼 없으면 만들지 않는다
  assert.equal(parseClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: 1 }, 4)?.overage, undefined);
  // 새 값에 없으면 이전 값을 그대로 둔다
  assert.deepEqual(mergeRateLimit(on, parseClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1 }, 5))?.overage, on?.overage);
});
