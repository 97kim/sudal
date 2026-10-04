import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexApprovalDetector, detectCodexApproval, stripAnsi } from "./codex-approval";

test("stripAnsi: 색·커서·OSC 시퀀스를 지우고 글자만 남긴다", () => {
  assert.equal(stripAnsi("\x1b[1;33mAllow\x1b[0m \x1b[2K\x1b[HCodex\x1b]0;title\x07 to"), "Allow Codex to");
});

test("detectCodexApproval: 명령·파일·권한·도구 프롬프트와 답함을 구분하고, 가장 뒤 것을 고른다", () => {
  const r1 = detectCodexApproval("… Allow Codex to run `git push origin main`? Yes No", 5);
  assert.deepEqual(r1, { kind: "prompt", attention: { kind: "permission", tool: "명령 실행", summary: "git push origin main", since: 5 } });
  const r2 = detectCodexApproval("Codex wants to edit src/main.ts\n  Apply proposed file edits", 5);
  assert.equal(r2?.kind === "prompt" && r2.attention.summary, "src/main.ts");
  assert.equal(detectCodexApproval("Yes, grant these permissions for this turn")?.kind, "prompt");
  const r3 = detectCodexApproval("Run the tool and continue. Always allow");
  assert.equal(r3?.kind === "prompt" && r3.attention.tool, "도구 실행");
  assert.deepEqual(detectCodexApproval("Allow Codex to run `ls`  … Approved action: ls"), { kind: "answered" });
  // 0.153 실기기 캡처(ANSI 제거 후): 헤더 뒤 모델이 쓴 Reason, 그 다음 "$ 명령", 선택지
  const real =
    "• Running touch /Users/me/sudal-approval-probe .    Would you like to run the following command?   Environment: local   Reason: 샌드박스가 홈 디렉터리 쓰기를 차단했습니다. 승인하시겠습니까?   $ touch /Users/me/sudal-approval-probe . › 1. Yes, proceed (y)  2. Yes, and don't ask again for commands that start with `touch /Users/me/sudal-     approval-probe .` (p)  3. No, and tell Codex what to do differently (esc)   Press enter to confirm or esc to cancel";
  const r4 = detectCodexApproval(real, 7);
  assert.deepEqual(r4, { kind: "prompt", attention: { kind: "permission", tool: "명령 실행", summary: "touch /Users/me/sudal-approval-probe .", since: 7 } });
  // 박스 문자·줄바꿈이 끼어도 같다
  const boxed = "Would you like to run the following command?\n│ $ git push origin main\n│ › 1. Yes, proceed (y)\n│   3. No (esc)\n Press enter to confirm or esc to cancel";
  assert.equal((detectCodexApproval(boxed) as { attention: { summary: string } }).attention.summary, "git push origin main");
  // 문구가 바뀌어도 선택지 틀로 잡는다
  const r5 = detectCodexApproval("Something new?\n › 1. Yes, proceed (y)\n   2. No (esc)\n Press enter to confirm or esc to cancel");
  assert.equal(r5?.kind === "prompt" && r5.attention.tool, "승인 요청");
  assert.equal(detectCodexApproval("그냥 평범한 출력 allow codex"), null);
});

test("CodexApprovalDetector: 청크 경계를 넘어 이어 붙이고, 한 번 보고한 프롬프트는 다시 보고하지 않는다", () => {
  const d = new CodexApprovalDetector();
  assert.equal(d.push("\x1b[33mAllow Codex to ru"), null);
  const s = d.push("n `npm test`\x1b[0m?");
  assert.equal(s?.kind === "prompt" && s.attention.summary, "npm test");
  assert.equal(d.push(" (y/n)"), null, "같은 프롬프트의 나머지 출력은 무시");
  assert.equal(d.push("Approved action: npm test")?.kind, "answered");
  // 이스케이프 시퀀스가 청크 경계에서 잘려도(pty 는 임의 바이트에서 자른다) 놓치지 않는다
  const d2 = new CodexApprovalDetector();
  const whole = "\x1b[33mAllow Codex to run \x1b[1m`npm test`\x1b[0m?";
  const cut = whole.indexOf("\x1b[1m") + 2;
  assert.equal(d2.push(whole.slice(0, cut)), null);
  const s2 = d2.push(whole.slice(cut));
  assert.equal(s2?.kind === "prompt" && s2.attention.summary, "npm test");
});

test("detectCodexApproval: 모델이 '$' 뒤에 공백을 잔뜩 찍어도 선형 시간에 끝난다(백트래킹 없음)", () => {
  const evil = "1. Yes, proceed (y) $" + " ".repeat(20000) + "no match here";
  const t = performance.now();
  for (let i = 0; i < 20; i++) detectCodexApproval(evil);
  assert.ok(performance.now() - t < 200, `too slow: ${performance.now() - t}ms`);
  // 관문 문구가 없으면 정규식을 아예 돌리지 않는다
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) detectCodexApproval("$" + " \t\n".repeat(8000));
  assert.ok(performance.now() - t2 < 200);
});
