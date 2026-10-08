import { test } from "node:test";
import assert from "node:assert/strict";
import { fileUri, resolveUnder } from "./doc-path";

test("resolveUnder: macOS 경로", () => {
  assert.equal(resolveUnder("/r/docs", "img/a.png"), "/r/docs/img/a.png");
  assert.equal(resolveUnder("/r/docs", "../a.png"), "/r/a.png");
  assert.equal(resolveUnder("/r", "./x/../../../a.png"), "/a.png", "루트 위로는 못 간다");
});

test("resolveUnder: Windows 경로는 드라이브와 구분자를 지킨다", () => {
  assert.equal(resolveUnder("C:\\r\\docs", "img/a.png"), "C:\\r\\docs\\img\\a.png");
  assert.equal(resolveUnder("C:\\r\\docs", "../../../a.png"), "C:\\a.png");
  assert.equal(resolveUnder("C:/r/docs", "../a.png"), "C:/r/a.png");
  assert.equal(resolveUnder("\\\\srv\\share\\d", "a.png"), "\\\\srv\\share\\d\\a.png");
});

test("fileUri", () => {
  assert.equal(fileUri("/a/b c.ts"), "file:///a/b%20c.ts");
  assert.equal(fileUri("/a/#x?.ts"), "file:///a/%23x%3F.ts");
  assert.equal(fileUri("C:\\a\\b.ts"), "file:///C:/a/b.ts");
  assert.equal(fileUri("C:/a/b.ts"), "file:///C:/a/b.ts");
  assert.equal(fileUri("\\\\srv\\share\\x.ts"), "file://srv/share/x.ts");
});
