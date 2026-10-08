import { test } from "node:test";
import assert from "node:assert/strict";
import { findFileRefs, localFileHref, parseFileRef } from "./file-refs";

test("parseFileRef: 파일명·경로·줄·범위를 읽고, 전체가 참조가 아니면 null", () => {
  assert.deepEqual(parseFileRef("ProductByPoController.kt:63"), { path: "ProductByPoController.kt", line: 63 });
  assert.deepEqual(parseFileRef(" application.yml:3 "), { path: "application.yml", line: 3 });
  assert.deepEqual(parseFileRef("src/main/index.ts"), { path: "src/main/index.ts" });
  assert.deepEqual(parseFileRef("./src/a.ts:12-20"), { path: "./src/a.ts", line: 12, endLine: 20 });
  assert.deepEqual(parseFileRef("../lib/x.py:5–7"), { path: "../lib/x.py", line: 5, endLine: 7 });
  assert.deepEqual(parseFileRef("/Users/me/dev/app/Foo.java:10:4"), { path: "/Users/me/dev/app/Foo.java", line: 10 });
  assert.deepEqual(parseFileRef("README.md#L12-L20"), { path: "README.md", line: 12, endLine: 20 });
  assert.deepEqual(parseFileRef("foo.test.ts:3-1"), { path: "foo.test.ts", line: 3 }, "끝줄이 시작보다 앞이면 버린다");
  assert.deepEqual(parseFileRef("Node.js"), { path: "Node.js" }, "모양만 보면 통과 — 존재 확인이 거른다");
});

test("parseFileRef: 파일이 아닌 것들", () => {
  for (const s of ["e.g.", "v1.2.3", "foo@bar.com", "1.5", "hello", "foo.ts and bar.ts", "https://a.com/x.ts", "x.unknownext"])
    assert.equal(parseFileRef(s), null, s);
});

test("findFileRefs: 문장 속 참조를 위치와 함께 찾고 URL·이메일·버전은 건너뛴다", () => {
  const text =
    "구현: ProductByPoController.kt:63 참고. /pims는 application.yml:3의 context path입니다. " +
    "(src/main/index.ts) 와 `a/b.tsx:1-2`, https://example.com/path/file.ts 는 링크, me@host.com, v2.0.1, e.g. 끝에 README.md.";
  const refs = findFileRefs(text);
  assert.deepEqual(
    refs.map((r) => [r.text, r.path, r.line ?? null, r.endLine ?? null]),
    [
      ["ProductByPoController.kt:63", "ProductByPoController.kt", 63, null],
      ["application.yml:3", "application.yml", 3, null],
      ["src/main/index.ts", "src/main/index.ts", null, null],
      ["a/b.tsx:1-2", "a/b.tsx", 1, 2],
      ["README.md", "README.md", null, null],
    ],
  );
  for (const r of refs) assert.equal(text.slice(r.start, r.end), r.text);
});

test("findFileRefs: 이름만 있는 Node.js 같은 것도 모양으로는 걸린다(존재 확인이 거른다)", () => {
  assert.deepEqual(findFileRefs("Node.js 런타임").map((r) => r.text), ["Node.js"]);
  assert.deepEqual(findFileRefs("").length, 0);
});

test("localFileHref: 로컬 경로·file URL·~·상대 경로는 참조로, 웹·mailto·앵커는 null", () => {
  assert.deepEqual(localFileHref("/Users/me/dev/AGENTS.md"), { path: "/Users/me/dev/AGENTS.md" });
  assert.deepEqual(localFileHref("file:///Users/me/dev/A%20B.md#L12-L20"), { path: "/Users/me/dev/A B.md", line: 12, endLine: 20 });
  assert.deepEqual(localFileHref("~/dev/x.ts:7"), { path: "~/dev/x.ts", line: 7 });
  assert.deepEqual(localFileHref("./src/a.ts"), { path: "./src/a.ts" });
  assert.deepEqual(localFileHref("../lib/no-extension"), { path: "../lib/no-extension" }, "명시적 경로는 확장자 없어도 받는다");
  assert.deepEqual(localFileHref("src/main/index.ts:12"), { path: "src/main/index.ts", line: 12 });
  assert.deepEqual(localFileHref("AGENTS.md"), { path: "AGENTS.md" });
  assert.deepEqual(localFileHref("AGENTS.md:3"), { path: "AGENTS.md", line: 3 });
  for (const s of ["https://a.com/x.ts", "mailto:a@b.com", "#section", "vscode://file/x", "hello", ""]) assert.equal(localFileHref(s), null, s);
});

test("findFileRefs·localFileHref: Windows 경로(드라이브·\\ 구분자·file:///C:/)", () => {
  const text = "수정: C:\\Users\\me\\dev\\src\\main\\index.ts:12 와 src\\shared\\a.ts, ..\\b\\c.md 를 봤어요. https://x.com/a.ts 는 링크.";
  assert.deepEqual(
    findFileRefs(text).map((r) => [r.path, r.line ?? null]),
    [
      ["C:\\Users\\me\\dev\\src\\main\\index.ts", 12],
      ["src\\shared\\a.ts", null],
      ["..\\b\\c.md", null],
    ],
  );
  assert.deepEqual(parseFileRef("C:/repo/a.ts:3-4"), { path: "C:/repo/a.ts", line: 3, endLine: 4 });
  assert.deepEqual(localFileHref("C:\\repo\\AGENTS.md"), { path: "C:\\repo\\AGENTS.md" });
  assert.deepEqual(localFileHref("C:\\repo\\no-extension:5"), { path: "C:\\repo\\no-extension", line: 5 });
  assert.deepEqual(localFileHref("file:///C:/repo/A%20B.md#L3"), { path: "C:/repo/A B.md", line: 3 });
  assert.deepEqual(localFileHref(".\\src\\a.ts"), { path: ".\\src\\a.ts" });
  assert.deepEqual(localFileHref("src\\a.ts:2"), { path: "src\\a.ts", line: 2 });
});
