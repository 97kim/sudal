import { test } from "node:test";
import assert from "node:assert/strict";
import { AgyEventMapper, agyUsage, normalizeAgyTool } from "./agy-events";
import { agyPolicyArgs, buildAgyUserInputLine } from "./agy-adapter";

test("init 이벤트 → session 이벤트 변환", () => {
  const mapper = new AgyEventMapper({ model: "gemini-4-argon-medium", startedAt: 1000, turnId: "t1" });
  const r = mapper.mapLine(
    JSON.stringify({
      event: "init",
      conversation_id: "conv-123",
      init: { cwd: "/repo", permission_mode: "request-review" },
    }),
    1500,
  );
  assert.equal(r.turnDone, false);
  assert.deepEqual(r.events, [
    {
      type: "session",
      ts: 1500,
      sessionId: "conv-123",
      provider: "agy",
      model: "gemini-4-argon-medium",
      cwd: "/repo",
    },
  ]);
});

test("step_update(agent_response) → text_delta 누적 후 DONE 에서 assistant_text", () => {
  const mapper = new AgyEventMapper({ model: "gemini-4-avenir", startedAt: 1000, turnId: "t1" });
  const s1 = mapper.mapLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        thinking_delta: "생각...",
        text_delta: "안녕",
      },
    }),
    1100,
  );
  assert.deepEqual(s1.events, [
    { type: "session", ts: 1100, sessionId: "conv-1", provider: "agy", model: "gemini-4-avenir" },
    { type: "thinking_delta", ts: 1100, text: "생각..." },
    { type: "text_delta", ts: 1100, blockId: "agy-text-t1-1", text: "안녕" },
  ]);

  const s2 = mapper.mapLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "하세요",
      },
    }),
    1200,
  );
  assert.deepEqual(s2.events, [
    { type: "text_delta", ts: 1200, blockId: "agy-text-t1-1", text: "하세요" },
    { type: "assistant_text", ts: 1200, blockId: "agy-text-t1-1", text: "안녕하세요" },
  ]);
});

test("resetTurn 호출 시 같은 step_index(1)여도 blockId 가 겹치지 않아 이전 턴 응답을 덮어쓰지 않음", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000 });
  const turn1 = mapper.mapLine(
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "첫 답변" },
    }),
    1100,
  );
  mapper.resetTurn(2000);
  const turn2 = mapper.mapLine(
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "둘째 답변" },
    }),
    2100,
  );
  const b1 = turn1.events.find((e) => e.type === "assistant_text");
  const b2 = turn2.events.find((e) => e.type === "assistant_text");
  assert.ok(b1 && b1.type === "assistant_text");
  assert.ok(b2 && b2.type === "assistant_text");
  assert.notEqual(b1.blockId, b2.blockId);
});

test("step_update(tool) → ACTIVE 에 tool_use, DONE 에 tool_result", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000, turnId: "t1" });
  mapper.mapLine(JSON.stringify({ event: "init", conversation_id: "c1" }), 1000);

  const active = mapper.mapLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: {
          name: "read_file",
          parameters: { Path: "/repo/package.json", StartLine: 1, EndLine: 10 },
        },
      },
    }),
    1300,
  );
  assert.deepEqual(active.events, [
    {
      type: "tool_use",
      ts: 1300,
      toolUseId: "agy-tool-t1-2",
      name: "Read",
      input: {
        Path: "/repo/package.json",
        StartLine: 1,
        EndLine: 10,
        file_path: "/repo/package.json",
        offset: 1,
        limit: 10,
      },
    },
  ]);

  const done = mapper.mapLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: {
          name: "read_file",
          parameters: { Path: "/repo/package.json" },
          output: "81 lines",
        },
      },
    }),
    1400,
  );
  assert.deepEqual(done.events, [
    {
      type: "tool_result",
      ts: 1400,
      toolUseId: "agy-tool-t1-2",
      output: "81 lines",
      isError: false,
    },
  ]);
});

test("result 이벤트 → turn_result 와 turnDone=true", () => {
  const mapper = new AgyEventMapper({ model: "gemini-4-argon-medium", startedAt: 1000, turnId: "t1" });
  const res = mapper.mapLine(
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "c2",
        status: "SUCCESS",
        response: "완료",
        duration_seconds: 2.5,
        num_turns: 1,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          thinking_tokens: 5,
          cache_read_tokens: 50,
        },
      },
    }),
    3500,
  );
  assert.equal(res.turnDone, true);
  assert.equal(res.events.length, 3);
  assert.equal(res.events[0].type, "session");
  assert.deepEqual(res.events[1], {
    type: "assistant_text",
    ts: 3500,
    blockId: "agy-result-t1-3500",
    text: "완료",
  });
  assert.deepEqual(res.events[2], {
    type: "turn_result",
    ts: 3500,
    usage: { input: 50, output: 20, cacheRead: 50, cacheWrite: 0 },
    costUsd: 0,
    durationMs: 2500,
    numTurns: 1,
    modelUsage: {
      "gemini-4-argon-medium": {
        input: 50,
        output: 20,
        cacheRead: 50,
        cacheWrite: 0,
        costUsd: 0,
      },
    },
    isError: false,
  });
});

test("normalizeAgyTool 및 agyPolicyArgs, buildAgyUserInputLine", () => {
  assert.deepEqual(normalizeAgyTool("run_command", { CommandLine: "npm test", toolSummary: "Run tests" }), {
    name: "Bash",
    input: { CommandLine: "npm test", toolSummary: "Run tests", command: "npm test", description: "Run tests" },
  });
  assert.deepEqual([agyPolicyArgs("ask"), agyPolicyArgs("auto_edit"), agyPolicyArgs("auto_review"), agyPolicyArgs("full")], [
    ["--sandbox", "--mode="],
    ["--mode", "accept-edits"],
    ["--mode", "auto"],
    ["--dangerously-skip-permissions"],
  ]);
  assert.equal(
    buildAgyUserInputLine("안녕", []),
    JSON.stringify({ event: "user", message: { role: "user", content: "안녕" } }),
  );
});

test("agy usage는 캐시·사고 토큰을 중복 계산하지 않는다", () => {
  const usage = agyUsage({ input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 });
  assert.deepEqual(usage, { input: 2305, output: 589, cacheRead: 8113, cacheWrite: 0 });
  assert.equal(usage.input + usage.cacheRead + usage.output, 11007);
});

test("누적 result를 턴별 증분으로 바꾸고 입력 오류의 0 값은 기준을 지우지 않는다", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000 });
  const result = (input: number, output: number, turns: number, ts: number) => {
    const r = mapper.mapEvent({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: input, output_tokens: output }, num_turns: turns, duration_seconds: 999 } }, ts);
    return r.events.find((e) => e.type === "turn_result")!;
  };
  assert.deepEqual(result(100, 20, 1, 2000).usage, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
  mapper.resetTurn(3000);
  const second = result(150, 30, 2, 4000);
  assert.deepEqual(second.usage, { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 });
  assert.equal(second.durationMs, 1000);
  assert.equal(second.numTurns, 1);
  mapper.resetTurn(5000);
  assert.equal(result(0, 0, 0, 5100).usage.input, 0);
  mapper.resetTurn(6000);
  const third = result(180, 40, 3, 6500);
  assert.equal(third.usage.input, 30);
  assert.equal(third.numTurns, 1);
});

test("재개 직후에는 현재 step 사용량만 집계하고 다음 result부터 누적 차이를 쓴다", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000, resumed: true });
  for (const state of ["ACTIVE", "DONE"]) mapper.mapEvent({ event: "step_update", step_update: {
    step_index: 10, state, step_type: "agent_response", usage: { input_tokens: 100, cache_read_tokens: 40, output_tokens: 20, thinking_tokens: 15 },
  } });
  const result = (input: number, cache: number, output: number, turns: number) => mapper.mapEvent({ event: "result", result: {
    usage: { input_tokens: input, cache_read_tokens: cache, output_tokens: output }, num_turns: turns,
  } }, 2000).events.find((e) => e.type === "turn_result")!;
  const first = result(5100, 2040, 1020, 11);
  assert.deepEqual(first.usage, { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
  assert.equal(first.numTurns, 1);
  mapper.resetTurn(2000);
  const second = result(5200, 2080, 1040, 12);
  assert.deepEqual(second.usage, first.usage);
  assert.equal(second.numTurns, 1);
});

test("DONE 도구의 tool_info.error도 실패로 표시하고 오류 내용을 보존한다", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000 });
  const r = mapper.mapEvent({ event: "step_update", step_update: {
    step_index: 4, state: "DONE", step_type: "tool",
    tool_info: { name: "run_command", parameters: { CommandLine: "npm test" }, error: { type: "permission_denied", message: "Approval unavailable" } },
  } });
  const tool = r.events.find((e) => e.type === "tool_result")!;
  assert.equal(tool.isError, true);
  assert.equal(tool.output, "Approval unavailable");
});

test("이미지 첨부는 지원하지 않는 stream 입력을 생성하기 전에 거절한다", () => {
  assert.throws(() => buildAgyUserInputLine("image", [{ name: "test.png", mime: "image/png", base64: "AAAA" }]), /Antigravity/);
});

test("재개 후 첫 오류의 0 사용량을 과거 대화의 기준값으로 삼지 않는다", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000, resumed: true });
  mapper.mapEvent({ event: "result", result: { status: "ERROR", error: "invalid input", num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 } } });
  mapper.resetTurn(2000);
  mapper.mapEvent({ event: "step_update", step_update: { step_index: 20, state: "DONE", step_type: "agent_response",
    usage: { input_tokens: 100, output_tokens: 20 } } });
  const result = mapper.mapEvent({ event: "result", result: { status: "SUCCESS", num_turns: 11,
    usage: { input_tokens: 5100, output_tokens: 1020 } } }).events.find(e => e.type === "turn_result")!;
  assert.deepEqual(result.usage, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.numTurns, 1);
});

test("누적 사용량이 빠진 턴 이후에도 이미 집계한 step을 다시 더하지 않는다", () => {
  const mapper = new AgyEventMapper({ startedAt: 1000 });
  for (let turn = 1; turn <= 3; turn++) {
    mapper.resetTurn(turn * 1000);
    mapper.mapEvent({ event: "step_update", step_update: { step_index: turn, state: "DONE", step_type: "agent_response",
      usage: { input_tokens: 100, output_tokens: 20 } } });
    const result = mapper.mapEvent({ event: "result", result: { status: "SUCCESS", num_turns: turn,
      ...(turn === 2 ? {} : { usage: { input_tokens: turn * 100, output_tokens: turn * 20 } }) } }).events.find(e => e.type === "turn_result")!;
    assert.deepEqual(result.usage, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
  }
});

test("성공하지 못한 종료 상태는 오류 메시지가 없어도 실패로 표시한다", () => {
  for (const status of ["ERROR", "FAILED", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"]) {
    const mapper = new AgyEventMapper({ startedAt: 1000 });
    const result = mapper.mapEvent({ event: "result", result: { status } });
    assert.equal(result.turnDone, true);
    assert.equal(result.events.find(e => e.type === "turn_result")?.isError, true, status);
    assert.ok(result.events.some(e => e.type === "error" && e.msg?.key === "session.msg.agyTurnFailed"), status);
  }
});
