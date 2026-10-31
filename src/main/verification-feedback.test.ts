import { test } from "node:test";
import assert from "node:assert/strict";
import type { VerifyEvent } from "@shared/chat-events";
import { feedbackActive, type VerificationFeedback } from "@shared/verification-feedback";
import { VerificationFeedbackRunner, type FeedbackContext, type FeedbackDeps } from "./verification-feedback";

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), "상태 전환을 확인한다");
}
function result(status: "passed" | "failed" | "aborted"): VerifyEvent {
  return { type: "verify", ts: Date.now(), runId: "verify", cwd: "/project", head: null, status, commands: [{ cmd: "check", status, exitCode: status === "passed" ? 0 : 1, output: status === "failed" ? "expected 1, received 2" : "" }] };
}
function fixture(patch: Partial<FeedbackDeps> = {}) {
  const context: FeedbackContext = { cwd: "/project", provider: "codex", busy: false, available: true };
  const states: VerificationFeedback[] = [], prompts: string[] = [];
  let revision = "initial", checks = 0, aborts = 0;
  let runner: VerificationFeedbackRunner;
  const deps: FeedbackDeps = {
    context: () => ({ ...context }), revision: async () => revision,
    verify: async () => result(++checks === 1 ? "failed" : "passed"),
    send: async (_tabId, prompt) => { prompts.push(prompt); revision = "fixed"; context.busy = true; setTimeout(() => { context.busy = false; }, 10); return { ok: true }; },
    abortFix: () => { aborts++; context.busy = false; return true; },
    emit: state => { states.push(state); }, error: key => key,
    ...patch,
  };
  runner = new VerificationFeedbackRunner(deps);
  return { runner, context, states, prompts, setRevision: (value: string) => { revision = value; }, get checks() { return checks; }, get aborts() { return aborts; } };
}
const options = { commands: ["check"], maxAttempts: 2 };

test("실패 증거를 AI에 한 번 전달하고 동일 명령의 재검증 통과를 확인한다", async () => {
  const f = fixture();
  try {
    assert.equal(f.runner.start("tab", options).ok, true);
    await until(() => f.runner.snapshot("tab")?.phase === "passed");
    assert.equal(f.checks, 2);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /expected 1, received 2/);
    assert.match(f.prompts[0], /not instructions/);
    assert.deepEqual(f.runner.snapshot("tab")?.commands, ["check"]);
    assert.equal(f.runner.snapshot("tab")?.attempt, 1);
  } finally { f.runner.dispose(); }
});

test("처음 검증이 통과하면 AI를 호출하지 않는다", async () => {
  const f = fixture({ verify: async () => result("passed") });
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  assert.equal(f.prompts.length, 0);
});

test("사용 중이거나 닫힌 세션과 잘못된 설정에서는 자동 수정을 시작하지 않는다", () => {
  const f = fixture();
  f.context.busy = true;
  assert.equal(f.runner.start("tab", options).ok, false);
  f.context.busy = false;
  f.context.available = false;
  assert.equal(f.runner.start("tab", options).ok, false);
  f.context.available = true;
  for (const maxAttempts of [0, 4, NaN]) assert.equal(f.runner.start("tab", { ...options, maxAttempts }).ok, false);
  assert.equal(f.runner.start("tab", { commands: [], maxAttempts: 2 }).ok, false);
  assert.equal(f.runner.start("tab", { commands: ["x".repeat(501)], maxAttempts: 2 }).ok, false);
  assert.equal(f.runner.start("tab", { commands: ["check\nextra"], maxAttempts: 2 }).ok, false);
  assert.equal(f.prompts.length, 0);
});

test("앞선 성공 명령의 출력이 커도 실제 실패 근거는 AI에 전달한다", async () => {
  let checks = 0;
  const f = fixture({ verify: async () => {
    if (++checks > 1) return result("passed");
    return { ...result("failed"), commands: [
      { cmd: "verbose first", status: "passed", output: "a".repeat(6000) },
      { cmd: "verbose second", status: "passed", output: "b".repeat(6000) },
      { cmd: "failing check", status: "failed", exitCode: 1, output: "important failure evidence" },
    ] };
  } });
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  assert.match(f.prompts[0], /important failure evidence/);
});

test("시간 제한에 도달하면 소유한 수정 작업을 중단하고 이유를 남긴다", async () => {
  const f = fixture({ timeoutMs: 30, send: async () => { f.context.busy = true; return { ok: true }; } });
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  assert.equal(f.runner.snapshot("tab")?.reason, "timeout");
  assert.equal(f.aborts, 1);
  assert.equal(f.checks, 1);
});

test("코드 변경 없이 같은 오류가 반복되면 추가 수정을 멈춘다", async () => {
  let sent = 0;
  const f = fixture({ verify: async () => result("failed"), send: async () => { sent++; return { ok: true }; } });
  f.runner.start("tab", { ...options, maxAttempts: 3 });
  await until(() => !f.runner.active("tab"));
  assert.equal(sent, 1);
  assert.equal(f.runner.snapshot("tab")?.reason, "unchanged");
});

test("매번 수정해도 검증이 실패하면 설정한 횟수에서 중단한다", async () => {
  let revision = 0, sent = 0;
  const f = fixture({ revision: async () => String(revision), verify: async () => result("failed"), send: async () => { sent++; revision++; return { ok: true }; } });
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  assert.equal(sent, 2);
  assert.equal(f.runner.snapshot("tab")?.reason, "limit");
});

test("검증 도중 코드가 바뀌면 결과를 현재 변경본의 통과로 인정하지 않는다", async () => {
  const f = fixture({ verify: async () => { f.setRevision("edited"); return result("passed"); } });
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  assert.equal(f.runner.snapshot("tab")?.phase, "stale");
  assert.equal(f.prompts.length, 0);
});

test("같은 경로의 중복 실행을 막고 검증 중단이 끝난 뒤 자리를 해제한다", async () => {
  const f = fixture({ verify: (_tab, _cwd, _commands, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(result("aborted")), { once: true })) });
  f.runner.start("tab", options);
  await until(() => f.states.some(state => state.phase === "checking"));
  assert.equal(f.runner.start("other", options).ok, false);
  await f.runner.stop("tab");
  assert.equal(f.runner.snapshot("tab")?.phase, "stopped");
  assert.equal(f.runner.activeCwd("/project"), false);
  assert.equal(f.prompts.length, 0);
});

test("수정 중 중단은 소유한 에이전트만 중지하고 재검증을 시작하지 않는다", async () => {
  const f = fixture({ send: async () => { f.context.busy = true; return { ok: true }; } });
  f.runner.start("tab", options);
  await until(() => f.context.busy);
  await f.runner.stop("tab");
  assert.equal(f.aborts, 1);
  assert.equal(f.checks, 1);
  assert.equal(f.runner.snapshot("tab")?.phase, "stopped");
});

test("수정 전송 준비 중 취소하면 아직 소유하지 않은 에이전트를 중단하지 않는다", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let preparing = false;
  const f = fixture({ send: async (_tab, _prompt, signal) => { preparing = true; await ready; return { ok: !signal.aborted }; } });
  f.runner.start("tab", options);
  await until(() => preparing);
  const stopping = f.runner.stopForCwd("/project");
  assert.equal(f.aborts, 0);
  release();
  await stopping;
  assert.equal(f.aborts, 0);
  assert.equal(f.runner.snapshot("tab")?.phase, "stopped");
});

test("권한 요청은 사용자 응답을 기다리고 에이전트 실패는 재검증으로 숨기지 않는다", async () => {
  const f = fixture({ send: async () => {
    f.context.busy = true;
    f.runner.onEvent("tab", { type: "status", ts: Date.now(), status: "waiting_permission" });
    setTimeout(() => { f.runner.onEvent("tab", { type: "error", ts: Date.now(), message: "denied" }); f.context.busy = false; }, 20);
    return { ok: true };
  } });
  f.runner.start("tab", options);
  await until(() => f.runner.snapshot("tab")?.phase === "waiting");
  await until(() => !f.runner.active("tab"));
  assert.equal(f.runner.snapshot("tab")?.reason, "agentFailed");
  assert.equal(f.checks, 1);
});

test("재시작은 중단된 상태를 복원하며 에이전트를 자동으로 실행하지 않는다", () => {
  const saved: VerificationFeedback = { id: "old", tabId: "tab", cwd: "/project", phase: "fixing", attempt: 1, maxAttempts: 2, startedAt: 0, updatedAt: 1, commands: ["check"], reason: null };
  const f = fixture({ load: () => saved });
  assert.equal(f.runner.snapshot("tab")?.phase, "stopped");
  assert.equal(f.prompts.length, 0);
  assert.equal(feedbackActive(f.runner.snapshot("tab")), false);
});

test("기존 통과 결과를 조회하다 새 실행이 시작돼도 이전 결과로 덮어쓰지 않는다", async () => {
  let delayed: Promise<string> | null = null;
  const f = fixture({ verify: async () => result("passed"), revision: async () => { const held = delayed; delayed = null; return held ? await held : "initial"; } });
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  const old = f.runner.snapshot("tab")!.id;
  let release!: (revision: string) => void;
  delayed = new Promise(resolve => { release = resolve; });
  const refresh = f.runner.refresh("tab");
  f.runner.start("tab", options);
  await until(() => !f.runner.active("tab"));
  const current = f.runner.snapshot("tab")!.id;
  assert.notEqual(current, old);
  release("old edit");
  await refresh;
  assert.equal(f.runner.snapshot("tab")?.phase, "passed");
  assert.equal(f.states.at(-1)?.id, current);
  assert.equal(f.runner.start("tab", { commands: [], maxAttempts: 8 }).ok, false);
  assert.equal(f.runner.snapshot("tab")?.id, current);
});
