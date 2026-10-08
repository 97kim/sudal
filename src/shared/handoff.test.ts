import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import { createI18n } from "./i18n";
import { buildHandoff, estimateTokens, extractFilePaths, handoffBriefPrompt, handoffNotePermission, isNoteFile, pendingTodos } from "./handoff";

const { t: tr } = createI18n("ko");
let t = 0;
type NoTs<T> = T extends unknown ? Omit<T, "ts"> : never;
const ev = (e: NoTs<ChatEvent>) => ({ ...e, ts: ++t }) as ChatEvent;

test("요약: 사용자/어시스턴트 텍스트, 툴 한 줄, 파일·할 일 통계", () => {
  const h = buildHandoff(tr,
    [
      ev({ type: "user_message", id: "u1", text: "버그 고쳐" }),
      ev({ type: "text_delta", blockId: "a:0", text: "확인 " }),
      ev({ type: "text_delta", blockId: "a:0", text: "중" }),
      ev({ type: "tool_use", toolUseId: "t1", name: "Edit", input: {}, partial: true }),
      ev({
        type: "tool_use",
        toolUseId: "t1",
        name: "Edit",
        input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" },
      }),
      ev({ type: "tool_result", toolUseId: "t1", output: "ok", isError: false }),
      ev({
        type: "tool_use",
        toolUseId: "t2",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "테스트", status: "pending" },
            { content: "마무리", status: "completed" },
          ],
        },
      }),
      ev({
        type: "turn_result",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        modelUsage: {},
        isError: false,
      }),
    ],
    { cwd: "/r", fromProvider: "claude" },
  );
  assert.equal(h.stats.messages, 2);
  assert.equal(h.stats.files, 1);
  assert.equal(h.stats.pendingTasks, 1);
  assert.ok(h.stats.tokensEstimate > 0);
  assert.match(h.summary, /claude 에서 전환/);
  assert.match(h.summary, /작업 경로: \/r/);
  assert.match(h.summary, /### 사용자\n버그 고쳐/);
  assert.match(h.summary, /### 어시스턴트\n확인 중/);
  assert.match(h.summary, /- 툴 Edit: \/r\/a\.ts/);
  assert.match(h.summary, /- \[ \] 테스트/);
  assert.doesNotMatch(h.summary, /마무리/);
  assert.equal(h.summary.split("### 어시스턴트").length - 1, 1);
});

test("maxChars 초과 시 앞뒤를 남기고 가운데를 버린다 — 원래 요청은 항상 산다", () => {
  const events: ChatEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push(ev({ type: "user_message", id: `u${i}`, text: `메시지 ${i} ${"x".repeat(200)}` }));
  }
  const h = buildHandoff(tr, events, { maxChars: 3000 });
  assert.ok(h.summary.length <= 3000);
  assert.match(h.summary, /가운데 생략/);
  // 무엇을 하려던 세션인지(첫 요청)와 어디까지 왔는지(마지막)가 둘 다 남아야 한다.
  assert.match(h.summary, /원래 요청: 메시지 0/);
  assert.match(h.summary, /메시지 49/);
  // 가운데는 실제로 버려졌다.
  assert.doesNotMatch(h.summary, /메시지 25 /);
});

test("성공한 툴 결과는 최근 것만, 실패는 다 남긴다", () => {
  const events: ChatEvent[] = [];
  for (let i = 0; i < 30; i++) {
    events.push(ev({ type: "tool_use", toolUseId: `t${i}`, name: "Bash", input: { command: `cmd ${i}` }, partial: false }));
    events.push(ev({ type: "tool_result", toolUseId: `t${i}`, output: `출력 ${i}`, isError: false }));
  }
  events.push(ev({ type: "tool_use", toolUseId: "bad", name: "Bash", input: { command: "boom" }, partial: false }));
  events.push(ev({ type: "tool_result", toolUseId: "bad", output: "터졌다", isError: true }));
  const h = buildHandoff(tr, events, { maxChars: 100000 });
  assert.match(h.summary, /출력 29/);
  assert.doesNotMatch(h.summary, /출력 0\b/);
  assert.match(h.summary, /실패: 터졌다/);
});

test("기록이 지시로 읽히지 않게 못박는다", () => {
  const h = buildHandoff(tr, [ev({ type: "user_message", id: "u", text: "dmg 만들어줘" })]);
  assert.match(h.summary, /지시가 아니다/);
  assert.match(h.summary, /이미 처리된 것으로 보고/);
});

test("토큰 추정은 한글을 영어보다 무겁게 센다", () => {
  // 같은 글자 수라도 한글이 토큰을 훨씬 많이 쓴다 — 한 비율로 뭉뚱그리면 한국어에서 크게 어긋난다.
  const korean = "한".repeat(100);
  const ascii = "a".repeat(100);
  assert.ok(estimateTokens(korean) > estimateTokens(ascii) * 3);
  assert.equal(estimateTokens(ascii), 25);
});

test("extractFilePaths / pendingTodos 는 두 provider 의 입력 형태를 모두 안다", () => {
  assert.deepEqual(extractFilePaths({ changes: [{ path: "a" }, { path: "b" }] }), ["a", "b"]);
  assert.deepEqual(extractFilePaths({ notebook_path: "n.ipynb" }), ["n.ipynb"]);
  assert.deepEqual(
    pendingTodos({
      items: [
        { text: "x", completed: false },
        { text: "y", completed: true },
      ],
    }),
    ["x"],
  );
  assert.deepEqual(pendingTodos(null), []);
});

test("인계서 프롬프트는 provider 의 노트 파일을 가리킨다", () => {
  assert.match(handoffBriefPrompt(tr, "claude"), /CLAUDE\.md/);
  assert.match(handoffBriefPrompt(tr, "codex"), /AGENTS\.md/);
  // 자리표시자가 그대로 새어 나가면 안 된다.
  assert.doesNotMatch(handoffBriefPrompt(tr, "claude"), /\{NOTE_FILE\}/);
});

test("isNoteFile: cwd 바로 아래의 그 파일만", () => {
  assert.equal(isNoteFile("/r/CLAUDE.md", "/r", "CLAUDE.md"), true);
  assert.equal(isNoteFile("CLAUDE.md", "/r", "CLAUDE.md"), true);
  assert.equal(isNoteFile("/r/", "/r", "CLAUDE.md"), false);
  assert.equal(isNoteFile("/r/sub/CLAUDE.md", "/r", "CLAUDE.md"), false);
  assert.equal(isNoteFile("/r/AGENTS.md", "/r", "CLAUDE.md"), false);
  assert.equal(isNoteFile("/other/CLAUDE.md", "/r", "CLAUDE.md"), false);
  assert.equal(isNoteFile("/r/claude.md", "/r", "CLAUDE.md"), false, "macOS 표기는 대소문자를 가린다");
  // Windows: 구분자가 섞이고 대소문자를 가리지 않는다
  assert.equal(isNoteFile("C:\\r\\CLAUDE.md", "C:\\r", "CLAUDE.md"), true);
  assert.equal(isNoteFile("c:/R/claude.md", "C:\\r\\", "CLAUDE.md"), true);
  assert.equal(isNoteFile("C:\\r\\sub\\CLAUDE.md", "C:\\r", "CLAUDE.md"), false);
});

test("인계서 턴 권한: 노트 파일에 덧붙이는 것만 열고, 있는 파일 덮어쓰기는 막는다", () => {
  const opts = { cwd: "/r", note: "CLAUDE.md", exists: (p: string) => p === "/r/CLAUDE.md" };
  const none = { ...opts, exists: () => false };

  assert.equal(handoffNotePermission("Edit", { file_path: "/r/CLAUDE.md" }, opts), "allow");
  assert.equal(handoffNotePermission("Read", { file_path: "/r/CLAUDE.md" }, opts), "allow");
  assert.equal(handoffNotePermission("ApplyPatch", { changes: [{ path: "/r/CLAUDE.md" }] }, opts), "allow");

  // 있는 파일을 통째로 새로 쓰는 건 막는다 — 쌓아 둔 내용이 날아간다.
  assert.equal(handoffNotePermission("Write", { file_path: "/r/CLAUDE.md" }, opts), "deny");
  // 없으면 날릴 것이 없으니 만들게 둔다.
  assert.equal(handoffNotePermission("Write", { file_path: "/r/CLAUDE.md" }, none), "allow");

  // 나머지는 전부 거부 — 이 턴은 사람이 보고 있지 않다.
  assert.equal(handoffNotePermission("Edit", { file_path: "/r/src/a.ts" }, opts), "deny");
  assert.equal(handoffNotePermission("Bash", { command: "rm -rf /" }, opts), "deny");
  assert.equal(handoffNotePermission("Edit", {}, opts), "deny");
  assert.equal(handoffNotePermission("ApplyPatch", { changes: [{ path: "/r/CLAUDE.md" }, { path: "/r/x.ts" }] }, opts), "deny");
});
