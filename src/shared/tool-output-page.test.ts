import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_OUTPUT_PAGE_CHARS, toolOutputPage } from "./tool-output-page";

test("can read all of an enormous single-line tool result without rendering it at once", () => {
  const output = "x".repeat(TOOL_OUTPUT_PAGE_CHARS * 4 + 31);
  const pages = Array.from({ length: 5 }, (_, i) => toolOutputPage(output, i));
  assert.equal(pages[0].total, 5);
  assert.ok(pages.every(p => p.text.length <= TOOL_OUTPUT_PAGE_CHARS));
  assert.equal(pages.map(p => p.text).join(""), output);
  assert.equal(toolOutputPage(output, 100).index, 4);
});

test("pagination does not split a surrogate pair", () => {
  const output = "abc😀def😎df";
  assert.deepEqual([0, 1, 2].map(i => toolOutputPage(output, i, 4).text), ["abc", "😀def", "😎df"]);
});
