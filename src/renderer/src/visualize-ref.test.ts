import { test } from "node:test";
import assert from "node:assert/strict";
import { findVisualizeRefs } from "./visualize-ref";

const marker = (data: unknown) => `\uE200visualize\uE202${JSON.stringify(data)}\uE201`;
test("finds complete Windows and POSIX HTML previews without losing surrounding text", () => {
  const first = marker({ path: "C:/프로젝트/시안.html", mode: "wide", title: "작업 시안" });
  const text = `앞 ${first} 뒤 ${marker({ path: "/work/demo.htm" })}`;
  const refs = findVisualizeRefs(text);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].title, "작업 시안");
  assert.equal(text.slice(refs[0].start, refs[0].end), first);
});
test("rejects remote URLs, network paths, executable files and invalid payloads", () => {
  for (const path of ["https://example.com/a.html", "//server/a.html", "\\\\server\\a.html", "C:/a.exe", "relative.html", "C:/a\n.html"]) {
    assert.deepEqual(findVisualizeRefs(marker({ path })), []);
  }
  assert.deepEqual(findVisualizeRefs("\uE200visualize\uE202{bad}\uE201"), []);
  assert.deepEqual(findVisualizeRefs("\uE200visualize\uE202{\"path\":"), []);
  assert.deepEqual(findVisualizeRefs(marker(null)), []);
});
