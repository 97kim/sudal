import test from "node:test";
import assert from "node:assert/strict";
import { runPrecheckCommand } from "./precheck";
import { readPrecheck } from "@shared/scheduler-decide";
import { createI18n } from "@shared/i18n";

const t = createI18n("ko").t;

const run = (command: string, timeoutMs = 5000) =>
  runPrecheckCommand({ command, timeoutMs, cwd: null, env: process.env });

test("종료 코드 0 이면 실행한다", async () => {
  const r = await run("exit 0");
  assert.equal(r.exitCode, 0);
  assert.equal(readPrecheck(t, r).kind, "run");
});

test("1 은 조건 불충족, 그 밖은 고장", async () => {
  assert.equal(readPrecheck(t, await run("exit 1")).kind, "skip");
  assert.equal(readPrecheck(t, await run("exit 3")).kind, "failed");
  const missing = await run("존재하지않는명령어_xyz");
  assert.notEqual(missing.exitCode, 0);
  assert.equal(readPrecheck(t, missing).kind, "failed", "명령이 없으면 고장이다");
});

test("출력을 꼬리만 남긴다", async () => {
  const r = await run("printf 'hello'; printf 'oops' 1>&2");
  assert.match(r.stdout, /hello/);
  assert.match(r.stderr, /oops/);
});

test("시간을 넘기면 죽이고, 종료 코드로 읽지 않는다", async () => {
  const r = await run("sleep 5", 1000);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null, "우리가 죽인 것을 종료 코드로 읽으면 안 된다");
  assert.equal(readPrecheck(t, r).kind, "failed");
  assert.ok(r.durationMs < 4000, `${r.durationMs}ms`);
});

test("자식이 만든 프로세스도 같이 정리한다", async () => {
  // 손자가 살아남으면 파일이 나중에 생긴다. 죽었으면 안 생긴다.
  const marker = `/tmp/sudal-precheck-${Date.now()}`;
  const r = await run(`( sleep 2; touch ${marker} ) & sleep 5`, 800);
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 2500));
  const fs = await import("node:fs");
  assert.equal(fs.existsSync(marker), false, "손자 프로세스가 살아남았다");
});
