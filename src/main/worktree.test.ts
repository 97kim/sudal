import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listManagedWorktrees, worktreeCreate, worktreeMerge, worktreeRemove, worktreeSlug, worktreeStatus } from "./worktree";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env }).toString();

test("worktreeSlug: 안전한 이름 + 시각", () => {
  assert.match(worktreeSlug("로그인 버그 수정!", Date.UTC(2026, 8, 6, 3, 4)), /^로그인-버그-수정-\d{4}-\d{4}$/);
  assert.match(worktreeSlug("", 0), /^session-/);
});

test("worktree: 만들기 → 상태 → 커밋 가져오기(merge) → 정리(브랜치 삭제)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-wt-"));
  const repo = join(root, "repo");
  const wtRoot = join(root, "worktrees");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "init"]);

  const created = await worktreeCreate(repo, env, { rootDir: wtRoot, slug: "feat" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const wt = created.worktree;
  assert.equal(wt.base, "main");
  assert.equal(wt.branch, "sudal/feat");
  assert.ok(existsSync(join(wt.path, "a.txt")));
  // 같은 slug 로 다시 만들면 -2
  const second = await worktreeCreate(repo, env, { rootDir: wtRoot, slug: "feat" });
  assert.ok(second.ok && second.worktree.branch === "sudal/feat-2");

  assert.deepEqual(await worktreeStatus(env, wt), { exists: true, baseMissing: false, ahead: 0, behind: 0, dirty: 0 });
  // rename 은 dirty 1 로 센다
  sh(wt.path, ["mv", "a.txt", "a2.txt"]);
  assert.equal((await worktreeStatus(env, wt)).dirty, 1);
  sh(wt.path, ["mv", "a2.txt", "a.txt"]);
  writeFileSync(join(wt.path, "b.txt"), "b\n");
  assert.equal((await worktreeStatus(env, wt)).dirty, 1);
  // 미커밋 변경이 있으면 merge 거부
  assert.equal((await worktreeMerge(env, wt)).ok, false);
  sh(wt.path, ["add", "."]);
  sh(wt.path, ["commit", "-q", "-m", "add b"]);
  assert.equal((await worktreeStatus(env, wt)).ahead, 1);
  // 원본이 dirty 면 거부
  writeFileSync(join(repo, "a.txt"), "changed\n");
  assert.match((await worktreeMerge(env, wt) as { error: string }).error, /원본 저장소/);
  sh(repo, ["checkout", "--", "a.txt"]);
  const merged = await worktreeMerge(env, wt);
  assert.deepEqual(merged, { ok: true, merged: 1 });
  assert.ok(existsSync(join(repo, "b.txt")));
  // 정리: 합쳐졌으니 브랜치도 지워진다
  const removed = await worktreeRemove(env, wt);
  assert.deepEqual(removed, { ok: true, branchDeleted: true });
  assert.equal(existsSync(wt.path), false);
  // 두 번째 worktree 는 dirty 상태로 정리 시도 → 거부, force 로 삭제(브랜치는 미합병이라 남음)
  if (second.ok) {
    writeFileSync(join(second.worktree.path, "c.txt"), "c\n");
    assert.equal((await worktreeRemove(env, second.worktree)).ok, false);
    const forced = await worktreeRemove(env, second.worktree, { force: true });
    assert.deepEqual(forced, { ok: true, branchDeleted: true }); // 커밋이 없어 base 와 같으므로 -d 성공
  }
  rmSync(root, { recursive: true, force: true });
});

test("worktree: 충돌 merge 는 되돌리고 오류", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-wtc-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "init"]);
  const c = await worktreeCreate(repo, env, { rootDir: join(root, "wt"), slug: "x" });
  if (!c.ok) return assert.fail(c.error);
  writeFileSync(join(c.worktree.path, "a.txt"), "from-wt\n");
  sh(c.worktree.path, ["commit", "-q", "-am", "wt"]);
  writeFileSync(join(repo, "a.txt"), "from-main\n");
  sh(repo, ["commit", "-q", "-am", "main"]);
  const st = await worktreeStatus(env, c.worktree);
  assert.deepEqual([st.ahead, st.behind], [1, 1]);
  const m = await worktreeMerge(env, c.worktree);
  assert.equal(m.ok, false);
  assert.equal(sh(repo, ["status", "--porcelain"]).trim(), "");
  assert.equal(sh(repo, ["log", "--oneline"]).trim().split("\n").length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("worktreePatch → applyPatch: 커밋·수정·새 파일을 한 패치로 뽑아 원본에 적용한다", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, existsSync: exists } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { worktreeCreate, worktreePatch, applyPatch, worktreeSnapshot } = await import("./worktree");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = mkdtempSync(join(tmpdir(), "wt-patch-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, env, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const wt = await worktreeCreate(repo, env, { rootDir: mkdtempSync(join(tmpdir(), "wt-root-")), slug: "fan-a" });
  assert.ok(wt.ok);
  if (!wt.ok) return;
  // 변형: 커밋 하나 + 미커밋 수정 + 새 파일
  writeFileSync(join(wt.worktree.path, "a.txt"), "one\ntwo\n");
  execFileSync("git", ["add", "-A"], { cwd: wt.worktree.path, env });
  execFileSync("git", ["commit", "-q", "-m", "step"], { cwd: wt.worktree.path, env });
  writeFileSync(join(wt.worktree.path, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(wt.worktree.path, "new.txt"), "hello\n");
  // 일부만 스테이징해 둔 상태(A 스테이징, 작업 파일은 B)도 보존돼야 한다
  writeFileSync(join(wt.worktree.path, "staged.txt"), "A\n");
  execFileSync("git", ["add", "staged.txt"], { cwd: wt.worktree.path, env });
  writeFileSync(join(wt.worktree.path, "staged.txt"), "B\n");
  const snap = await worktreeSnapshot(env, wt.worktree, { diffs: true });
  assert.ok(snap.ok);
  if (!snap.ok) return;
  assert.deepEqual(snap.changes.map((c) => [c.path, c.kind, c.added, c.deleted]).sort(), [["a.txt", "modified", 2, 0], ["new.txt", "added", 1, 0], ["staged.txt", "added", 1, 0]]);
  assert.match(snap.diffs["a.txt"], /\+two\n\+three/);
  assert.match(snap.diffs["staged.txt"], /\+B/);
  const p = await worktreePatch(env, wt.worktree);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.match(p.patch, /\+three/);
  assert.match(p.patch, /new\.txt/);
  assert.match(p.patch, /\+B/);
  // 실제 인덱스는 그대로: 새 파일은 untracked, staged.txt 는 A 가 스테이징된 채(작업 파일은 B)
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt.worktree.path, env, encoding: "utf8" });
  assert.match(status, /\?\? new\.txt/);
  assert.match(status, /^AM staged\.txt/m);
  assert.match(execFileSync("git", ["diff", "--cached", "--", "staged.txt"], { cwd: wt.worktree.path, env, encoding: "utf8" }), /\+A/);
  const applied = await applyPatch(env, repo, p.patch);
  assert.ok(applied.ok);
  if (!applied.ok) return;
  assert.deepEqual(applied.files.sort(), ["a.txt", "new.txt", "staged.txt"]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.ok(exists(join(repo, "new.txt")));
  // 같은 패치를 다시 적용하면 --check 에서 거부
  const again = await applyPatch(env, repo, p.patch);
  assert.equal(again.ok, false);
});

test("worktree: worktree 폴더가 저장소 안이면 만들지 않는다(원본에 untracked 로 보인다)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-wt-in-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "init"]);
  const r = await worktreeCreate(repo, env, { rootDir: join(repo, ".worktrees"), slug: "feat" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /저장소 안/);
});

test("listManagedWorktrees: worktree 폴더의 worktree 를 원본 저장소·브랜치·변경 수와 함께 모은다", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-wt-list-")));
  const repo = join(root, "repo");
  const wtRoot = join(root, "worktrees");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "init"]);
  const c = await worktreeCreate(repo, env, { rootDir: wtRoot, slug: "feat" });
  assert.ok(c.ok);
  if (!c.ok) return;
  writeFileSync(join(c.worktree.path, "new.txt"), "x\n");
  const list = await listManagedWorktrees(env, [wtRoot, join(root, "없는-폴더")]);
  assert.equal(list.length, 1);
  assert.equal(list[0].path, c.worktree.path);
  assert.equal(list[0].repo, repo);
  assert.equal(list[0].branch, "sudal/feat");
  assert.equal(list[0].dirty, 1);
  assert.ok((list[0].sizeKb ?? 0) > 0);
});
