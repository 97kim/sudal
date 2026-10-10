import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeExecutableFor, launchSpec, parseCmdShimTarget, quoteCmdArg, resolvePtyCommand } from "./cli-launch";

// npm cmd-shim 이 만드는 실제 모양(node 로 도는 .js 대상)
const NODE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

// 네이티브 바이너리를 가리키는 shim
const EXE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

const SHIM = "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";

test("parseCmdShimTarget: node.exe 는 실행기라 건너뛰고 마지막 %dp0% 대상을 shim 폴더 기준 절대 경로로", () => {
  assert.equal(parseCmdShimTarget(NODE_SHIM, SHIM), "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
  assert.equal(parseCmdShimTarget(EXE_SHIM, SHIM), "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
  // 옛 형식(%~dp0)
  assert.equal(parseCmdShimTarget('@"%~dp0\\node_modules\\x\\cli.js" %*', SHIM), "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\x\\cli.js");
  assert.equal(parseCmdShimTarget("@echo off\r\nnode something %*", SHIM), null);
});

test("launchSpec: macOS 와 .exe 는 그대로", () => {
  assert.deepEqual(launchSpec("/usr/local/bin/codex", ["--version"], "darwin", () => null), { command: "/usr/local/bin/codex", args: ["--version"] });
  // macOS 에서는 .cmd 라는 이름도 손대지 않는다
  assert.deepEqual(launchSpec("/x/codex.cmd", ["a"], "darwin", () => NODE_SHIM), { command: "/x/codex.cmd", args: ["a"] });
  assert.deepEqual(launchSpec("C:\\bin\\claude.exe", ["a"], "win32", () => null), { command: "C:\\bin\\claude.exe", args: ["a"] });
});

test("launchSpec: win32 .cmd 는 shim 대상(.js 는 node, .exe 는 직접), 못 읽으면 인용해 cmd.exe 로", () => {
  assert.deepEqual(launchSpec(SHIM, ["app-server"], "win32", () => NODE_SHIM), {
    command: "node",
    args: ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "app-server"],
  });
  assert.deepEqual(launchSpec(SHIM, ["--version"], "win32", () => EXE_SHIM), {
    command: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    args: ["--version"],
  });
  assert.deepEqual(launchSpec("C:\\Program Files\\x\\codex.BAT", ['a "b"'], "win32", () => null), {
    command: '"C:\\Program Files\\x\\codex.BAT"',
    args: ['"a ""b"""'],
    shell: true,
  });
});

test("quoteCmdArg: 따옴표로 감싸고 안의 따옴표는 두 번", () => {
  assert.equal(quoteCmdArg("a&b"), '"a&b"');
  assert.equal(quoteCmdArg('x"y'), '"x""y"');
});

test("claudeExecutableFor: .cmd 는 .exe·.js 대상만, 못 찾으면 null", () => {
  assert.equal(claudeExecutableFor("/Users/me/.local/bin/claude", "darwin", () => null), "/Users/me/.local/bin/claude");
  assert.equal(claudeExecutableFor("C:\\Users\\me\\.local\\bin\\claude.exe", "win32", () => null), "C:\\Users\\me\\.local\\bin\\claude.exe");
  assert.equal(claudeExecutableFor(SHIM, "win32", () => EXE_SHIM), "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
  assert.equal(claudeExecutableFor(SHIM, "win32", () => NODE_SHIM), "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
  // SDK 는 .cjs 를 node 로 돌리지 않는다
  assert.equal(claudeExecutableFor(SHIM, "win32", () => '"%dp0%\\x\\cli.cjs" %*'), null);
  assert.equal(claudeExecutableFor(SHIM, "win32", () => null), null);
});

test("launchSpec: npm shim 옆에 node.exe 가 있으면 그것으로 띄운다", () => {
  const spec = launchSpec(SHIM, ["a"], "win32", () => NODE_SHIM, (p) => p.toLowerCase().endsWith("\\npm\\node.exe"));
  assert.match(spec.command, /\\npm\\node\.exe$/i);
});

test("resolvePtyCommand: node-pty 가 못 찾는 상대 이름을 탭 PATH 에서 Windows 규칙대로 절대 경로로", () => {
  const files = new Set(["C:\\nvm\\v22\\node.exe", "C:\\Windows\\System32\\cmd.exe", "C:\\Custom Node\\node.exe", "C:\\a\\tool.com", "C:\\b\\tool.exe"]);
  const has = (p: string) => files.has(p);
  const env = (PATH: string, extra: NodeJS.ProcessEnv = {}) => ({ Path: PATH, ...extra });
  assert.equal(resolvePtyCommand("node", env("C:\\nvm\\v22;C:\\Windows\\System32"), "win32", has), "C:\\nvm\\v22\\node.exe");
  assert.equal(resolvePtyCommand("cmd.exe", env("C:\\nvm\\v22;C:\\Windows\\System32"), "win32", has), "C:\\Windows\\System32\\cmd.exe");
  // 따옴표로 감싼 항목, %VAR% 항목
  assert.equal(resolvePtyCommand("node", env('"C:\\Custom Node"'), "win32", has), "C:\\Custom Node\\node.exe");
  assert.equal(resolvePtyCommand("node", env("%NVM%", { NVM: "C:\\nvm\\v22" }), "win32", has), "C:\\nvm\\v22\\node.exe");
  // 폴더 순서가 먼저다(앞 폴더의 .com 이 뒤 폴더의 .exe 보다 먼저)
  assert.equal(resolvePtyCommand("tool", env("C:\\a;C:\\b"), "win32", has), "C:\\a\\tool.com");
  // 상대 경로·드라이브 없는 항목은 건너뛴다
  assert.equal(resolvePtyCommand("node", env(".\\tools"), "win32", () => true), "node");
  assert.equal(resolvePtyCommand("node", env("\\tools"), "win32", () => true), "node");
  // 폴더 이름의 % 는 그대로 쓴다
  assert.equal(resolvePtyCommand("node", env("C:\\100%\\Node"), "win32", (p) => p === "C:\\100%\\Node\\node.exe"), "C:\\100%\\Node\\node.exe");
  // 이미 절대 경로거나 못 찾으면 그대로(node-pty 가 이유를 알린다), macOS 는 손대지 않는다
  assert.equal(resolvePtyCommand("C:\\x\\claude.exe", env("C:\\nvm\\v22"), "win32", has), "C:\\x\\claude.exe");
  assert.equal(resolvePtyCommand("없음", env("C:\\nvm\\v22"), "win32", has), "없음");
  assert.equal(resolvePtyCommand("node", { PATH: "/usr/bin" }, "darwin", () => true), "node");
});

