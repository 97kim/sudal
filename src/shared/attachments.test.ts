import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "./i18n";
import { appendToDraft, fenceLang, formatCodeAttachment, formatOutputAttachment, formatTerminalAttachment } from "./attachments";

test("formatCodeAttachment: 경로:줄 머리말 + 언어 펜스, 범위·단일 줄, 본문에 ``` 가 있으면 긴 펜스", () => {
  assert.equal(formatCodeAttachment({ relPath: "src/a.ts", line: 12, endLine: 14, text: "const a = 1;\nconst b = 2;\n" }), "src/a.ts:12-14\n```ts\nconst a = 1;\nconst b = 2;\n```");
  assert.equal(formatCodeAttachment({ relPath: "README.md", line: 3, endLine: 3, text: "x" }), "README.md:3\n```md\nx\n```");
  assert.match(formatCodeAttachment({ relPath: "doc.md", line: 1, text: "```js\nfoo\n```" }), /^doc\.md:1\n````md\n/);
  assert.equal(fenceLang("Dockerfile"), "dockerfile");
  assert.equal(fenceLang("weird.unknown"), "");
  assert.equal(fenceLang("src\\main\\Dockerfile"), "dockerfile", "Windows 구분자");
  assert.equal(fenceLang("C:\\repo\\a.py"), "python");
});

test("formatTerminalAttachment / appendToDraft", () => {
  assert.equal(formatTerminalAttachment(createI18n("ko").t, { title: "셸", text: "$ yarn test\nError: boom\n\n", selection: false }), "터미널 셸 (최근 출력)\n```text\n$ yarn test\nError: boom\n```");
  assert.equal(appendToDraft("", "B"), "B\n");
  assert.equal(appendToDraft("고쳐줘  \n", "B"), "고쳐줘\n\nB\n");
});

test("formatOutputAttachment: 제목 + 텍스트 펜스", () => {
  assert.equal(formatOutputAttachment({ title: "검증 실패: yarn test (exit 1)", text: "1 failing\n\n" }), "검증 실패: yarn test (exit 1)\n```text\n1 failing\n```");
});
