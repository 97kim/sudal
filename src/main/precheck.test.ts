import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrecheckCommand, windowsPrecheckCommand, withoutErrorlevelVar } from "./precheck";
import { readPrecheck } from "@shared/scheduler-decide";
import { createI18n } from "@shared/i18n";

const t = createI18n("ko").t;
// 앱은 Windows 에서 선조건을 cmd.exe 로 돌린다. 러너 PATH 의 Git sleep·sh 에 기대지 않게 명령을 셸에 맞춘다.
const IS_WIN = process.platform === "win32";
const sleepCmd = (sec: number) => (IS_WIN ? `"${process.execPath}" -e "setTimeout(()=>{},${sec * 1000})"` : `sleep ${sec}`);

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
  // Windows 의 cmd.exe 는 없는 명령에 1 로 끝나 "조건 불충족" 으로 읽혔다 — windowsPrecheckCommand 가 9009 를 낸다
  assert.equal(readPrecheck(t, missing).kind, "failed", "명령이 없으면 고장이다");
  // exit 가 아니라 프로그램이 끝낸 코드도 그대로다(꼬리가 바꾸지 않는다)
  const node = (code: number) => `"${process.execPath}" -e "process.exit(${code})"`;
  assert.equal(readPrecheck(t, await run(node(0))).kind, "run");
  assert.equal(readPrecheck(t, await run(node(1))).kind, "skip");
  assert.equal((await run(node(3))).exitCode, 3);
  assert.equal((await run(`${node(1)} && echo never`)).exitCode, 1);
  assert.equal((await run(`${node(3)} || ${node(0)}`)).exitCode, 0);
  // 같은 이름의 환경 변수가 있어도 실제 종료 코드를 읽는다
  const r = await runPrecheckCommand({ command: "존재하지않는명령어_xyz", timeoutMs: 5000, cwd: null, env: { ...process.env, ERRORLEVEL: "0" } });
  assert.equal(readPrecheck(t, r).kind, "failed");
});

test("windowsPrecheckCommand: 따옴표 안이나 ^ 로 끝나면 꼬리를 붙이지 않고, 공백을 더하지 않는다", () => {
  assert.equal(windowsPrecheckCommand("echo hi"), "echo hi& call exit %^errorlevel%");
  assert.equal(windowsPrecheckCommand("echo hi  "), "echo hi  & call exit %^errorlevel%");
  assert.equal(windowsPrecheckCommand('node -e "process.exit(0)'), 'node -e "process.exit(0)');
  assert.equal(windowsPrecheckCommand("echo hi^"), "echo hi^");
  // 이스케이프된 따옴표는 따옴표가 아니다
  assert.equal(windowsPrecheckCommand('없는명령_xyz ^"'), '없는명령_xyz ^"& call exit %^errorlevel%');
  // 따옴표 안의 ^ 는 그냥 글자다
  assert.equal(windowsPrecheckCommand('echo "a^"'), 'echo "a^"& call exit %^errorlevel%');
  assert.deepEqual(Object.keys(withoutErrorlevelVar({ errorLevel: "1", PATH: "x" })), ["PATH"]);
});

test("출력을 꼬리만 남긴다", async () => {
  const r = await run(IS_WIN ? "echo hello& echo oops 1>&2" : "printf 'hello'; printf 'oops' 1>&2");
  assert.match(r.stdout, /hello/);
  assert.match(r.stderr, /oops/);
});

test("시간을 넘기면 죽이고, 종료 코드로 읽지 않는다", async () => {
  const r = await run(sleepCmd(5), 1000);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null, "우리가 죽인 것을 종료 코드로 읽으면 안 된다");
  assert.equal(readPrecheck(t, r).kind, "failed");
  assert.ok(r.durationMs < 4000, `${r.durationMs}ms`);
});

test("자식이 만든 프로세스도 같이 정리한다", async () => {
  // 손자가 살아남으면 파일이 나중에 생긴다. 죽었으면 안 생긴다.
  const marker = join(tmpdir(), `sudal-precheck-${Date.now()}`);
  // Windows: start /b 로 띄운 node 가 2초 뒤 파일을 만든다. taskkill /T 가 cmd 의 자손으로 함께 끝내야 한다.
  const later = `"${process.execPath}" -e "setTimeout(()=>require('fs').writeFileSync('${marker.replace(/\\/g, "/")}',''),2000)"`;
  const r = await run(IS_WIN ? `start /b "" ${later}& ${sleepCmd(5)}` : `( sleep 2; touch ${marker} ) & sleep 5`, 800);
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 2500));
  const fs = await import("node:fs");
  assert.equal(fs.existsSync(marker), false, "손자 프로세스가 살아남았다");
});
