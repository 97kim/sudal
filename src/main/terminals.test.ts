import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalManager, defaultShell, trimBacklog } from "./terminals";
import { TERMINAL_CLEAR_MARK } from "@shared/ipc";

// Windows 에는 /bin/sh 가 없어(띄우면 ConPTY 가 끝나지 않아 테스트 프로세스가 멈췄다) 같은 일을 하는 명령으로 바꿔 끼운다.
const IS_WIN = process.platform === "win32";
const posixEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", SHELL: "/bin/sh" };
const shellEnv: Record<string, string> = IS_WIN
  ? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
  : posixEnv;
const sleepCmd = (sec: number) =>
  IS_WIN ? { file: process.execPath, args: ["-e", `setTimeout(() => {}, ${sec * 1000})`] } : { file: "/bin/sh", args: ["-c", `sleep ${sec}`] };
// HUP·TERM 을 무시해 kill() 뒤에도 한동안 사는 프로세스. Windows 에는 무시할 방법이 없어 곧 끝나지만,
// 밀려난 pty 의 exit 를 삼키는지는 그대로 확인된다.
const stubbornCmd = (sec: number) => (IS_WIN ? sleepCmd(sec) : { file: "/bin/sh", args: ["-c", `trap "" HUP TERM; sleep ${sec}`] });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("TerminalManager: 셸을 띄워 입출력하고, 재오픈은 기존 셸에 붙고, close 하면 exit 가 온다", async (t) => {
  const data: string[] = [];
  const exits: number[] = [];
  const tm = new TerminalManager({ onData: (_id, d) => data.push(d), onExit: (_id, code) => exits.push(code) });
  t.after(() => tm.closeAll()); // 중간에 실패해도 셸·pty 를 남기지 않는다
  const env = shellEnv;

  const r = tm.open("t1", process.cwd(), env, 80, 24);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.existing, false);
  if (IS_WIN) assert.match(r.shell ?? "", /pwsh|powershell|cmd/i);
  else assert.equal(r.shell, "/bin/sh");
  const isCmd = /cmd\.exe$/i.test(r.shell ?? "");

  // 프롬프트가 뜨기 전에 보낸 입력은 셸 초기화(rc 파일)에 먹힐 수 있어 첫 출력 후 잠시 기다린다.
  for (let i = 0; i < 200 && data.length === 0; i++) await wait(50);
  await wait(500);
  // 입력한 글자에는 계산 결과가 없다 — 출력에 있으면 셸이 실제로 계산한 것이다
  // (Windows 기본 셸은 PowerShell, 없으면 cmd — cmd 는 set /a 가 계산 결과를 찍는다. 프롬프트 경로와 겹치지 않을 긴 수를 쓴다)
  const input = !IS_WIN ? "echo PTY_$((6*7))\n" : isCmd ? "set /a 424242*1000+42\r" : 'Write-Output ("PTY_" + (6*7))\r';
  const expected = isCmd ? /424242042/ : /PTY_42/;
  assert.equal(tm.write("t1", input), true);
  for (let i = 0; i < 200 && !expected.test(data.join("")); i++) await wait(50); // 로그인 셸 기동 대기
  assert.match(data.join(""), expected);

  const again = tm.open("t1", process.cwd(), env, 100, 30);
  assert.equal(again.existing, true);
  assert.equal(again.pid, r.pid);

  tm.close("t1");
  for (let i = 0; i < 100 && exits.length === 0; i++) await wait(50);
  assert.equal(exits.length, 1);
  assert.equal(tm.has("t1"), false);
  assert.equal(tm.write("t1", "x"), false);
});

// 셸을 띄우기 전에 cwd 를 확인하고 돌아가므로 Windows 에서도 돈다
test("TerminalManager: 없는 cwd 는 ok:false 로 알린다", () => {
  const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
  const r = tm.open("t2", "/nonexistent/dir/for/test", { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" }, 80, 24);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /작업 경로가 없습니다/);
  assert.equal(tm.has("t2"), false);
});

test("TerminalManager: 셸을 CLI 로 바꾼 뒤 늦게 오는 옛 셸의 exit 는 알리지 않고, clearBacklog 는 다음 open 의 backlog 를 비운다", async (t) => {
  const exits: { id: string; kind: string }[] = [];
  const data: string[] = [];
  const tm = new TerminalManager({ onData: (_id, d) => data.push(d), onExit: (id, _code, kind) => exits.push({ id, kind }) });
  t.after(() => tm.closeAll()); // 중간에 실패해도 셸·pty 를 남기지 않는다
  const env = shellEnv;

  assert.equal(tm.open("t2", process.cwd(), env, 80, 24).ok, true);
  for (let i = 0; i < 200 && data.length === 0; i++) await wait(50);
  assert.ok(tm.open("t2", process.cwd(), env, 80, 24).backlog, "출력이 backlog 에 쌓인다");
  tm.clearBacklog("t2");
  assert.equal(tm.open("t2", process.cwd(), env, 80, 24).backlog, "", "clearBacklog 뒤에는 비어 있다");
  assert.equal(data[data.length - 1], TERMINAL_CLEAR_MARK, "지운 자리에 표시가 출력 스트림으로 온다");

  // 같은 id 로 CLI 를 띄우면 옛 셸이 죽지만, 그 exit 가 새 항목에 종료 표시를 붙이면 안 된다.
  const cli = sleepCmd(1);
  const r = tm.openCommand("t2", process.cwd(), env, cli.file, cli.args);
  assert.equal(r.ok, true, r.error);
  await wait(400);
  assert.deepEqual(exits, [], "옛 셸의 exit 는 삼킨다");
  assert.equal(tm.kindOf("t2"), "command");
  for (let i = 0; i < 100 && exits.length === 0; i++) await wait(50);
  assert.deepEqual(exits, [{ id: "t2", kind: "command" }], "CLI 가 끝나면 그 exit 는 온다");
});

test("TerminalManager: 밀려난 옛 pty 의 exit 가 새 pty 가 끝난 뒤에 와도 알리지 않는다", async (t) => {
  const exits: { id: string; kind: string }[] = [];
  const tm = new TerminalManager({ onData: () => {}, onExit: (id, _code, kind) => exits.push({ id, kind }) });
  t.after(() => tm.closeAll()); // 중간에 실패해도 셸·pty 를 남기지 않는다
  const env = IS_WIN ? shellEnv : { PATH: posixEnv.PATH, HOME: posixEnv.HOME };

  // HUP 를 무시하는 옛 프로세스: kill() 로는 안 죽고 sleep 이 끝나야 exit 가 온다.
  const old = stubbornCmd(1.5);
  assert.equal(tm.openCommand("t3", process.cwd(), env, old.file, old.args).ok, true);
  await wait(200);
  const next = sleepCmd(0.2);
  assert.equal(tm.openCommand("t3", process.cwd(), env, next.file, next.args).ok, true);
  for (let i = 0; i < 100 && exits.length === 0; i++) await wait(50);
  assert.deepEqual(exits, [{ id: "t3", kind: "command" }], "새 pty 의 exit 는 온다");
  await wait(2000);
  assert.deepEqual(exits, [{ id: "t3", kind: "command" }], "그 뒤에 온 옛 pty 의 exit 는 삼킨다");
});

test("TerminalManager: 끊은(close) 뒤 같은 id 로 새 CLI 를 띄우면, 옛 CLI 의 늦은 exit 는 알리지 않고 새 것의 exit 만 온다", async (t) => {
  const exits: { id: string; kind: string }[] = [];
  const tm = new TerminalManager({ onData: () => {}, onExit: (id, _code, kind) => exits.push({ id, kind }) });
  t.after(() => tm.closeAll()); // 중간에 실패해도 셸·pty 를 남기지 않는다
  const env = IS_WIN ? shellEnv : { PATH: posixEnv.PATH, HOME: posixEnv.HOME };

  const old = stubbornCmd(1.5);
  assert.equal(tm.openCommand("t4", process.cwd(), env, old.file, old.args).ok, true);
  await wait(200);
  tm.close("t4"); // 사용자가 끊었다 — HUP 를 무시하니 아직 살아 있다
  assert.equal(tm.has("t4"), false);
  const next = sleepCmd(0.2);
  assert.equal(tm.openCommand("t4", process.cwd(), env, next.file, next.args).ok, true);
  for (let i = 0; i < 100 && exits.length === 0; i++) await wait(50);
  assert.deepEqual(exits, [{ id: "t4", kind: "command" }], "새 CLI 의 exit 는 온다");
  await wait(2000);
  assert.deepEqual(exits, [{ id: "t4", kind: "command" }], "그 뒤에 온 옛 CLI 의 exit 는 삼킨다 — 세션 제어를 두 번 돌리지 않는다");
});

test("trimBacklog: 상한을 넘으면 줄 경계에서 자르고, 줄바꿈이 없으면 그냥 자른다", () => {
  const line = "\x1b[32mok\x1b[0m 0123456789\n"; // 색 시퀀스가 섞인 한 줄
  const many = line.repeat(30_000); // 상한을 넉넉히 넘는다
  const t = trimBacklog(many);
  assert.ok(t.length <= 500_000);
  assert.ok(t.startsWith("\x1b[32m"), "잘린 첫 줄이 온전한 줄로 시작한다");
  assert.equal(t.length % line.length, 0, "줄 단위로만 잘렸다");
  assert.equal(trimBacklog("짧다"), "짧다");
  const oneLine = "x".repeat(600_000);
  assert.equal(trimBacklog(oneLine).length, 500_000, "줄바꿈이 없으면 상한만큼 남긴다");
});

test("defaultShell: macOS 는 SHELL -l, Windows 는 PATH 의 pwsh → Windows PowerShell → COMSPEC", () => {
  assert.deepEqual(defaultShell("darwin", { SHELL: "/bin/bash" }, () => false), { file: "/bin/bash", args: ["-l"] });
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  // Git Bash 가 남긴 SHELL 은 무시한다
  const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", SHELL: "/usr/bin/bash" };
  assert.deepEqual(defaultShell("win32", env, (p) => p === pwsh || p === ps), { file: pwsh, args: [] });
  assert.deepEqual(defaultShell("win32", env, (p) => p === ps), { file: ps, args: [] });
  assert.deepEqual(defaultShell("win32", env, () => false), { file: "C:\\Windows\\system32\\cmd.exe", args: [] });
  assert.deepEqual(defaultShell("win32", {}, () => false), { file: "C:\\Windows\\System32\\cmd.exe", args: [] });
});
