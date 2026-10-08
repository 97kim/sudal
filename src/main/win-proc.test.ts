import { test } from "node:test";
import assert from "node:assert/strict";
import { needsCmdShell, nodeCmdWrapper, taskkillArgs } from "./win-proc";

test("needsCmdShell: Windows 의 .cmd/.bat 만", () => {
  assert.equal(needsCmdShell("C:\\npm\\typescript-language-server.cmd", "win32"), true);
  assert.equal(needsCmdShell("C:\\x\\A.BAT", "win32"), true);
  assert.equal(needsCmdShell("C:\\x\\a.exe", "win32"), false);
  assert.equal(needsCmdShell("/usr/local/bin/x.cmd", "darwin"), false);
});

test("taskkillArgs: 트리째 강제 종료", () => {
  assert.deepEqual(taskkillArgs(42), ["/PID", "42", "/T", "/F"]);
});

test("nodeCmdWrapper: .cmd 안에서만 ELECTRON_RUN_AS_NODE 를 켜고 실행 파일을 큰따옴표로 감싼다", () => {
  const s = nodeCmdWrapper("C:\\Program Files\\Sudal\\Sudal.exe", `"%~dp0a.cjs"`, [`"%~dpn0.jsonl"`]);
  assert.equal(s, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\Sudal\\Sudal.exe" "%~dp0a.cjs" "%~dpn0.jsonl"\r\n`);
});
