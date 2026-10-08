import { test } from "node:test";
import assert from "node:assert/strict";
import { findOnPath, windowsExtraDirs } from "./cli-discovery";

test("findOnPath: macOS 는 PATH 순서대로 확장자 없이, 중복 제외", () => {
  const have = new Set(["/opt/homebrew/bin/claude", "/Users/a/.local/bin/claude"]);
  assert.deepEqual(findOnPath("claude", "/opt/homebrew/bin:/usr/bin:/Users/a/.local/bin:/opt/homebrew/bin", "darwin", (p) => have.has(p)), [
    "/opt/homebrew/bin/claude",
    "/Users/a/.local/bin/claude",
  ]);
});

test("findOnPath: win32 는 .exe 를 모두 앞에, 그다음 .cmd·.bat. 확장자 없는 sh 스크립트는 안 본다", () => {
  const have = new Set(
    [
      "C:\\Users\\a\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\a\\.local\\bin\\claude.exe",
      "C:\\tools\\claude.bat",
    ].map((p) => p.toLowerCase()),
  );
  const exists = (p: string) => have.has(p.toLowerCase());
  assert.deepEqual(findOnPath("claude", "C:\\Users\\a\\AppData\\Roaming\\npm;C:\\tools;C:\\Users\\a\\.local\\bin;c:\\users\\a\\.local\\bin", "win32", exists), [
    "C:\\Users\\a\\.local\\bin\\claude.exe",
    "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd",
    "C:\\tools\\claude.bat",
  ]);
});

test("windowsExtraDirs: 네이티브 설치기·npm 전역·winget·pnpm·scoop·bun", () => {
  assert.deepEqual(windowsExtraDirs({ USERPROFILE: "C:\\Users\\a", APPDATA: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }), [
    "C:\\Users\\a\\.local\\bin",
    "C:\\Users\\a\\AppData\\Roaming\\npm",
    "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Users\\a\\AppData\\Local\\pnpm",
    "C:\\Users\\a\\scoop\\shims",
    "C:\\Users\\a\\.bun\\bin",
  ]);
  // APPDATA·LOCALAPPDATA 가 없으면 홈 아래 기본 위치
  assert.ok(windowsExtraDirs({ USERPROFILE: "C:\\Users\\a" }).includes("C:\\Users\\a\\AppData\\Roaming\\npm"));
  assert.deepEqual(windowsExtraDirs({}), []);
});
