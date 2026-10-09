import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyEvent } from "@shared/chat-events";
import { VerifyRunner, suggestForCwd } from "./verify";

const waitDone = (events: VerifyEvent[], runId: string, ms = 10_000) =>
  new Promise<VerifyEvent>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const done = events.find((e) => e.runId === runId && e.status !== "running" && !e.partial);
      if (done) resolve(done);
      else if (Date.now() - started > ms) reject(new Error("timeout"));
      else setTimeout(tick, 50);
    };
    tick();
  });

test("VerifyRunner: 명령을 순서대로 돌리고 실패하면 뒤는 건너뛴다; 출력 꼬리·exit code 기록", async () => {
  const events: VerifyEvent[] = [];
  const runner = new VerifyRunner((_tab, e) => events.push(e));
  const cwd = mkdtempSync(join(tmpdir(), "verify-"));
  // Windows 는 cmd.exe 로 돈다 — ; 는 명령 구분자가 아니다
  const failing = process.platform === "win32" ? "echo err 1>&2 & exit 3" : "echo err >&2; exit 3";
  const r = await runner.start({ tabId: "t1", cwd, commands: ["echo one", failing, "echo never"], env: { ...process.env } });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(runner.running("t1"), r.runId);
  const done = await waitDone(events, r.runId);
  assert.equal(done.status, "failed");
  assert.deepEqual(done.commands.map((c) => c.status), ["passed", "failed", "skipped"]);
  assert.equal(done.commands[0].output?.trim(), "one");
  assert.equal(done.commands[1].exitCode, 3);
  assert.match(done.commands[1].output ?? "", /err/);
  assert.equal(typeof done.commands[0].durationMs, "number");
  assert.equal(done.head, null, "git 레포가 아니면 head 는 null");
  assert.equal(runner.running("t1"), null);
  // 첫 이벤트는 running + 전부 pending (기록용)
  assert.equal(events[0].status, "running");
  assert.deepEqual(events[0].commands.map((c) => c.status), ["pending", "pending", "pending"]);
});

test("VerifyRunner: abort 하면 진행 중 명령이 aborted 로 끝나고 나머지도 aborted", async () => {
  const events: VerifyEvent[] = [];
  const runner = new VerifyRunner((_tab, e) => events.push(e));
  const cwd = mkdtempSync(join(tmpdir(), "verify-"));
  const r = await runner.start({ tabId: "t1", cwd, commands: ["sleep 30", "echo after"], env: { ...process.env } });
  assert.ok(r.ok);
  if (!r.ok) return;
  const dup = await runner.start({ tabId: "t1", cwd, commands: ["echo x"], env: { ...process.env } });
  assert.equal(dup.ok, false, "같은 탭에 두 번은 거부");
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(runner.abort("t1"), true);
  const done = await waitDone(events, r.runId);
  assert.equal(done.status, "aborted");
  assert.deepEqual(done.commands.map((c) => c.status), ["aborted", "aborted"]);
  assert.equal(runner.abort("t1"), false);
});

test("suggestForCwd: 디렉토리의 매니페스트를 읽는다", () => {
  const cwd = mkdtempSync(join(tmpdir(), "verify-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  writeFileSync(join(cwd, "yarn.lock"), "");
  assert.deepEqual(suggestForCwd(cwd), ["yarn test"]);
});
