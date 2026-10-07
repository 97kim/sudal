import { test } from "node:test";
import assert from "node:assert/strict";
import { OTTER_DONE_MS, nextRoam, otterState, roamPauseMs, type OtterTab } from "./otter";

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
  assert.equal(otterState([tab("a", { attention: "done", doneAt: 0 }), tab("b", { attention: "error" })], 1).mood, "error");
  assert.equal(otterState([tab("a", { status: "running" }), tab("b", { attention: "done", doneAt: 0 })], 1).mood, "done");
  assert.equal(otterState([tab("a", { limitUntil: 5 }), tab("b", { status: "running" })]).mood, "working");
  const lim = otterState([tab("a", { limitUntil: 5 })]);
  assert.equal(lim.mood, "limit");
  assert.equal(lim.limitUntil, 5);
});

test("otterState: 다시 시도할 시각을 모르는 한도 대기도 한도 대기다", () => {
  assert.equal(otterState([tab("a", { limitUntil: null })]).mood, "limit");
});

test("otterState: 끝남은 끝난 지 10분 동안만 보여 주고, 그 뒤에는 일하는 모습이 보인다", () => {
  const tabs = [tab("a", { attention: "done", doneAt: 1000 }), tab("b", { status: "running" })];
  const fresh = otterState(tabs, 1000 + OTTER_DONE_MS - 1);
  assert.equal(fresh.mood, "done");
  assert.equal(fresh.refreshAt, 1000 + OTTER_DONE_MS);
  assert.equal(otterState(tabs, 1000 + OTTER_DONE_MS).mood, "working");
});

test("otterState: 끝난 탭이 여럿이면 아직 10분이 안 된 것만 세고, 가장 먼저 지나는 때에 다시 본다", () => {
  const six = 6 * 60_000;
  const tabs = [tab("a", { attention: "done", doneAt: 0 }), tab("c", { attention: "done", doneAt: six })];
  const both = otterState(tabs, six);
  assert.equal(both.count, 2);
  assert.equal(both.refreshAt, OTTER_DONE_MS);
  const one = otterState(tabs, OTTER_DONE_MS);
  assert.equal(one.count, 1);
  assert.equal(one.tabId, "c");
  assert.equal(otterState(tabs, six + OTTER_DONE_MS).mood, "idle");
});

test("otterState: 끝난 시각을 모르는 끝남(앱을 다시 켜서 되살아난 것)은 보여 주지 않는다", () => {
  assert.equal(otterState([tab("a", { attention: "done" })]).mood, "idle");
});

test("otterState: 승인 대기와 오류는 시간이 지나도 그대로다", () => {
  const late = 100 * OTTER_DONE_MS;
  assert.equal(otterState([tab("a", { attention: "permission" })], late).mood, "waiting");
  assert.equal(otterState([tab("a", { attention: "error" })], late).mood, "error");
});

const tuning = { pauseSec: 120, runPct: 10, distancePct: 100 };
const seq = (...v: number[]) => () => v.shift() ?? 0;

test("nextRoam: 자리가 넉넉하면 고른 쪽으로, 거리 설정만큼 간다", () => {
  // 걷기(0.5 → 50% ≥ 10%), 거리 최댓값(→ 180), 오른쪽(0.9)
  assert.deepEqual(nextRoam(500, 0, 2000, tuning, seq(0.5, 0.999999, 0.9)), { motion: "walk", toX: 680 });
  // 뛰기(0.05 → 5% < 10%), 거리 최솟값(→ 200), 왼쪽 — 거리 200% 면 두 배
  assert.deepEqual(nextRoam(900, 0, 2000, { ...tuning, distancePct: 200 }, seq(0.05, 0, 0.1)), { motion: "run", toX: 500 });
  // 뛰기 0% 면 걷기만
  assert.equal(nextRoam(500, 0, 2000, { ...tuning, runPct: 0 }, seq(0, 0.5, 0.5)).motion, "walk");
});

test("nextRoam: 가려는 쪽이 막혔으면 반대쪽으로, 양쪽 다 좁으면 갈 수 있는 만큼만", () => {
  assert.ok(nextRoam(2000, 0, 2000, tuning, seq(0.5, 0.5, 0.9)).toX < 2000);
  const r = nextRoam(50, 0, 100, tuning, seq(0.5, 0.999999, 0.9));
  assert.ok(r.toX >= 0 && r.toX <= 100);
});

test("roamPauseMs: 평균의 0.5~1.5배", () => {
  assert.equal(roamPauseMs(tuning, () => 0), 60_000);
  assert.equal(roamPauseMs(tuning, () => 1), 180_000);
});
