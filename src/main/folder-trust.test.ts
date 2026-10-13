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

test("folder-trust: macOS·Linux 에서 '\\' 가 든 다른 폴더를 신뢰된 폴더로 착각하지 않는다", { skip: process.platform === "win32" }, async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.base, "plain", "a\\b"), { recursive: true });
  t.cliTrust(path.join(t.base, "plain", "a", "b"));
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(path.join(t.base, "plain", "a\\b")), false);
});

test("folder-trust: 신뢰된 폴더 아래 저장소는 .git 이 깨졌거나 링크여도 경계로 본다", async () => {
  const t = setup();
  const broken = path.join(t.base, "plain", "broken");
  fs.mkdirSync(path.join(broken, ".git"), { recursive: true });
  fs.writeFileSync(path.join(broken, ".git", "config"), "[[[ 깨진 설정");
  const linked = path.join(t.base, "plain", "linked");
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(t.repo, ".git"), path.join(linked, ".git"));
  t.cliTrust(path.join(t.base, "plain"));
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(broken), false);
  assert.equal(await isFolderTrusted(linked), false);
});

test("folder-trust: .git 파일로 신뢰된 저장소를 가리키기만 해서는 신뢰를 빌리지 못한다", async () => {
  const t = setup();
  const fake = path.join(t.base, "fake");
  fs.mkdirSync(fake);
  const realGitdir = fs.readFileSync(path.join(t.wt, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
  fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${realGitdir}\n`);
  t.cliTrust(t.repo);
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(t.wt), true, "진짜 worktree 는 그대로");
  assert.equal(await isFolderTrusted(fake), false);
});

test("folder-trust: 홈 신뢰는 기록하지 않고 앱이 켜져 있는 동안만", { skip: process.platform === "win32" }, async () => {
  const t = setup();
  const home = path.join(t.base, "home");
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    t.cliTrust();
    initFolderTrust(t.sudal, t.cli);
    await trustFolder(home);
    assert.equal(await isFolderTrusted(path.join(home, "notes")), true);
    assert.equal(fs.existsSync(t.sudal), false);
  } finally {
    process.env.HOME = prev;
  }
});

test("folder-trust: 자기 안에 worktree 메타데이터를 만들어도 신뢰된 저장소를 빌리지 못한다", async () => {
  const t = setup();
  const fake = path.join(t.base, "fake2");
  fs.mkdirSync(path.join(fake, "meta"), { recursive: true });
  fs.writeFileSync(path.join(fake, ".git"), "gitdir: meta\n");
  fs.writeFileSync(path.join(fake, "meta", "gitdir"), "../.git\n");
  fs.writeFileSync(path.join(fake, "meta", "commondir"), path.join(t.repo, ".git") + "\n");
  const nested = path.join(t.base, "fake3");
  fs.mkdirSync(path.join(nested, ".git", "worktrees", "w"), { recursive: true });
  fs.mkdirSync(path.join(nested, "co"));
  fs.writeFileSync(path.join(nested, "co", ".git"), `gitdir: ${path.join(nested, ".git", "worktrees", "w")}\n`);
  fs.writeFileSync(path.join(nested, ".git", "worktrees", "w", "gitdir"), path.join(nested, "co", ".git") + "\n");
  t.cliTrust(t.repo);
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(fake), false);
  assert.equal((await trustScope(path.join(nested, "co"))).root, nested, "자기 저장소의 worktree 면 자기 저장소");
  assert.equal(await isFolderTrusted(path.join(nested, "co")), false);
});

test("folder-trust: gitdir 이 FIFO 여도 멈추지 않는다", { skip: process.platform === "win32" }, async () => {
  const t = setup();
  const dir = path.join(t.base, "fifo");
  fs.mkdirSync(path.join(dir, ".git", "worktrees", "w"), { recursive: true });
  fs.mkdirSync(path.join(dir, "co"));
  fs.writeFileSync(path.join(dir, "co", ".git"), `gitdir: ${path.join(dir, ".git", "worktrees", "w")}\n`);
  execFileSync("mkfifo", [path.join(dir, ".git", "worktrees", "w", "gitdir")]);
  t.cliTrust();
  initFolderTrust(t.sudal, t.cli);
  assert.equal(await isFolderTrusted(path.join(dir, "co")), false);
});
