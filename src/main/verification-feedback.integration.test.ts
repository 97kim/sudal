import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { VerifyEvent } from "@shared/chat-events";
import { VerificationFeedbackRunner } from "./verification-feedback";
import { VerificationFeedbackStore } from "./verification-feedback-store";
import { verificationRevision } from "./verification-revision";
import { VerifyRunner } from "./verify";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "sudal-feedback-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", join(dir, "state"));
  writeFileSync(join(dir, ".gitignore"), "ignored.log\nstate/\n");
  writeFileSync(join(dir, "value.cjs"), "module.exports = false;\n");
  writeFileSync(join(dir, "check.cjs"), "if(require('./value.cjs')!==true){console.error('expected true, received false');process.exit(1)}\n");
  git("add", "."); git("commit", "-qm", "테스트 초기 상태");
  const cleanup = async () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("sudal-feedback-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { dir, cleanup };
}

test("실제 명령 실패 → 진단 전달 → 파일 수정 → 같은 명령 통과와 상태 복원을 확인한다", { timeout: 15000 }, async () => {
  const { dir, cleanup } = project();
  const events: VerifyEvent[] = [];
  const store = new VerificationFeedbackStore(join(dir, "state"));
  let prompts = 0;
  const runner = new VerificationFeedbackRunner({
    context: () => ({ cwd: dir, provider: "codex", busy: false, available: true }),
    revision: verificationRevision,
    verify: async (tabId, cwd, commands, signal) => {
      let finish!: (event: VerifyEvent) => void;
      const done = new Promise<VerifyEvent>(resolve => { finish = resolve; });
      const verifier = new VerifyRunner((_tabId, event) => { if (!event.partial && event.status !== "running") { events.push(event); finish(event); } });
      const abort = () => { verifier.abort(tabId); };
      signal.addEventListener("abort", abort);
      try {
        const started = await verifier.start({ tabId, cwd, commands, env: process.env });
        assert.equal(started.ok, true);
        return await done;
      } finally { signal.removeEventListener("abort", abort); verifier.dispose(); }
    },
    send: async (_tabId, prompt) => {
      prompts++;
      assert.match(prompt, /expected true, received false/);
      writeFileSync(join(dir, "value.cjs"), "module.exports = true;\n");
      return { ok: true };
    },
    abortFix: () => false, emit() {}, error: key => key,
    save: state => store.save(state), load: tabId => store.load(tabId),
  });
  try {
    assert.equal(runner.start("tab", { commands: ["node check.cjs"], maxAttempts: 2 }).ok, true);
    const end = Date.now() + 10000;
    while (runner.active("tab") && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runner.snapshot("tab")?.phase, "passed", JSON.stringify(runner.snapshot("tab")));
    assert.deepEqual(events.map(event => event.status), ["failed", "passed"]);
    assert.equal(prompts, 1);
    assert.equal(store.load("tab")?.phase, "passed");
    writeFileSync(join(dir, "value.cjs"), "module.exports = false;\n");
    await runner.refresh("tab");
    assert.equal(runner.snapshot("tab")?.phase, "stale", "검증 후 다시 바뀐 코드는 이전 통과로 표시하지 않는다");
  } finally { runner.dispose(); await cleanup(); }
});

test("변경본 지문은 dirty 상태가 같아도 파일 내용·untracked 변경을 구분하고 Git 무시 파일은 제외한다", async () => {
  const { dir, cleanup } = project();
  try {
    const initial = await verificationRevision(dir);
    writeFileSync(join(dir, "ignored.log"), "runtime output");
    assert.equal(await verificationRevision(dir), initial);
    writeFileSync(join(dir, "value.cjs"), "module.exports = 1;\n");
    const dirty = await verificationRevision(dir);
    writeFileSync(join(dir, "value.cjs"), "module.exports = 2;\n");
    assert.notEqual(await verificationRevision(dir), dirty);
    writeFileSync(join(dir, "new.cjs"), "first");
    const untracked = await verificationRevision(dir);
    writeFileSync(join(dir, "new.cjs"), "second");
    assert.notEqual(await verificationRevision(dir), untracked);
    mkdirSync(join(dir, "sub"));
    assert.equal(await verificationRevision(join(dir, "sub")), await verificationRevision(dir), "하위 작업 경로도 저장소 전체 변경본을 검사한다");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(verificationRevision(dir, controller.signal), "변경본 검사도 중단 신호를 따른다");
  } finally { await cleanup(); }
});

test("손상된 피드백 저장 데이터는 화면에 넘기지 않는다", async () => {
  const { dir, cleanup } = project();
  try {
    const store = new VerificationFeedbackStore(dir);
    const invalid = { id: "old", tabId: "tab", cwd: dir, phase: "passed", attempt: 1, maxAttempts: 2, startedAt: 0, updatedAt: 1, reason: null, commands: ["check"], verification: { runId: "old", status: "passed", commands: {} } };
    writeFileSync(join(dir, Buffer.from("tab").toString("base64url") + ".json"), JSON.stringify(invalid));
    assert.equal(store.load("tab"), null);
  } finally { await cleanup(); }
});
