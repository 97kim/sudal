import { test } from "node:test";
import assert from "node:assert/strict";
import { basenameAny, dirnameAny, isAbsoluteAny, isUnderAny, joinAny, relativeAny, samePath, trimSep } from "./any-path";
import { formatShortcut } from "./shortcut";

test("any-path: macOS·Windows 표기 모두", () => {
  assert.equal(isAbsoluteAny("/a/b"), true);
  assert.equal(isAbsoluteAny("C:\\a"), true);
  assert.equal(isAbsoluteAny("c:/a"), true);
  assert.equal(isAbsoluteAny("\\\\srv\\share"), true);
  assert.equal(isAbsoluteAny("a\\b"), false);
  assert.equal(trimSep("/"), "/");
  assert.equal(trimSep("C:\\"), "C:\\");
  assert.equal(trimSep("C:\\a\\"), "C:\\a");
  assert.equal(basenameAny("C:\\a\\b.ts"), "b.ts");
  assert.equal(basenameAny("/a/b/"), "b");
  assert.equal(dirnameAny("C:\\a\\b.ts"), "C:\\a");
  assert.equal(dirnameAny("C:\\a"), "C:\\");
  assert.equal(dirnameAny("/a"), "/");
  assert.equal(dirnameAny("/a/b"), "/a");
  assert.equal(joinAny("C:\\a", "docs/x.png"), "C:\\a\\docs\\x.png");
  assert.equal(joinAny("/a/", "x"), "/a/x");
  assert.equal(joinAny("C:/a", "x"), "C:/a/x");
});

test("any-path: 비교는 구분자·Windows 대소문자를 가리지 않는다", () => {
  assert.equal(samePath("C:\\Repo\\a.ts", "c:/repo/a.ts"), true);
  assert.equal(samePath("/Repo/a", "/repo/a"), false);
  assert.equal(isUnderAny("C:/repo/src/a.ts", "C:\\repo"), true);
  assert.equal(isUnderAny("C:\\repo2\\a", "C:\\repo"), false);
  assert.equal(isUnderAny("/a/b", "/"), true);
  assert.equal(relativeAny("C:\\repo\\src\\a.ts", "C:/repo"), "src/a.ts");
  assert.equal(relativeAny("/x", "/repo"), null);
});

test("formatShortcut: macOS 기호, 그 밖은 Ctrl+", () => {
  assert.equal(formatShortcut("Mod+Shift+A", true), "⌘⇧A");
  assert.equal(formatShortcut("Mod+Shift+A", false), "Ctrl+Shift+A");
  assert.equal(formatShortcut("Mod+Alt+Left", false), "Ctrl+Alt+←");
  assert.equal(formatShortcut("Mod+Enter", true), "⌘↩");
});
