import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import { createI18n } from "@shared/i18n";
import { eventsToMarkdown, exportFileName, makeSnippet, searchEvents } from "./transcript-search";

const events: ChatEvent[] = [
  { type: "user_message", ts: 1, id: "u1", text: "로그인 버그를 고쳐줘" },
  { type: "text_delta", ts: 2, blockId: "b1", text: "네, 로그인 " },
  { type: "text_delta", ts: 2, blockId: "b1", text: "코드를 봅니다." },
  { type: "tool_use", ts: 3, toolUseId: "t1", name: "Read", input: { file_path: "/a/login.ts" } },
  { type: "tool_result", ts: 4, toolUseId: "t1", output: "x".repeat(2000), isError: false },
  { type: "assistant_text", ts: 5, blockId: "b2", text: "고쳤습니다." },
  {
    type: "turn_result", ts: 6,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.01, durationMs: 1500, numTurns: 1, modelUsage: {}, isError: false,
  },
];

test("searchEvents: 대소문자 무시, 스트리밍 조각 합쳐서 검색, 블록당 1건", () => {
  const hits = searchEvents(events, "로그인");
  assert.deepEqual(hits.map((h) => [h.blockId, h.kind]), [["u1", "user"], ["b1", "assistant"]]);
  assert.equal(hits[1].snippet, "네, 로그인 코드를 봅니다.");
  assert.deepEqual(searchEvents(events, "  "), []);
  assert.deepEqual(searchEvents(events, "없는말"), []);
  assert.equal(searchEvents(events, "고쳤")[0].blockId, "b2");
});

test("makeSnippet: 앞뒤 생략 표시", () => {
  const t = "a".repeat(100) + "핵심" + "b".repeat(100);
  const s = makeSnippet(t, 100, 2, 5);
  assert.equal(s, "…aaaaa핵심bbbbb…");
});

test("eventsToMarkdown: 제목·메타·역할 헤더·툴 출력 자르기·턴 통계", () => {
  const md = eventsToMarkdown(createI18n("ko").t, events, { title: "로그인 수정", workspace: "kop", provider: "Claude Code", cwd: "/a", exportedAt: 0 });
  assert.match(md, /^# 로그인 수정\n/);
  assert.match(md, /- 워크스페이스: kop\n- provider: Claude Code\n- 경로: \/a/);
  assert.match(md, /## 사용자 · .*\n\n로그인 버그를 고쳐줘/);
  assert.match(md, /## Claude Code\n\n네, 로그인 코드를 봅니다\./);
  assert.match(md, /> 🔧 Read — \/a\/login\.ts/);
  assert.match(md, /… \(500자 생략\)/);
  assert.match(md, /_1\.5s · in 10 \/ out 5 · \$0\.0100_/);
  assert.ok(!/\n{3,}/.test(md));
});

test("exportFileName: 금지 문자 제거 + 날짜", () => {
  assert.match(exportFileName("a/b:c?", Date.UTC(2026, 8, 6, 12)), /^a b c 2026-09-0[67]\.md$/);
  assert.match(exportFileName("", 0), /^session /);
});

test("collectTexts/searchEvents: 툴 호출의 이름·입력 요약·출력도 찾고, 블록 id 는 toolUseId", async () => {
  const { searchEvents, collectTexts, TOOL_TEXT_MAX } = await import("./transcript-search");
  const events = [
    { type: "tool_use", ts: 1, toolUseId: "tu1", name: "Bash", input: { command: "grep -rn needle src", description: "needle 찾기" } },
    { type: "tool_result", ts: 2, toolUseId: "tu1", output: "src/a.ts:3: const needle = 1\n" + "x".repeat(TOOL_TEXT_MAX + 50), isError: false },
    { type: "tool_use", ts: 3, toolUseId: "tu2", name: "Read", input: { file_path: "/repo/README.md" }, partial: true },
    { type: "tool_use", ts: 3, toolUseId: "tu2", name: "Read", input: { file_path: "/repo/README.md" } },
  ] as never[];
  const blocks = collectTexts(events as never);
  assert.deepEqual(blocks.map((b) => [b.blockId, b.kind]), [["tu1", "tool"], ["tu2", "tool"]]);
  assert.ok(blocks[0].text.length <= TOOL_TEXT_MAX + 100, "출력은 상한에서 자른다");
  assert.deepEqual(searchEvents(events as never, "needle 찾기").map((h) => h.blockId), ["tu1"], "입력 요약(description)");
  assert.deepEqual(searchEvents(events as never, "const needle").map((h) => h.blockId), ["tu1"], "출력 본문");
  assert.deepEqual(searchEvents(events as never, "readme.md").map((h) => [h.blockId, h.kind]), [["tu2", "tool"]], "부분 입력은 무시, 최종 입력만");
});

test("export consumes events lazily and preserves tool omission counts and late revisions", () => {
  const meta = { title: "Long output", provider: "Codex", exportedAt: 0 };
  const translate = createI18n("ko").t;
  const output = "```" + "x".repeat(1496) + "😀" + "z".repeat(2 * 1024 * 1024);
  function* stream(): Iterable<ChatEvent> {
    yield { type: "text_delta", blockId: "older", ts: 1, text: "old partial" };
    yield { type: "tool_result", toolUseId: "command", ts: 2, output, isError: true };
    yield { type: "tool_use", toolUseId: "command", ts: 2, name: "Bash", input: { command: "first line\nsecond line" } };
    yield { type: "assistant_text", blockId: "older", ts: 3, text: "complete assistant text" };
    yield { type: "tool_result", toolUseId: "blank", ts: 4, output: " ".repeat(5000), isError: false };
  }
  const md = eventsToMarkdown(translate, stream(), meta);
  assert.match(md, /complete assistant text[\s\S]*Bash — first line/);
  assert.ok(md.includes("'''" + "x".repeat(1496) + "\ud83d"));
  assert.ok(md.includes(translate("repo.export.truncated", { count: output.length - 1500 })));
  assert.doesNotMatch(md, /old partial|second line|z{20}/);
  assert.equal(md.match(/생략/g)?.length, 1, "space-only output does not produce a truncation notice");
});
