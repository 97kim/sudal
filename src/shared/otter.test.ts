import { test } from "node:test";
import assert from "node:assert/strict";
import { otterState, type OtterTab } from "./otter";

const tab = (id: string, o: Partial<OtterTab> = {}): OtterTab => ({ id, title: id, status: "idle", ...o });

test("otterState: 아무 일도 없으면 쉬는 중", () => {
  assert.deepEqual(otterState([tab("a")]), { mood: "idle", count: 0, tabId: null, title: null });
});

test("otterState: 도는 탭 수를 센다(대기열 포함)", () => {
  const s = otterState([tab("a", { status: "running" }), tab("b", { status: "queued" }), tab("c")]);
  assert.equal(s.mood, "working");
  assert.equal(s.count, 2);
});

test("otterState: 승인 대기가 다른 모든 상태보다 먼저다", () => {
  const s = otterState([
    tab("run", { status: "running" }),
    tab("err", { attention: "error" }),
    tab("ask", { status: "waiting_permission", title: "로그인 버그" }),
  ]);
  assert.equal(s.mood, "waiting");
  assert.equal(s.tabId, "ask");
  assert.equal(s.title, "로그인 버그");
});

test("otterState: 오류 → 끝남 → 일하는 중 → 한도 대기 순서", () => {
  assert.equal(otterState([tab("a", { attention: "done" }), tab("b", { attention: "error" })]).mood, "error");
  assert.equal(otterState([tab("a", { status: "running" }), tab("b", { attention: "done" })]).mood, "done");
  assert.equal(otterState([tab("a", { limitUntil: 5 }), tab("b", { status: "running" })]).mood, "working");
  const lim = otterState([tab("a", { limitUntil: 5 })]);
  assert.equal(lim.mood, "limit");
  assert.equal(lim.limitUntil, 5);
});

test("otterState: 다시 시도할 시각을 모르는 한도 대기도 한도 대기다", () => {
  assert.equal(otterState([tab("a", { limitUntil: null })]).mood, "limit");
});
