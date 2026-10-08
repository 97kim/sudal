import test from "node:test";
import assert from "node:assert/strict";
import { parseLiveTasks, parseTaskFinished, parseTaskForeground, taskLabel, taskSummary } from "@shared/bg-tasks";
import { createI18n } from "@shared/i18n";
const { t } = createI18n("ko");

test("살아 있는 작업 목록을 읽는다", () => {
  const r = parseLiveTasks([
    { task_id: "t1", task_type: "shell", description: "yarn package" },
    { task_id: "t2", task_type: "subagent", description: "조사" },
  ]);
  assert.deepEqual(r, [
    { id: "t1", type: "shell", description: "yarn package" },
    { id: "t2", type: "subagent", description: "조사" },
  ]);
});

test("살림용(ambient) 작업은 화면에 세지 않는다", () => {
  const r = parseLiveTasks([
    { task_id: "t1", task_type: "shell", description: "보여야 한다" },
    { task_id: "t2", task_type: "monitor", description: "살림", ambient: true },
  ]);
  assert.deepEqual(r.map((t) => t.id), ["t1"]);
});

test("모양이 틀린 항목은 버린다", () => {
  assert.deepEqual(parseLiveTasks(null), []);
  assert.deepEqual(parseLiveTasks("nope"), []);
  assert.deepEqual(parseLiveTasks([null, 3, {}, { task_id: "" }]), []);
  // 종류·설명이 없어도 id 만 있으면 "도는 일" 로는 셀 수 있다
  assert.deepEqual(parseLiveTasks([{ task_id: "t" }]), [{ id: "t", type: "", description: "" }]);
});

test("종류 이름은 아는 것만 우리말로, 모르는 것은 그대로", () => {
  assert.equal(taskLabel(t, "shell"), "명령");
  // 실제로 오는 값은 원본 판별자 쪽이다(앱에서 관측: local_bash)
  assert.equal(taskLabel(t, "local_bash"), "명령");
  assert.equal(taskLabel(t, "local_agent"), "하위 에이전트");
  assert.equal(taskLabel(t, "subagent"), "하위 에이전트");
  assert.equal(taskLabel(t, "weird_new_type"), "weird_new_type");
  assert.equal(taskLabel(t, ""), "작업");
});

test("설명은 한 줄로 줄인다", () => {
  assert.equal(taskSummary("  두 줄\n짜리  설명 "), "두 줄 짜리 설명");
  assert.equal(taskSummary("x".repeat(300)).length, 120);
});

test("끝났다는 알림을 읽는다", () => {
  assert.deepEqual(parseTaskFinished({ task_id: "t1", status: "completed", summary: "됐다" }), {
    id: "t1",
    status: "completed",
    summary: "됐다",
  });
  assert.equal(parseTaskFinished({ task_id: "t1", status: "failed", summary: "" })?.status, "failed");
  assert.equal(parseTaskFinished({ task_id: "t1", status: "stopped", summary: "" })?.status, "stopped");
  assert.equal(parseTaskFinished({ task_id: "t1", status: "stopped", summary: "" })?.timedOut, undefined, "사용자가 세운 것");
  // SDK 0.3.285 가 실제로 보낸 문구(백그라운드 Bash 에 timeout 5000 을 걸어 재현)
  const late = parseTaskFinished({ task_id: "t1", status: "stopped", summary: 'Background command "sleep 30" was stopped after reaching its background time limit' });
  assert.equal(late?.timedOut, true);
  // 모르는 상태·살림용·id 없음은 버린다
  assert.equal(parseTaskFinished({ task_id: "t1", status: "running" }), null);
  assert.equal(parseTaskFinished({ task_id: "t1", status: "completed", ambient: true }), null);
  assert.equal(parseTaskFinished({ status: "completed" }), null);
  assert.equal(parseTaskFinished(null), null);
});

test("턴이 기다리는 작업인지 읽는다", () => {
  assert.deepEqual(parseTaskForeground({ subtype: "task_started", task_id: "a", is_backgrounded: false }), { id: "a", foreground: true });
  assert.deepEqual(parseTaskForeground({ subtype: "task_started", task_id: "a", is_backgrounded: true }), { id: "a", foreground: false });
  // 포그라운드 에이전트가 나중에 백그라운드로 넘어간다
  assert.deepEqual(parseTaskForeground({ subtype: "task_updated", task_id: "a", patch: { is_backgrounded: true } }), { id: "a", foreground: false });
  // 바뀐 게 없거나 알 수 없으면 null — 있던 판단을 건드리지 않는다
  assert.equal(parseTaskForeground({ subtype: "task_updated", task_id: "a", patch: { status: "completed" } }), null);
  assert.equal(parseTaskForeground({ subtype: "task_started", task_id: "a" }), null);
  assert.equal(parseTaskForeground({ subtype: "task_started", is_backgrounded: false }), null);
});
