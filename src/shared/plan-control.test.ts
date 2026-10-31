import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import { isPlanControl, withoutPlanControlHistory } from "./plan-control";
import { replaySession } from "./session-state";

const user = (text: string, image = false): ChatEvent => ({ type: "user_message", ts: 1, id: text, text, ...(image ? { images: [{ dataUrl: "image" }] } : {}) });
const result = (isError = false): ChatEvent => ({ type: "turn_result", ts: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError });
const notice: ChatEvent = { type: "notice", ts: 1, level: "notice", message: "Collaboration mode: Plan", msg: { key: "session.msg.acpConfigChanged", params: { name: "Collaboration mode", value: "Plan" } } };

test("단순 plan 명령만 제어 입력으로 구분하고 실제 요청 본문은 보존한다", () => {
  for (const text of ["/plan", " /plan  ", "/plan on", "/plan off"]) assert.equal(isPlanControl(text), true);
  for (const text of ["/planning", "/plan 로그인 기능 설계", "/plan\non", "일반 요청"]) assert.equal(isPlanControl(text), false);
});

test("이전에 저장한 ACP 모드 전환의 입력·안내·성공 요약을 숨기고 다음 대화는 보존한다", () => {
  const events = [user("/plan"), notice, result(), user("안녕"), { type: "assistant_text" as const, ts: 3, blockId: "reply", text: "반갑습니다" }, result()];
  const filtered = [...withoutPlanControlHistory(events)];
  assert.deepEqual(filtered, events.slice(3));
  assert.equal(replaySession(filtered).totals.turns, 1);
  assert.equal(events.length, 6, "stored source is not mutated");
});

test("plan 전환 실패는 숨기지 않고, 요청 본문·첨부를 가진 메시지도 보존한다", () => {
  const failure: ChatEvent = { type: "error", ts: 1, message: "mode change failed" };
  assert.deepEqual([...withoutPlanControlHistory([user("/plan"), failure, result(true)])], [failure, result(true)]);
  for (const message of [user("/plan 설계해줘"), user("/plan", true)]) {
    assert.deepEqual([...withoutPlanControlHistory([message, notice, result()])], [message, notice, result()]);
  }
});

test("제어 명령의 완료 신호는 대화 블록과 사용량에 포함하지 않는다", () => {
  const event = result();
  if (event.type !== "turn_result") throw new Error("unexpected fixture");
  const state = replaySession([{ ...event, control: "plan" }]);
  assert.equal(state.blocks.length, 0);
  assert.equal(state.totals.turns, 0);
  assert.equal(state.lastTurn, null);
});
