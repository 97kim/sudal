import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "./i18n";
import { attention, buildWorkerPrompt, resolveGroup, taskWaves, pendingDelivery, reduceRun, replayRun, runSettled, runSummary, undeliveredFollowups, undeliveredInbox, unreadFollowups, type OrchDispatch, type OrchEvent, type OrchMessage, type OrchRun, type OrchTask } from "./orchestration";

const run: OrchRun = { id: "r1", objective: "로그인 고치기", createdAt: 1, createdBy: { kind: "user" }, coordinator: { kind: "user", epoch: 1, key: "k1" }, status: "active" };
const task: OrchTask = { id: "t1", runId: "r1", seq: 1, spec: "auth.ts 의 500 고치기", createdAt: 2, status: "pending", activeDispatchId: null, attempts: 0, deps: [] };
const disp: OrchDispatch = { id: "d1", runId: "r1", taskId: "t1", attempt: 1, tabId: "tab1", provider: "claude", policy: "auto_edit", cwd: "/repo", capability: "cap1", status: "starting", startedAt: 3, startStage: "creating_tab", execution: { state: "unknown", observedAt: 3 }, lastCheckSeq: 0, pendingCheckSeq: 0, ownership: "supervised" };
const msg = (p: Partial<OrchMessage> & Pick<OrchMessage, "id" | "seq" | "type" | "to">): OrchMessage => ({ runId: "r1", ts: 10 + p.seq, from: { kind: "dispatch", dispatchId: "d1" }, subject: "", body: "", ...p });

test("replay: run → task → dispatch 시작 → 질문 → 답 → 보고 → 정산", () => {
  const events: OrchEvent[] = [
    { type: "run_created", ts: 1, run },
    { type: "task_created", ts: 2, task },
    { type: "dispatch_created", ts: 3, dispatch: disp },
    { type: "dispatch_stage", ts: 4, dispatchId: "d1", stage: "started" },
    { type: "dispatch_execution", ts: 5, dispatchId: "d1", state: "running" },
    { type: "message", ts: 6, message: msg({ id: "q1", seq: 1, type: "question", to: "run", dispatchId: "d1", body: "테스트도?", options: ["예", "아니오"] }) },
    { type: "question_answered", ts: 7, questionId: "q1", answer: { body: "예", by: { kind: "user" }, at: 7, messageId: "a1" } },
    { type: "message", ts: 8, message: msg({ id: "done1", seq: 2, type: "worker_done", to: "run", dispatchId: "d1", outcome: "succeeded", body: "고쳤다" }) },
    { type: "report_accepted", ts: 9, dispatchId: "d1", outcome: "succeeded", summary: "고쳤다", filesModified: ["auth.ts"] },
    { type: "dispatch_settled", ts: 10, dispatchId: "d1" },
  ];
  const s = replayRun(events)!;
  assert.equal(s.tasks[0].status, "succeeded");
  assert.equal(s.tasks[0].attempts, 1);
  assert.deepEqual(s.tasks[0].outcome?.filesModified, ["auth.ts"]);
  assert.equal(s.dispatches[0].status, "settled");
  assert.equal(s.messages.find((m) => m.id === "q1")?.answer?.body, "예");
  assert.equal(attention(s).questions.length, 0);
  assert.equal(runSettled(s), true);
  assert.equal(runSummary(createI18n("ko").t, s), "1/1 완료");
  assert.equal(s.revision, events.length - 1);
});

test("delivery: 미전달 인박스 → Delivery → ack, epoch 가 바뀌면 이전 Delivery 는 pending 이 아니다", () => {
  let s = replayRun([{ type: "run_created", ts: 1, run }])!;
  s = reduceRun(s, { type: "message", ts: 2, message: msg({ id: "m1", seq: 1, type: "escalation", to: "run" }) });
  s = reduceRun(s, { type: "message", ts: 3, message: msg({ id: "f1", seq: 2, type: "followup", to: "dispatch:d1", from: { kind: "user" } }) });
  s = reduceRun(s, { type: "message", ts: 4, message: msg({ id: "m2", seq: 3, type: "note", to: "run", from: { kind: "app" } }) });
  assert.deepEqual(undeliveredInbox(s).map((m) => m.id), ["m1", "m2"]);
  s = reduceRun(s, { type: "delivery_created", ts: 5, delivery: { id: "dl1", runId: "r1", consumerEpoch: 1, messageIds: ["m1", "m2"], deliveredAt: 5 } });
  assert.equal(s.deliveredSeq, 3);
  assert.deepEqual(undeliveredInbox(s), []);
  assert.equal(pendingDelivery(s)?.id, "dl1");
  s = reduceRun(s, { type: "delivery_acked", ts: 6, deliveryId: "dl1" });
  assert.equal(pendingDelivery(s), null);
  s = reduceRun(s, { type: "delivery_created", ts: 7, delivery: { id: "dl2", runId: "r1", consumerEpoch: 1, messageIds: [], deliveredAt: 7 } });
  s = reduceRun(s, { type: "message", ts: 8, message: msg({ id: "m3", seq: 4, type: "worker_done", to: "run", outcome: "succeeded" }) });
  s = reduceRun(s, { type: "delivery_created", ts: 9, delivery: { id: "dl3", runId: "r1", consumerEpoch: 1, messageIds: ["m3"], deliveredAt: 9 } });
  s = reduceRun(s, { type: "coordinator_changed", ts: 10, coordinator: { kind: "user", epoch: 2, key: "k2" } });
  assert.equal(pendingDelivery(s), null, "epoch 1 의 미확인 Delivery 는 새 소비자의 것이 아니다");
  assert.deepEqual(undeliveredInbox(s).map((m) => m.id), ["m3"], "확인되지 않은 배치의 메시지는 새 소비자에게 다시 전달된다");
});

test("worker inbox: follow-up 은 check cursor 이후만, abandon 은 task 를 abandoned 로", () => {
  let s = replayRun([{ type: "run_created", ts: 1, run }, { type: "task_created", ts: 2, task }, { type: "dispatch_created", ts: 3, dispatch: disp }])!;
  s = reduceRun(s, { type: "message", ts: 4, message: msg({ id: "f1", seq: 1, type: "followup", to: "dispatch:d1", from: { kind: "user" }, body: "테스트 추가해" }) });
  s = reduceRun(s, { type: "message", ts: 5, message: msg({ id: "f2", seq: 2, type: "followup", to: "dispatch:d1", from: { kind: "user" }, body: "그리고 문서도" }) });
  assert.deepEqual(unreadFollowups(s, "d1").map((m) => m.id), ["f1", "f2"]);
  // check 가 seq 1 까지 돌려줬다(전달) — 명시적 ack 전엔 계속 unread. worker_done 을 막는 건 한 번도 전달 안 된 것만
  s = reduceRun(s, { type: "dispatch_check", ts: 6, dispatchId: "d1", seq: 1 });
  assert.deepEqual(unreadFollowups(s, "d1").map((m) => m.id), ["f1", "f2"]);
  assert.deepEqual(undeliveredFollowups(s, "d1").map((m) => m.id), ["f2"]);
  s = reduceRun(s, { type: "dispatch_check", ts: 7, dispatchId: "d1", seq: 2 });
  assert.deepEqual(unreadFollowups(s, "d1").map((m) => m.id), ["f1", "f2"], "ack 없이는 그대로");
  assert.deepEqual(undeliveredFollowups(s, "d1"), []);
  s = reduceRun(s, { type: "dispatch_check", ts: 8, dispatchId: "d1", seq: 2, ack: 2 });
  assert.deepEqual(unreadFollowups(s, "d1"), [], "ack 뒤엔 비어 있다");
  s = reduceRun(s, { type: "dispatch_check", ts: 9, dispatchId: "d1", seq: 2, ack: 99 });
  assert.equal(s.dispatches[0].lastCheckSeq, 2, "전달한 것보다 큰 ack 는 전달 범위로 잘린다");
  s = reduceRun(s, { type: "dispatch_abandoned", ts: 7, dispatchId: "d1", reason: "보고 없이 종료" });
  assert.equal(s.dispatches[0].status, "abandoned");
  assert.equal(s.tasks[0].status, "abandoned");
  assert.equal(s.tasks[0].activeDispatchId, null);
});

test("dispatch_stage failed 는 task 를 pending 으로 되돌린다", () => {
  let s = replayRun([{ type: "run_created", ts: 1, run }, { type: "task_created", ts: 2, task }, { type: "dispatch_created", ts: 3, dispatch: disp }])!;
  assert.equal(s.tasks[0].status, "running");
  s = reduceRun(s, { type: "dispatch_stage", ts: 4, dispatchId: "d1", stage: "failed", error: "worktree 실패" });
  assert.equal(s.dispatches[0].status, "failed_to_start");
  assert.equal(s.dispatches[0].startError, "worktree 실패");
  assert.equal(s.tasks[0].status, "pending");
  assert.equal(s.tasks[0].activeDispatchId, null);
});

test("buildWorkerPrompt: ID·명령·spec 이 정확히 들어간다", () => {
  const p = buildWorkerPrompt(createI18n("ko").t, { cli: "sudal", run, task, dispatch: { ...disp, worktree: { repo: "/repo", path: "/wt", branch: "sudal/x", base: "main" } } });
  assert.match(p, /--run r1 --dispatch d1 --capability cap1/);
  assert.match(p, /orch ask .* --resume <message_id>/);
  assert.match(p, /orch send .* --type worker_done --outcome succeeded\|failed/);
  assert.match(p, /consumer_fenced/);
  assert.match(p, /격리 worktree, 브랜치 sudal\/x/);
  assert.ok(p.endsWith("=== Task ===\nauth.ts 의 500 고치기"));
});

test("정산은 Task 의 활성 시도를 풀고(실패 재시도 가능), abandon 뒤 늦은 stage 는 되살리지 않는다", () => {
  let s = replayRun([{ type: "run_created", ts: 1, run }, { type: "task_created", ts: 2, task }, { type: "dispatch_created", ts: 3, dispatch: disp }, { type: "dispatch_stage", ts: 4, dispatchId: "d1", stage: "started" }])!;
  s = reduceRun(s, { type: "report_accepted", ts: 5, dispatchId: "d1", outcome: "failed", summary: "못 함" });
  assert.equal(s.tasks[0].activeDispatchId, "d1");
  s = reduceRun(s, { type: "dispatch_settled", ts: 6, dispatchId: "d1" });
  assert.equal(s.tasks[0].status, "failed");
  assert.equal(s.tasks[0].activeDispatchId, null);
  assert.equal(runSettled(s), true);
  let s2 = replayRun([{ type: "run_created", ts: 1, run }, { type: "task_created", ts: 2, task }, { type: "dispatch_created", ts: 3, dispatch: disp }])!;
  s2 = reduceRun(s2, { type: "dispatch_abandoned", ts: 4, dispatchId: "d1", reason: "취소" });
  s2 = reduceRun(s2, { type: "dispatch_stage", ts: 5, dispatchId: "d1", stage: "started" });
  assert.equal(s2.dispatches[0].status, "abandoned");
  // reported 는 아직 열린 시도
  let s3 = replayRun([{ type: "run_created", ts: 1, run }, { type: "task_created", ts: 2, task }, { type: "dispatch_created", ts: 3, dispatch: disp }, { type: "dispatch_stage", ts: 4, dispatchId: "d1", stage: "started" }, { type: "report_accepted", ts: 5, dispatchId: "d1", outcome: "succeeded", summary: "됨" }])!;
  assert.equal(runSettled(s3), false);
});

test("taskWaves / resolveGroup", () => {
  const t2: OrchTask = { ...task, id: "t2", seq: 2, deps: ["t1"] };
  const t3: OrchTask = { ...task, id: "t3", seq: 3, deps: ["t1", "t2"] };
  const t4: OrchTask = { ...task, id: "t4", seq: 4 };
  let s = replayRun([{ type: "run_created", ts: 1, run }, { type: "task_created", ts: 2, task }, { type: "task_created", ts: 3, task: t2 }, { type: "task_created", ts: 4, task: t3 }, { type: "task_created", ts: 5, task: t4 }])!;
  assert.deepEqual([...taskWaves(s).entries()], [["t1", 1], ["t2", 2], ["t3", 3], ["t4", 1]]);
  s = reduceRun(s, { type: "dispatch_created", ts: 6, dispatch: { ...disp, status: "live" } });
  s = reduceRun(s, { type: "dispatch_created", ts: 7, dispatch: { ...disp, id: "d2", taskId: "t4", tabId: "tab2", provider: "codex", status: "live" } });
  assert.deepEqual(resolveGroup(s, "@all")!.map((d) => d.id), ["d1", "d2"]);
  assert.deepEqual(resolveGroup(s, "@codex")!.map((d) => d.id), ["d2"]);
  assert.deepEqual(resolveGroup(s, "@idle"), []);
  assert.equal(resolveGroup(s, "dispatch:d1"), null);
});
