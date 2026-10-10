import { test } from "node:test";
import assert from "node:assert/strict";
import { basenameAny, dirnameAny, isAbsoluteAny, isUnderAny, joinAny, relativeAny, sameCwd, sameCwdOrNull, samePath, trimSep } from "./any-path";
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

test("any-path: macOS 경로의 \\ 는 구분자가 아니라 이름의 글자다", () => {
  assert.equal(samePath("/repo/a\\b.ts", "/repo/a/b.ts"), false);
  assert.equal(basenameAny("/repo/a\\b.ts"), "a\\b.ts");
  assert.equal(dirnameAny("/repo/a\\b.ts"), "/repo");
  assert.equal(isUnderAny("/repo/a\\b.ts", "/repo/a"), false);
  // / 없이 \ 만 쓴 상대 경로는 Windows 표기로 본다
  assert.equal(basenameAny("src\\a.ts"), "a.ts");
});

test("sameCwd: 다른 프로그램이 적은 Windows 작업 경로를 대소문자·구분자·긴 경로 접두어와 상관없이 같게 본다", () => {
  assert.equal(sameCwd("C:\\Users\\김수달\\repo", "c:/users/김수달/repo/"), true);
  assert.equal(sameCwd("\\\\?\\C:\\Users\\a\\repo", "C:\\Users\\a\\repo"), true);
  assert.equal(sameCwd("C:\\Users\\a\\repo", "C:\\Users\\a\\repo2"), false);
  assert.equal(sameCwd("\\\\?\\UNC\\server\\share\\repo", "\\\\server\\share\\repo"), true);
  assert.equal(sameCwdOrNull(null, null), true);
  assert.equal(sameCwdOrNull("C:\\Repo", "c:/repo"), true);
  assert.equal(sameCwdOrNull(null, "C:\\Repo"), false);
  // macOS 경로는 대소문자를 구분한다(기존 동작)
  assert.equal(sameCwd("/Users/a/Repo", "/Users/a/repo"), false);
  assert.equal(sameCwd("/Users/a/repo/", "/Users/a/repo"), true);
});
