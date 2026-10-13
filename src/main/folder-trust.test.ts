import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initFolderTrust, isFolderTrusted, trustFolder, trustScope } from "./folder-trust";

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sudal-trust-")));
  const repo = path.join(base, "outer", "repo");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(base, "wt");
  git("worktree", "add", "-q", wt);
  const plain = path.join(base, "plain", "a", "b");
  fs.mkdirSync(plain, { recursive: true });
  const cli = path.join(base, "claude.json");
  const sudal = path.join(base, "sudal", "trusted-folders.json");
  const cliTrust = (...dirs: string[]) =>
    fs.writeFileSync(cli, JSON.stringify({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) }));
  return { base, repo, wt, plain, cli, sudal, cliTrust };
}

test("folder-trust: 아무것도 신뢰하지 않았으면 false", async () => {
  const t = setup();
  t.cliTrust();
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(t.repo), false);
  assert.equal(await isFolderTrusted(t.plain), false);
});

test("folder-trust: CLI 가 신뢰한 저장소는 하위 폴더와 worktree 도 신뢰", async () => {
  const t = setup();
  t.cliTrust(t.repo);
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(path.join(t.repo, "sub")), true);
  assert.equal(await isFolderTrusted(t.wt), true);
  assert.equal((await trustScope(t.wt)).root, t.repo);
});

test("folder-trust: git 저장소는 저장소 뿌리 위의 신뢰를 물려받지 않는다", async () => {
  const t = setup();
  t.cliTrust(path.join(t.base, "outer"));
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(t.repo), false);
});

test("folder-trust: git 밖 폴더는 상위 폴더의 신뢰를 물려받는다", async () => {
  const t = setup();
  t.cliTrust(path.join(t.base, "plain"));
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(t.plain), true);
});

test("folder-trust: Sudal 에서 신뢰하면 저장소 뿌리를 기록하고 다시 읽는다", async () => {
  const t = setup();
  t.cliTrust();
  initFolderTrust(t.sudal, t.cli);
  await trustFolder(path.join(t.repo, "sub"));
  assert.deepEqual(JSON.parse(fs.readFileSync(t.sudal, "utf8")), [t.repo]);
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(t.wt), true);
  assert.equal(await isFolderTrusted(t.plain), false);
});
