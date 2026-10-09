import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { locateFiles, looksBinary, readFileView, listDirectory, writeFileView } from "./files";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-files-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("looksBinary: NUL 이 있으면 바이너리", () => {
  assert.equal(looksBinary(Buffer.from("hello\n")), false);
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
});

test("readFileView: 수정된 파일은 현재 내용과 HEAD 내용을 모두 준다", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "a.ts"), "const a = 2;\n");
    const v = await readFileView(dir, "a.ts", env);
    assert.equal(v.relPath, "a.ts");
    assert.equal(v.content, "const a = 2;\n");
    assert.equal(v.headContent, "const a = 1;\n");
    assert.equal(v.missing, false);
    // 절대 경로로 요청해도 같은 결과
    const v2 = await readFileView(dir, join(dir, "a.ts"), env);
    assert.equal(v2.relPath, "a.ts");
    assert.equal(v2.headContent, "const a = 1;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFileView: 새 파일은 HEAD 없음, 삭제된 파일은 missing + HEAD 있음, 없는 경로는 둘 다 없음", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "new.md"), "# new\n");
    const fresh = await readFileView(dir, "new.md", env);
    assert.equal(fresh.content, "# new\n");
    assert.equal(fresh.headContent, null);

    unlinkSync(join(dir, "gone.txt"));
    const gone = await readFileView(dir, "gone.txt", env);
    assert.equal(gone.missing, true);
    assert.equal(gone.content, null);
    assert.equal(gone.headContent, "bye\n");

    const nope = await readFileView(dir, "nope.txt", env);
    assert.equal(nope.missing, true);
    assert.equal(nope.headContent, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFileView: git 레포가 아니어도 현재 내용은 읽는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-files-nogit-"));
  try {
    writeFileSync(join(dir, "x.json"), "{}\n");
    const v = await readFileView(dir, "x.json", env);
    assert.equal(v.content, "{}\n");
    assert.equal(v.headContent, null);
    assert.equal(v.relPath, "x.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listDirectory: 폴더 먼저 이름순, .git 제외", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-list-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "Build"));
  writeFileSync(join(dir, "b.txt"), "b");
  writeFileSync(join(dir, "A.md"), "aa");
  const entries = await listDirectory(dir);
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.name}`), ["dir:Build", "dir:src", "file:A.md", "file:b.txt"]);
  assert.equal(entries.find((e) => e.name === "A.md")?.size, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("writeFileView: 저장·mtime 충돌 감지·force 덮어쓰기·새 파일 생성", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wb-write-"));
  const f = join(dir, "a.txt");
  writeFileSync(f, "one\n");
  const mtime = statSync(f).mtimeMs;
  const r1 = await writeFileView(dir, "a.txt", "two\n", { expectedMtimeMs: mtime });
  assert.equal(r1.ok, true);
  assert.equal(readFileSync(f, "utf8"), "two\n");
  // 밖에서 바뀐 뒤 옛 mtime 으로 저장 → conflict
  utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const r2 = await writeFileView(dir, "a.txt", "three\n", { expectedMtimeMs: mtime });
  assert.deepEqual(r2.ok, false);
  assert.equal((r2 as { conflict?: boolean }).conflict, true);
  assert.equal(readFileSync(f, "utf8"), "two\n");
  const r3 = await writeFileView(dir, "a.txt", "three\n", { expectedMtimeMs: mtime, force: true });
  assert.equal(r3.ok, true);
  assert.equal(readFileSync(f, "utf8"), "three\n");
  // 없던 파일(삭제된 파일 복원)은 expected null 로 만들어진다
  const r4 = await writeFileView(dir, "sub/new.txt", "n\n", { expectedMtimeMs: null });
  assert.equal(r4.ok, true);
  assert.equal(readFileSync(join(dir, "sub/new.txt"), "utf8"), "n\n");
  rmSync(dir, { recursive: true, force: true });
});

test("writeFileView: 저장소(또는 cwd) 밖 경로는 거부한다", async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wb-wbound-"));
  const outside = join(tmpdir(), `wb-outside-${Date.now()}.txt`);
  const r = await writeFileView(dir, outside, "x", { expectedMtimeMs: null });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /밖에는 저장할 수 없습니다/);
  assert.equal(existsSync(outside), false);
  const r2 = await writeFileView(dir, "../escape.txt", "x", { expectedMtimeMs: null });
  assert.equal(r2.ok, false);
  writeFileSync(join(dir, "in.txt"), "a");
  const r3 = await writeFileView(dir, "in.txt", "b", { expectedMtimeMs: null, force: true });
  assert.equal(r3.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("createPath / renamePath / resolveDeletable: 저장소 안에서만, 덮어쓰기 없음, 나쁜 이름 거부", async () => {
  const { mkdtempSync, existsSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createPath, renamePath, resolveDeletable } = await import("./files");
  const dir = mkdtempSync(join(tmpdir(), "wb-fops-"));
  const c1 = await createPath(dir, "a/b.txt", "file");
  assert.equal(c1.ok, true);
  assert.equal(existsSync(join(dir, "a/b.txt")), true);
  assert.equal((await createPath(dir, "a/b.txt", "file")).ok, false); // 이미 있음
  assert.equal((await createPath(dir, "d", "dir")).ok, true);
  assert.equal((await createPath(dir, "../x.txt", "file")).ok, false); // 밖
  assert.equal((await createPath(dir, "bad/na:me", "file")).ok, false);
  const r1 = await renamePath(dir, "a/b.txt", "a/c.txt");
  assert.equal(r1.ok, true);
  assert.equal(existsSync(join(dir, "a/c.txt")), true);
  writeFileSync(join(dir, "z.txt"), "z");
  assert.equal((await renamePath(dir, "a/c.txt", "z.txt")).ok, false); // 덮어쓰기 없음
  assert.equal((await renamePath(dir, "a/c.txt", "../out.txt")).ok, false);
  assert.equal((await renamePath(dir, "a/c.txt", "a/C.txt")).ok, true); // 대소문자만 변경 허용
  assert.equal((await resolveDeletable(dir, "z.txt")).ok, true);
  assert.equal((await resolveDeletable(dir, ".")).ok, false); // 루트
  assert.equal((await resolveDeletable(dir, "nope")).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("renamePath / resolveDeletable: 심링크는 링크 자체를 다루고 원본은 건드리지 않는다", async (t) => {
  const { mkdtempSync, existsSync, writeFileSync, symlinkSync, lstatSync, readFileSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { renamePath, resolveDeletable, createPath } = await import("./files");
  const dir = mkdtempSync(join(tmpdir(), "wb-symlink-"));
  writeFileSync(join(dir, "real.txt"), "keep me");
  try {
    symlinkSync("real.txt", join(dir, "link.txt"));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    // Windows 는 관리자·개발자 모드가 아니면 심링크를 만들 수 없다
    if ((e as NodeJS.ErrnoException).code === "EPERM") return t.skip("심링크를 만들 권한이 없음");
    throw e;
  }
  // 링크 이름 변경 → 링크만 옮겨지고 원본은 그대로
  const r = await renamePath(dir, "link.txt", "moved.txt");
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(dir, "real.txt"), "utf8"), "keep me");
  assert.equal(lstatSync(join(dir, "moved.txt")).isSymbolicLink(), true);
  assert.equal(existsSync(join(dir, "link.txt")), false);
  // 삭제 대상도 링크 경로(원본이 아님)
  const d = await resolveDeletable(dir, "moved.txt");
  assert.equal(d.ok, true);
  assert.equal((d as { path: string }).path, join(realpathSync.native(dir), "moved.txt"));
  // 저장소 밖을 가리키는 링크 위로는 만들거나 옮기지 못한다(원본이 생기면 안 된다)
  const outside = mkdtempSync(join(tmpdir(), "wb-symlink-out-"));
  symlinkSync(join(outside, "x.txt"), join(dir, "escape.txt"));
  assert.equal((await createPath(dir, "escape.txt", "file")).ok, false);
  assert.equal((await renamePath(dir, "real.txt", "escape.txt")).ok, false);
  assert.equal(existsSync(join(outside, "x.txt")), false);
  // 그 링크 자체의 이름 변경·삭제는 된다 — 링크만 움직이고 밖은 건드리지 않는다
  writeFileSync(join(outside, "x.txt"), "outside");
  const mv = await renamePath(dir, "escape.txt", "escape2.txt");
  assert.equal(mv.ok, true);
  assert.equal(lstatSync(join(dir, "escape2.txt")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(outside, "x.txt"), "utf8"), "outside");
  const del = await resolveDeletable(dir, "escape2.txt");
  assert.equal(del.ok, true);
  assert.equal((del as { path: string }).path, join(realpathSync.native(dir), "escape2.txt"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("repoRoot: git 저장소면 최상위, 아니면 cwd 의 실제 경로", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { repoRoot } = await import("./files");
  const r = repo();
  mkdirSync(join(r, "sub"));
  // .native: Windows 의 8.3 짧은 이름(RUNNER~1)까지 풀어야 앱(fs.promises.realpath)과 같다
  assert.equal(await repoRoot(join(r, "sub"), env), realpathSync.native(r));
  const plain = mkdtempSync(join(tmpdir(), "wb-plain-"));
  assert.equal(await repoRoot(plain, env), realpathSync.native(plain));
  rmSync(r, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test("readFileView: 이미지는 data URL 미리보기로, 상한을 넘으면 tooLarge", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFileView, imageMimeOf, MAX_IMAGE_BYTES } = await import("./files");
  assert.equal(imageMimeOf("/a/b.PNG"), "image/png");
  assert.equal(imageMimeOf("/a/b.svg"), "image/svg+xml");
  assert.equal(imageMimeOf("/a/b.ts"), null);
  const dir = mkdtempSync(join(tmpdir(), "wb-img-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // PNG 시그니처 + IHDR 머리
  writeFileSync(join(dir, "logo.png"), png);
  const v = await readFileView(dir, "logo.png", process.env);
  assert.equal(v.binary, true);
  assert.equal(v.content, null);
  assert.equal(v.image?.mime, "image/png");
  assert.equal(v.image?.dataUrl, `data:image/png;base64,${png.toString("base64")}`);
  assert.ok(MAX_IMAGE_BYTES > 1024 * 1024, "이미지 상한은 텍스트 상한보다 크다");
  rmSync(dir, { recursive: true, force: true });
});

test("locateFiles: 이름만·경로 꼬리·cwd 상대·절대·대소문자·미추적 파일을 찾고, 없으면 []", async () => {
  const dir = repo();
  mkdirSync(join(dir, "src", "main", "kotlin"), { recursive: true });
  mkdirSync(join(dir, "src", "test", "kotlin"), { recursive: true });
  mkdirSync(join(dir, "src", "main", "resources"), { recursive: true });
  writeFileSync(join(dir, "src", "main", "kotlin", "ProductByPoController.kt"), "class A\n");
  writeFileSync(join(dir, "src", "test", "kotlin", "ProductByPoController.kt"), "class B\n");
  writeFileSync(join(dir, "src", "main", "resources", "application.yml"), "server:\n  servlet:\n    context-path: /pims\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "files");
  writeFileSync(join(dir, "src", "main", "kotlin", "Untracked.kt"), "new\n"); // 미추적도 잡혀야 한다
  const real = (p: string) => join(dir, p);
  const rel = (list: string[]) => list.map((p) => p.split(sep).join("/")).map((p) => p.slice(p.indexOf("/src/") + 1));

  // 이름만: 둘 다, main 쪽이 먼저(같은 깊이면 이름순)
  assert.deepEqual(rel(await locateFiles(dir, "ProductByPoController.kt", env)), [
    "src/main/kotlin/ProductByPoController.kt",
    "src/test/kotlin/ProductByPoController.kt",
  ]);
  // 꼬리 경로로 좁히기
  assert.deepEqual(rel(await locateFiles(dir, "test/kotlin/ProductByPoController.kt", env)), ["src/test/kotlin/ProductByPoController.kt"]);
  // cwd 기준 상대 경로가 있으면 그것 하나
  assert.deepEqual(rel(await locateFiles(dir, "./src/main/resources/application.yml", env)), ["src/main/resources/application.yml"]);
  // 저장소 하위 디렉토리가 cwd 여도 루트 기준 꼬리로 찾는다
  assert.deepEqual(rel(await locateFiles(join(dir, "src", "test"), "application.yml", env)), ["src/main/resources/application.yml"]);
  // 절대 경로
  assert.deepEqual(await locateFiles(dir, real("a.ts"), env), [await locateFiles(dir, "a.ts", env).then((r) => r[0])]);
  // 대소문자 무시는 정확한 것이 없을 때만
  assert.deepEqual(rel(await locateFiles(dir, "productbypocontroller.KT", env)).length, 2);
  // 미추적 파일
  assert.deepEqual(rel(await locateFiles(dir, "Untracked.kt", env)), ["src/main/kotlin/Untracked.kt"]);
  // 없는 것·이상한 것
  assert.deepEqual(await locateFiles(dir, "Node.js", env), []);
  assert.deepEqual(await locateFiles(dir, "../../etc/passwd", env), []);
  assert.deepEqual(await locateFiles(dir, "   ", env), []);
  rmSync(dir, { recursive: true, force: true });
});

test("locateFiles: git 이 아닌 디렉토리는 걷되 node_modules 는 건너뛴다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-locate-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "lib", "util.py"), "x\n");
  writeFileSync(join(dir, "node_modules", "x", "util.py"), "y\n");
  const r = await locateFiles(dir, "util.py", env);
  assert.equal(r.length, 1);
  assert.ok(r[0].endsWith(join("lib", "util.py")));
  rmSync(dir, { recursive: true, force: true });
});
