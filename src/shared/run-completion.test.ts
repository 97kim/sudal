import test from "node:test";
import assert from "node:assert/strict";
import { judgeRun, type RunSignal } from "@shared/run-completion";

// 아래 세 순서는 지어낸 것이 아니라 실제 앱에서 잡은 것이다(SUDAL_DEBUG_SDK).
// 규칙을 바꾸려면 먼저 이 순서가 여전히 그러한지부터 확인할 것.

test("실측① 단순 턴 — 작업 목록이 아예 오지 않는다", () => {
  // SDK 는 집합이 바뀔 때만 보낸다. 안 왔다는 것은 백그라운드가 없다는 뜻이다.
  const seq: RunSignal[] = [{ kind: "turn_started" }, { kind: "result", isError: false }];
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false });
});

test("실측② 백그라운드 후속 턴 — 첫 result 는 끝이 아니다", () => {
  const upToFirstResult: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
  ];
  assert.deepEqual(judgeRun(upToFirstResult), { state: "running" }, "작업이 남았으면 아직이다");

  const whole: RunSignal[] = [
    ...upToFirstResult,
    { kind: "tasks", count: 0, source: "sdk" },
    { kind: "turn_started" }, // CLI 가 스스로 이어간 턴
    { kind: "result", isError: false },
  ];
  assert.deepEqual(judgeRun(whole), { state: "completed", isError: false });
});

test("실측③ 크래시 — 정리가 만든 빈 목록을 성공으로 읽지 않는다", () => {
  // 첫 턴은 성공했고 백그라운드가 살아 있는 채로 프로세스를 kill -9 했다.
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "stream_ended", reason: "Claude Code process terminated by signal SIGKILL", expected: false },
    { kind: "tasks", count: 0, source: "cleanup" },
  ];
  const v = judgeRun(seq);
  assert.equal(v.state, "interrupted");
  assert.match(v.state === "interrupted" ? v.reason : "", /SIGKILL/);
});

test("정리가 만든 빈 목록은 순서가 뒤바뀌어도 근거가 아니다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "cleanup" }, // 먼저 와도
    { kind: "stream_ended", reason: "죽음", expected: false },
  ];
  assert.equal(judgeRun(seq).state, "interrupted");
});

test("후속 턴이 시작되면 앞 턴의 result 는 끝의 후보에서 빠진다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk" },
    { kind: "turn_started" },
  ];
  assert.deepEqual(judgeRun(seq), { state: "running" }, "새 턴이 돌고 있다");
});

test("사람을 기다리는 동안은 완료가 아니다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "awaiting", count: 1 },
    { kind: "result", isError: false },
  ];
  assert.deepEqual(judgeRun(seq), { state: "needs_action" });
  assert.deepEqual(judgeRun([...seq, { kind: "awaiting", count: 0 }]), { state: "completed", isError: false });
});

test("실패한 턴도 끝은 끝이다 — 완료와 중단을 섞지 않는다", () => {
  const seq: RunSignal[] = [{ kind: "turn_started" }, { kind: "result", isError: true }];
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: true });
});

test("우리가 의도적으로 닫아도, 끝나지 않았으면 완료가 아니다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 2, source: "sdk" },
    { kind: "stream_ended", reason: "탭을 닫았다", expected: true },
  ];
  assert.equal(judgeRun(seq).state, "interrupted");
});

// 아래는 코덱스 리뷰가 찾은 반례다. 전체 순서만 보던 기존 시험은 중간 단계를 놓쳤다.

test("반례① tasks=0 직후에 완료로 확정하면 안 된다 — 후속 턴이 아직 안 왔다", () => {
  const upToTasksZero: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk" },
  ];
  assert.deepEqual(judgeRun(upToTasksZero), { state: "running" }, "여기서 저장하면 후속 턴을 잘라 먹는다");

  // 모든 중간 단계에서 completed 가 나오면 안 된다(마지막만 완료).
  const whole: RunSignal[] = [...upToTasksZero, { kind: "turn_started" }, { kind: "result", isError: false }];
  for (let i = 1; i < whole.length; i += 1) {
    const v = judgeRun(whole.slice(0, i));
    assert.notEqual(v.state, "completed", `${i}단계에서 조기 완료: ${JSON.stringify(whole.slice(0, i))}`);
  }
  assert.deepEqual(judgeRun(whole), { state: "completed", isError: false });
});

test("반례② 후속 턴 직전에 죽으면 성공이 아니다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk" },
    { kind: "stream_ended", reason: "terminated by signal SIGKILL", expected: false },
  ];
  assert.equal(judgeRun(seq).state, "interrupted");
});

test("백그라운드가 없던 회차는 스트림이 닫혀도 완료다", () => {
  // 유휴 종료로 프로세스가 내려가는 정상 경우.
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "result", isError: false },
    { kind: "stream_ended", reason: "유휴 종료", expected: true },
  ];
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false });
});

test("재시도 예정 오류는 회차를 끝내지 않는다(엔진 연결부 계약)", () => {
  // 연결부는 willRetry 인 오류를 stream_ended 로 바꾸지 않는다. 판정기 입장에서는
  // 그 신호가 아예 오지 않는 것과 같아야 한다.
  const seq: RunSignal[] = [{ kind: "turn_started" }, { kind: "tasks", count: 1, source: "sdk" }];
  assert.deepEqual(judgeRun(seq), { state: "running" });
});

test("새 순서(CLI 2.1.292+) — 끝났다는 알림이 먼저, 목록에서 빠지는 건 후속 턴 뒤여도 완료다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "task_finished" },
    { kind: "turn_started" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk" }, // 후속 턴 result 보다 늦게 와도
  ];
  for (let i = 1; i < seq.length; i += 1) assert.notEqual(judgeRun(seq.slice(0, i)).state, "completed", `${i}단계에서 조기 완료`);
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false }, "늦게 온 tasks=0 이 끝난 회차를 되돌리지 않는다");
});

test("예전 순서 — 목록에서 먼저 빠지고 알림이 뒤따라도 후속 턴을 한 번만 기다린다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk" },
    { kind: "task_finished" },
    { kind: "turn_started" },
    { kind: "result", isError: false },
  ];
  for (let i = 1; i < seq.length; i += 1) assert.notEqual(judgeRun(seq.slice(0, i)).state, "completed", `${i}단계에서 조기 완료`);
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false });
});

test("작업 둘 — 하나는 새 순서, 하나는 예전 순서로 와도 둘 다 짝이 맞는다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 2, source: "sdk" },
    { kind: "result", isError: false },
    { kind: "task_finished" }, // 가: 알림 먼저
    { kind: "turn_started" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk" }, // 가는 짝, 나는 목록에서 먼저 빠짐 → 후속 턴 기다림
  ];
  assert.equal(judgeRun(seq).state, "running", "나의 후속 턴이 아직이다");
  const whole: RunSignal[] = [...seq, { kind: "task_finished" }, { kind: "turn_started" }, { kind: "result", isError: false }];
  assert.deepEqual(judgeRun(whole), { state: "completed", isError: false });
});

test("id 로 짝짓기 — 포그라운드로 옮겨 가 알림 없이 빠진 작업의 몫을 다른 작업이 가져가지 않는다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk", ids: ["a"] },
    { kind: "tasks", count: 0, source: "sdk", ids: [] }, // a 가 포그라운드로 — 알림은 오지 않는다
    { kind: "tasks", count: 1, source: "sdk", ids: ["b"] },
    { kind: "result", isError: false },
    { kind: "task_finished", id: "b" }, // 새 순서: b 알림이 먼저
    { kind: "turn_started" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk", ids: [] },
  ];
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false }, "a 의 남은 짝을 b 가 가져가 영영 도는 중으로 남지 않는다");
});

test("id 로 짝짓기 — 예전 순서·새 순서가 섞여도 작업마다 맞는다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 2, source: "sdk", ids: ["a", "b"] },
    { kind: "result", isError: false },
    { kind: "task_finished", id: "a" }, // a: 알림 먼저
    { kind: "tasks", count: 1, source: "sdk", ids: ["a"] }, // b: 목록에서 먼저 빠짐
    { kind: "turn_started" },
    { kind: "result", isError: false },
  ];
  assert.equal(judgeRun(seq).state, "running", "a 가 아직 목록에 있다");
  const whole: RunSignal[] = [...seq, { kind: "tasks", count: 0, source: "sdk", ids: [] }, { kind: "task_finished", id: "b" }, { kind: "turn_started" }, { kind: "result", isError: false }];
  assert.deepEqual(judgeRun(whole), { state: "completed", isError: false });
});

test("id 로 짝짓기 — 포그라운드로 갔다 돌아온 같은 작업의 오래된 기록과 짝짓지 않는다", () => {
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: 1, source: "sdk", ids: ["a"] },
    { kind: "tasks", count: 0, source: "sdk", ids: [] },
    { kind: "tasks", count: 1, source: "sdk", ids: ["a"] },
    { kind: "result", isError: false },
    { kind: "task_finished", id: "a" },
    { kind: "turn_started" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk", ids: [] },
  ];
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false });
});

test("id 로 짝짓기 — 완료 알림이 많아도(60개) 목록에 있는 작업 기록을 버리지 않는다", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `t${i}`);
  const seq: RunSignal[] = [
    { kind: "turn_started" },
    { kind: "tasks", count: ids.length, source: "sdk", ids },
    { kind: "result", isError: false },
    ...ids.map((id): RunSignal => ({ kind: "task_finished", id })),
    { kind: "turn_started" },
    { kind: "result", isError: false },
    { kind: "tasks", count: 0, source: "sdk", ids: [] },
  ];
  assert.deepEqual(judgeRun(seq), { state: "completed", isError: false });
});
