import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChanges, gitCommit, gitDiffFor, gitRecentSubjects, gitRevert } from "./git";

// Windows 러너의 전역 core.autocrlf=true 가 diff·status 를 흔들지 않게 끈다
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.autocrlf",
  GIT_CONFIG_VALUE_0: "false",
};
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env }).toString();

test("gitCommit: 고른 파일만 커밋하고 나머지는 워킹 트리에 남긴다; gitDiffFor 는 새 파일도 diff 로", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-git-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  sh(dir, ["add", "a.txt"]);
  sh(dir, ["commit", "-q", "-m", "Initial"]);
  writeFileSync(join(dir, "a.txt"), "a\nb\n");
  writeFileSync(join(dir, "new.txt"), "new\n");
  writeFileSync(join(dir, "other.txt"), "other\n");

  const diff = await gitDiffFor(dir, env, ["a.txt", "new.txt"]);
  assert.match(diff, /\+b/);
  assert.match(diff, /\+new/);
  assert.doesNotMatch(diff, /other/);

  assert.deepEqual(await gitCommit(dir, env, [], "x"), { ok: false, error: "커밋할 파일을 고르세요." });
  const r = await gitCommit(dir, env, ["a.txt", "new.txt"], "Add b and new\n\n- detail");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.subject, "Add b and new");
    assert.equal(r.files, 2);
    assert.match(r.hash, /^[0-9a-f]{7,}$/);
  }
  const left = await gitChanges(dir, env);
  assert.deepEqual(left.map((c) => c.path), ["other.txt"]);
  assert.deepEqual(await gitRecentSubjects(dir, env, 5), ["Add b and new", "Initial"]);
  const bad = await gitCommit(dir, env, ["nope.txt"], "x");
  assert.deepEqual(bad, { ok: false, error: "고른 파일에 남은 변경이 없습니다." });
  // 목록에 있었지만 사라진 파일은 건너뛰고 나머지를 커밋한다
  const r2 = await gitCommit(dir, env, ["other.txt", "gone.txt"], "Add other");
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.files, 1);

  // 이름 변경: new 경로만 골라도 old 경로 삭제까지 한 커밋에 들어간다
  sh(dir, ["mv", "a.txt", "renamed.txt"]);
  const ch = await gitChanges(dir, env);
  assert.deepEqual(ch.map((c) => [c.kind, c.path, c.oldPath]), [["renamed", "renamed.txt", "a.txt"]]);
  const r3 = await gitCommit(dir, env, ["renamed.txt"], "Rename a");
  assert.equal(r3.ok, true);
  assert.deepEqual(sh(dir, ["ls-tree", "--name-only", "HEAD"]).trim().split("\n").sort(), ["new.txt", "other.txt", "renamed.txt"]);
  assert.equal(sh(dir, ["status", "--porcelain"]).trim(), "");

  // pathspec 매직처럼 보이는 이름·한글 이름도 글자 그대로 다룬다(Windows 파일 이름에는 : 를 못 써서 한글 이름만)
  const odd = process.platform === "win32" ? ["한글 파일.txt"] : [":(glob)x.txt", "한글 파일.txt"];
  for (const f of odd) writeFileSync(join(dir, f), "x\n");
  writeFileSync(join(dir, "z.txt"), "z\n");
  const r4 = await gitCommit(dir, env, odd, "Odd names");
  assert.equal(r4.ok, true);
  assert.deepEqual((await gitChanges(dir, env)).map((c) => c.path), ["z.txt"]);
  // 레포 밖 경로는 diff 에 넣지 않는다
  assert.equal(await gitDiffFor(dir, env, ["/etc/hosts"]), "");
  rmSync(dir, { recursive: true, force: true });
});

test("gitCommit: 삭제는 스테이징된 것(git rm)이든 작업 트리에서만 지운 것이든 커밋된다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-git-del-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "staged.txt"), "s\n");
  writeFileSync(join(dir, "unstaged.txt"), "u\n");
  writeFileSync(join(dir, "keep.txt"), "k\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "Initial"]);
  sh(dir, ["rm", "-q", "staged.txt"]); // 터미널에서 스테이징한 삭제
  rmSync(join(dir, "unstaged.txt")); // 그냥 지운 파일
  writeFileSync(join(dir, "keep.txt"), "k2\n");
  const changes = await gitChanges(dir, env);
  assert.deepEqual(changes.filter((c) => c.kind === "deleted").map((c) => c.path).sort(), ["staged.txt", "unstaged.txt"]);
  // 커밋 메시지 초안용 diff 에도 두 삭제가 다 들어간다(스테이징된 삭제는 인덱스에 없어 HEAD 트리로 찾는다)
  const diff = await gitDiffFor(dir, env, ["staged.txt", "unstaged.txt"]);
  assert.match(diff, /deleted file mode[\s\S]*-s\n/);
  assert.match(diff, /-u\n/);
  assert.match(await gitDiffFor(dir, env, ["staged.txt"]), /^diff --git a\/staged\.txt/m);
  const r = await gitCommit(dir, env, ["staged.txt", "unstaged.txt"], "Remove two");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sh(dir, ["ls-tree", "--name-only", "HEAD"]).trim(), "keep.txt");
  // 고르지 않은 keep.txt 의 수정은 그대로 남는다
  assert.equal(sh(dir, ["status", "--porcelain"]).trimEnd(), " M keep.txt");
  rmSync(dir, { recursive: true, force: true });
});

test("gitDiffFor: 첫 커밋 전(unborn HEAD)에도 스테이징된 파일의 diff 를 만든다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-git0-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "first.txt"), "hello\n");
  sh(dir, ["add", "first.txt"]);
  const diff = await gitDiffFor(dir, env, ["first.txt"]);
  assert.match(diff, /\+hello/);
  rmSync(dir, { recursive: true, force: true });
});

test("gitRevert: 수정·삭제·새 파일(추적/미추적)·이름 변경을 각각 HEAD 상태로 되돌린다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-gitrv-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  for (const f of ["m.txt", "d.txt", "r.txt"]) writeFileSync(join(dir, f), `${f}\n`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(dir, "m.txt"), "changed\n");
  rmSync(join(dir, "d.txt"));
  writeFileSync(join(dir, "untracked.txt"), "u\n");
  writeFileSync(join(dir, "staged-new.txt"), "s\n");
  sh(dir, ["add", "staged-new.txt"]);
  sh(dir, ["mv", "r.txt", "renamed.txt"]);
  const before = (await gitChanges(dir, env)).map((c) => c.path).sort();
  assert.deepEqual(before, ["d.txt", "m.txt", "renamed.txt", "staged-new.txt", "untracked.txt"]);
  for (const p of ["m.txt", "d.txt", "untracked.txt", "staged-new.txt", "renamed.txt"]) {
    const r = await gitRevert(dir, env, p);
    assert.deepEqual(r, { ok: true }, p);
  }
  assert.deepEqual(await gitChanges(dir, env), []);
  assert.equal(sh(dir, ["ls-tree", "--name-only", "HEAD"]).trim().split("\n").sort().join(","), "d.txt,m.txt,r.txt");
  assert.equal(existsSync(join(dir, "untracked.txt")), false);
  assert.equal((await gitRevert(dir, env, "nope.txt")).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("gitRevert: 대소문자만 바뀐 rename 을 되돌려도 파일이 남는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-gitcase-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "Foo.txt"), "foo\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "init"]);
  sh(dir, ["mv", "Foo.txt", "foo.txt"]);
  const ch = await gitChanges(dir, env);
  assert.deepEqual(ch.map((c) => [c.kind, c.path, c.oldPath]), [["renamed", "foo.txt", "Foo.txt"]]);
  const r = await gitRevert(dir, env, "foo.txt");
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(await gitChanges(dir, env), []);
  assert.equal(existsSync(join(dir, "Foo.txt")), true);
  assert.equal(sh(dir, ["ls-files"]).trim(), "Foo.txt");
  rmSync(dir, { recursive: true, force: true });
});
