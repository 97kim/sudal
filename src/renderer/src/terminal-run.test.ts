import { test } from "node:test";
import assert from "node:assert/strict";
import { canDeliver, forgetTerminalGate, scanTerminalOutput, isShellLanguage, normalizeCommand, noteDelivered, notePrompt, onTerminalRun, peekTerminalRun, pendingTerminalRuns, pickShellTarget, promptEpoch, requestTerminalRun, takeTerminalRun } from "./terminal-run";

test("터미널 실행 요청: 탭별 FIFO 로 쌓이고, 꺼내면 순서대로 나오고, 오래된 것은 버린다", () => {
  let fired = 0;
  const off = onTerminalRun(() => fired++);
  requestTerminalRun("t", { command: "ls", run: false }, 1000);
  requestTerminalRun("t", { command: "pwd", run: true }, 1000);
  assert.equal(fired, 2);
  assert.equal(pendingTerminalRuns("t", 1000), 2);
  assert.deepEqual(peekTerminalRun("t", 1000), { command: "ls", run: false }, "peek 는 꺼내지 않는다");
  assert.deepEqual(takeTerminalRun("t", 1000), { command: "ls", run: false });
  assert.deepEqual(takeTerminalRun("t", 1000), { command: "pwd", run: true });
  assert.equal(takeTerminalRun("t", 1000), null);
  assert.equal(takeTerminalRun("other", 1000), null);
  requestTerminalRun("t", { command: "old", run: false }, 1000);
  assert.equal(peekTerminalRun("t", 1000 + 10_001), null, "10초 넘게 기다린 요청은 버린다");
  off();
});

test("normalizeCommand: 끝 개행·앞 빈 줄을 떼고 CRLF 를 LF 로", () => {
  assert.equal(normalizeCommand("ls -la\n"), "ls -la");
  assert.equal(normalizeCommand("\n\nyarn test\n\n  "), "yarn test");
  assert.equal(normalizeCommand("a\r\nb\r\n"), "a\nb");
  assert.equal(normalizeCommand("  indented"), "  indented", "앞 공백은 둔다(heredoc 등)");
});

test("isShellLanguage: bash·sh·zsh·shell 만", () => {
  assert.equal(isShellLanguage("language-bash hljs"), true);
  assert.equal(isShellLanguage("hljs language-sh"), true);
  assert.equal(isShellLanguage("language-zsh"), true);
  assert.equal(isShellLanguage("language-shell"), true);
  assert.equal(isShellLanguage("language-typescript"), false);
  assert.equal(isShellLanguage("language-console"), false, "출력이 섞인 console 은 뺀다");
  assert.equal(isShellLanguage(undefined), false);
});

test("isShellLanguage: Windows 는 PowerShell·cmd 블록만(bash 는 복사만)", () => {
  assert.equal(isShellLanguage("language-powershell", true), true);
  assert.equal(isShellLanguage("hljs language-pwsh", true), true);
  assert.equal(isShellLanguage("language-ps1", true), true);
  assert.equal(isShellLanguage("language-cmd", true), true);
  assert.equal(isShellLanguage("language-bat", true), true);
  assert.equal(isShellLanguage("language-bash", true), false);
  assert.equal(isShellLanguage("language-powershell"), false);
});

test("pickShellTarget: 포커스가 셸이면 그것, CLI 탭이면 마지막 셸, 셸이 없으면 null", () => {
  const tabs = [
    { id: "a:t1", kind: "shell" as const },
    { id: "a:cli", kind: "command" as const },
    { id: "a:t2", kind: "shell" as const },
  ];
  assert.equal(pickShellTarget(tabs, "a:t1"), "a:t1");
  assert.equal(pickShellTarget(tabs, "a:cli"), "a:t2");
  assert.equal(pickShellTarget(tabs, null), "a:t2");
  assert.equal(pickShellTarget([{ id: "a:cli", kind: "command" }], "a:cli"), null);
});

test("프롬프트 세대: 넣은 뒤에는 새 프롬프트가 나와야 다시 넣을 수 있고, 터미널을 잊으면 초기화된다", () => {
  assert.equal(canDeliver("x"), true, "처음엔 된다");
  notePrompt("x");
  noteDelivered("x", promptEpoch("x"));
  assert.equal(canDeliver("x"), false, "넣은 뒤 아직 실행 안 됨");
  notePrompt("x");
  assert.equal(canDeliver("x"), true, "새 프롬프트가 왔다");
  noteDelivered("x", promptEpoch("x"));
  assert.equal(canDeliver("x"), false);
  forgetTerminalGate("x");
  assert.equal(canDeliver("x"), true);
  assert.equal(promptEpoch("x"), 0);
});

test("scanTerminalOutput: 청크 경계에 걸린 프롬프트 시퀀스도 세고, 나머지 출력은 세지 않는다", () => {
  forgetTerminalGate("s");
  scanTerminalOutput("s", "hello\x1b[?2004h$ ");
  assert.equal(promptEpoch("s"), 1);
  scanTerminalOutput("s", "out\x1b[?20");
  scanTerminalOutput("s", "04h$ ");
  assert.equal(promptEpoch("s"), 2, "둘로 쪼개져 와도 하나로 센다");
  scanTerminalOutput("s", "\x1b[?2004l\x1b[?1049h");
  assert.equal(promptEpoch("s"), 2, "끄기·다른 모드는 아니다");
  scanTerminalOutput("s", "\x1b[?2004h\x1b[?2004h");
  assert.equal(promptEpoch("s"), 4);
  scanTerminalOutput("s", "\x1b[?1;2004h\x1b[?2004;1h\x1b[?20041h");
  assert.equal(promptEpoch("s"), 6, "파라미터가 여럿이어도 2004 가 있으면 세고, 20041 은 아니다");
  scanTerminalOutput("s", "\x1b[?1;2");
  scanTerminalOutput("s", "004h");
  assert.equal(promptEpoch("s"), 7, "여러 파라미터가 쪼개져 와도");
  let fired = 0;
  const off = onTerminalRun(() => fired++);
  scanTerminalOutput("s", "\x1b[?2004h");
  assert.equal(fired, 1, "프롬프트가 오면 패널을 깨운다");
  off();
});
