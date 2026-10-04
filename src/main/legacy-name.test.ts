import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { legacyInstanceRunning, legacyWorktreeDir, migrateUserData, removeLegacyInstall } from "./legacy-name";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sudal-legacy-"));
const write = (p: string, text = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

test("migrateUserData: 옛 폴더의 항목을 새 폴더로 옮기고 빈 옛 폴더를 지운다", () => {
  const appData = tmp();
  const prev = path.join(appData, "Atelier");
  const next = path.join(appData, "Sudal");
  write(path.join(prev, "workspaces.json"), "{}");
  write(path.join(prev, "threads", "a.jsonl"), "t");
  write(path.join(prev, "control.json"));
  fs.symlinkSync("host-999999", path.join(prev, "SingletonLock"));
  // Electron 이 먼저 만들어 둔 것은 덮어쓰지 않는다
  write(path.join(next, "Preferences"), "new");
  write(path.join(prev, "Preferences"), "old");

  const r = migrateUserData(next, appData, () => false);
  assert.deepEqual(r, { kind: "migrated", from: prev });
  assert.equal(fs.readFileSync(path.join(next, "workspaces.json"), "utf8"), "{}");
  assert.equal(fs.readFileSync(path.join(next, "threads", "a.jsonl"), "utf8"), "t");
  assert.equal(fs.readFileSync(path.join(next, "Preferences"), "utf8"), "new");
  assert.equal(fs.existsSync(path.join(next, "control.json")), false);
  assert.equal(fs.existsSync(path.join(next, "SingletonLock")), false);
  // 건너뛴 Preferences 가 남아 옛 폴더는 지워지지 않는다
  assert.deepEqual(fs.readdirSync(prev), ["Preferences"]);
});

test("migrateUserData: 새 폴더에 이미 데이터가 있으면 아무것도 하지 않는다", () => {
  const appData = tmp();
  write(path.join(appData, "Atelier", "workspaces.json"), "old");
  write(path.join(appData, "Sudal", "workspaces.json"), "new");
  assert.deepEqual(migrateUserData(path.join(appData, "Sudal"), appData, () => false), { kind: "none" });
  assert.equal(fs.readFileSync(path.join(appData, "Atelier", "workspaces.json"), "utf8"), "old");
});

test("migrateUserData: userData 를 따로 지정해 띄웠으면 쓰던 데이터를 옮기지 않는다", () => {
  const appData = tmp();
  write(path.join(appData, "Atelier", "workspaces.json"), "{}");
  const elsewhere = path.join(tmp(), "userdata");
  assert.deepEqual(migrateUserData(elsewhere, appData, () => false), { kind: "none" });
  assert.equal(fs.existsSync(path.join(appData, "Atelier", "workspaces.json")), true);
  assert.equal(fs.existsSync(elsewhere), false);
});

test("migrateUserData: 옛 앱이 실행 중이면 옮기지 않고 알린다", () => {
  const appData = tmp();
  const prev = path.join(appData, "Atelier");
  write(path.join(prev, "workspaces.json"), "{}");
  fs.symlinkSync("host-4242", path.join(prev, "SingletonLock"));
  const r = migrateUserData(path.join(appData, "Sudal"), appData, (pid) => pid === 4242);
  assert.deepEqual(r, { kind: "running", from: prev });
  assert.equal(fs.existsSync(path.join(prev, "workspaces.json")), true);
  assert.equal(fs.existsSync(path.join(appData, "Sudal", "workspaces.json")), false);
});

test("migrateUserData: 더 옛 이름(ai-workbench)도 넘겨받고, 둘 다 있으면 최근 이름이 먼저다", () => {
  const appData = tmp();
  write(path.join(appData, "ai-workbench", "workspaces.json"), "older");
  assert.equal(migrateUserData(path.join(appData, "Sudal"), appData, () => false).kind, "migrated");
  assert.equal(fs.readFileSync(path.join(appData, "Sudal", "workspaces.json"), "utf8"), "older");

  const both = tmp();
  write(path.join(both, "ai-workbench", "workspaces.json"), "older");
  write(path.join(both, "Atelier", "workspaces.json"), "recent");
  migrateUserData(path.join(both, "Sudal"), both, () => false);
  assert.equal(fs.readFileSync(path.join(both, "Sudal", "workspaces.json"), "utf8"), "recent");
});

test("legacyInstanceRunning: 잠금 파일이 없거나 pid 가 죽었으면 false", () => {
  const dir = tmp();
  assert.equal(legacyInstanceRunning(dir, () => true), false);
  fs.symlinkSync("my-host.local-123", path.join(dir, "SingletonLock"));
  assert.equal(legacyInstanceRunning(dir, () => false), false);
  assert.equal(legacyInstanceRunning(dir, (pid) => pid === 123), true);
});

test("removeLegacyInstall: 우리가 쓴 CLI 와 스킬만 지우고 무엇이 있었는지 돌려준다", () => {
  const home = tmp();
  const codexHome = path.join(home, ".codex");
  const shim = path.join(home, ".local", "bin", "atelier");
  write(shim, "#!/bin/sh\nexec node /Applications/Atelier.app/Contents/Resources/cli/atelier.cjs\n");
  write(path.join(home, ".claude", "skills", "atelier-cli", "SKILL.md"));
  write(path.join(home, ".claude", "skills", "other", "SKILL.md"));

  assert.deepEqual(removeLegacyInstall(home, codexHome), { cli: true, skills: ["claude"] });
  assert.equal(fs.existsSync(shim), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "atelier-cli")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "other", "SKILL.md")), true);
  assert.deepEqual(removeLegacyInstall(home, codexHome), { cli: false, skills: [] });
});

test("removeLegacyInstall: 같은 이름의 남의 프로그램은 건드리지 않는다", () => {
  const home = tmp();
  const shim = path.join(home, ".local", "bin", "atelier");
  write(shim, "#!/bin/sh\necho someone else\n");
  assert.deepEqual(removeLegacyInstall(home, path.join(home, ".codex")), { cli: false, skills: [] });
  assert.equal(fs.existsSync(shim), true);
});

test("legacyWorktreeDir: 옛 기본 폴더가 있을 때만 그 경로", () => {
  const home = tmp();
  assert.equal(legacyWorktreeDir(home), null);
  fs.mkdirSync(path.join(home, "atelier", "worktrees"), { recursive: true });
  assert.equal(legacyWorktreeDir(home), path.join(home, "atelier", "worktrees"));
});
