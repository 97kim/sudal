import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, promises as fs, renameSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PreviewServer } from "./preview-server";

async function get(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"),
    policy: r.headers.get("content-security-policy"), body: await r.text() };
}

test("Codex visualizations grant access to one standalone HTML file", async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sudal-codex-visualization-")));
  const project = join(base, "project");
  const home = join(base, "codex-home");
  const alias = join(base, "codex-home-link");
  const directory = join(home, "visualizations", "2026", "10", "31", "session");
  const outside = join(home, "other");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  mkdirSync(outside);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(home, alias, linkType);
  const file = join(directory, "report draft.html");
  writeFileSync(file, "<h1>preview</h1>");
  writeFileSync(join(directory, "sibling.html"), "another artifact");
  writeFileSync(join(outside, "report draft.html"), "outside");
  writeFileSync(join(directory, ".hidden.html"), "private");
  writeFileSync(join(directory, "asset.txt"), "text");
  symlinkSync(outside, join(directory, "escape"), linkType);
  const server = new PreviewServer();
  const preview = (file: string, codexHome = home) => server.urlForArtifact(project, file, codexHome);
  try {
    assert.equal(await server.urlFor(project, file), null);
    assert.equal(await server.urlForArtifact(project, file, project), null);
    const url = await preview(file);
    assert.ok(url);
    assert.equal(await preview(file), url);
    assert.equal(await preview(file, alias), url, "Codex emits the canonical path");
    assert.equal(await preview(join(alias, "visualizations", "2026", "10", "31", "session", "report draft.html"), alias), url);
    const page = await get(url);
    assert.equal(page.status, 200);
    assert.equal(page.body, "<h1>preview</h1>");
    assert.equal(page.policy, "sandbox allow-scripts");
    assert.equal((await get(url, { method: "HEAD" })).status, 200);
    for (const name of ["sibling.html", "asset.txt", ".hidden.html", "escape/report%20draft.html", "..%2Freport%20draft.html"]) {
      assert.equal((await get(new URL(name, url).href)).status, 404, name);
    }
    for (const name of [join(outside, "report draft.html"), join(directory, "escape", "report draft.html"), join(directory, ".hidden.html"), join(directory, "asset.txt")]) {
      assert.equal(await preview(name), null, name);
    }

    // Replace a normal draft after verification. The active response must
    // finish from the descriptor it already checked.
    const lstat = fs.lstat;
    const replaceAfterCheck = t.mock.method(fs, "lstat", async (name: string, options: { bigint: true }) => {
      const stat = await lstat(name, options);
      if (name === file) {
        renameSync(file, file + ".old");
        writeFileSync(file, "<h1>replacement</h1>");
      }
      return stat;
    });
    try {
      assert.equal((await get(url)).body, "<h1>preview</h1>");
    } finally {
      replaceAfterCheck.mock.restore();
    }
    assert.equal((await get(url)).status, 404, "an old URL must not serve a new file at the same path");
    const newUrl = await preview(file);
    assert.ok(newUrl);
    assert.notEqual(newUrl, url);
    assert.equal((await get(newUrl)).body, "<h1>replacement</h1>");

    const redirectable = join(home, "visualizations", "redirectable");
    mkdirSync(redirectable);
    const redirectedFile = join(redirectable, "report draft.html");
    writeFileSync(redirectedFile, "original artifact");
    const redirectedUrl = await preview(redirectedFile);
    assert.ok(redirectedUrl);
    renameSync(redirectable, redirectable + "-old");
    symlinkSync(outside, redirectable, linkType);
    assert.equal((await get(redirectedUrl)).status, 404, "a grant must not follow a directory replaced by a link");
    const linkedHome = join(base, "linked-home");
    mkdirSync(linkedHome);
    symlinkSync(outside, join(linkedHome, "visualizations"), linkType);
    assert.equal(await preview(join(linkedHome, "visualizations", "report draft.html"), linkedHome), null);
  } finally {
    server.close();
    assert.equal(base.startsWith(realpathSync(tmpdir())), true);
    assert.equal(base.includes("sudal-codex-visualization-"), true);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a Codex visualization never falls back to project-wide access when verification fails", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sudal-preview-fallback-")));
  const home = join(root, "codex-home");
  const directory = join(home, "visualizations");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "report.html");
  writeFileSync(file, "<h1>draft</h1>");
  const unrelated = join(root, "project.html");
  writeFileSync(unrelated, "<h1>project</h1>");
  const server = new PreviewServer();
  const open = fs.open;
  const refuseOpen = t.mock.method(fs, "open", async (name: string, flags: number) => {
    if (name === file) throw Object.assign(new Error("fixture open failure"), { code: "EACCES" });
    return open(name, flags);
  });
  try {
    assert.ok(await server.urlFor(root, file), "a regular project preview would grant a broader scope");
    assert.equal(await server.urlForArtifact(root, file, home), null);
    const regular = await server.urlForArtifact(root, unrelated, home);
    assert.ok(regular);
    assert.equal((await get(regular)).body, "<h1>project</h1>");
  } finally {
    refuseOpen.mock.restore();
    server.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(root.includes("sudal-preview-fallback-"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact preview classification and grant share one resolved path", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sudal-preview-resolve-")));
  const home = join(root, "codex-home");
  const directory = join(home, "visualizations");
  mkdirSync(directory, { recursive: true });
  const alias = join(root, "draft.html");
  const projectFile = join(root, "project.html");
  const codexFile = join(directory, "codex.html");
  writeFileSync(projectFile, "<h1>project</h1>");
  writeFileSync(codexFile, "<h1>codex</h1>");
  const realpath = fs.realpath;
  let resolutions = 0;
  // Simulate a link being retargeted while the preview is prepared.
  const changingAlias = t.mock.method(fs, "realpath", async (name: string) =>
    name === alias ? (++resolutions === 1 ? projectFile : codexFile) : realpath(name));
  const server = new PreviewServer();
  try {
    const url = await server.urlForArtifact(root, alias, home);
    assert.ok(url);
    assert.equal(resolutions, 1);
    assert.equal((await get(url)).body, "<h1>project</h1>");
    const codexUrl = await server.urlForArtifact(root, alias, home);
    assert.ok(codexUrl);
    assert.equal(resolutions, 2);
    assert.equal((await get(codexUrl)).policy, "sandbox allow-scripts");
    assert.equal((await get(codexUrl)).body, "<h1>codex</h1>");
  } finally {
    changingAlias.mock.restore();
    server.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(root.includes("sudal-preview-resolve-"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial Codex preview approval rejects a file or directory that changes before open finishes", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sudal-preview-grant-")));
  const home = join(root, "codex-home");
  const directory = join(home, "visualizations", "session");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "report.html");
  writeFileSync(file, "<h1>original</h1>");
  const server = new PreviewServer();
  const open = fs.open;
  try {
    const replace = t.mock.method(fs, "open", async (name: string, flags: number) => {
      if (name === file) {
        renameSync(file, file + ".old");
        writeFileSync(file, "<h1>replacement</h1>");
      }
      return open(name, flags);
    });
    assert.equal(await server.urlForArtifact(root, file, home), null);
    replace.mock.restore();

    const lstat = fs.lstat;
    let opened = false;
    const observeOpen = t.mock.method(fs, "open", async (name: string, flags: number) => {
      if (name === file) opened = true;
      return open(name, flags);
    });
    const changeDirectoryStamp = t.mock.method(fs, "lstat", async (name: string, options: { bigint: true }) => {
      const stat = await lstat(name, options);
      if (name === directory && opened) stat.ctimeNs += 1n;
      return stat;
    });
    assert.equal(await server.urlForArtifact(root, file, home), null);
    assert.equal(opened, true);
    observeOpen.mock.restore();
    changeDirectoryStamp.mock.restore();

    let opens = 0;
    let marked = false;
    const observeRetry = t.mock.method(fs, "open", async (name: string, flags: number) => {
      if (name === file) opens++;
      return open(name, flags);
    });
    const changeSharedAncestor = t.mock.method(fs, "lstat", async (name: string, options: { bigint: true }) => {
      const stat = await lstat(name, options);
      if (name === root && opens === 1 && !marked) {
        marked = true;
        stat.ctimeNs += 1n;
      }
      return stat;
    });
    const stable = await server.urlForArtifact(root, file, home);
    observeRetry.mock.restore();
    changeSharedAncestor.mock.restore();
    assert.ok(stable);
    assert.equal(opens, 2, "a shared ancestor change requires a new verification");
    assert.equal((await get(stable)).body, "<h1>replacement</h1>");
  } finally {
    server.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(root.includes("sudal-preview-grant-"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit artifact previews expose only .sudal/previews and retain hidden-file and symlink boundaries", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sudal-artifact-preview-")));
  const directory = join(root, ".sudal", "previews");
  mkdirSync(join(directory, "assets"), { recursive: true });
  mkdirSync(join(directory, ".hidden"));
  writeFileSync(join(directory, "index.html"), '<script src="assets/main.js"></script>');
  writeFileSync(join(directory, "assets", "main.js"), "window.preview = true;");
  writeFileSync(join(directory, ".env"), "SECRET=private");
  writeFileSync(join(directory, ".hidden", "index.html"), "private");
  writeFileSync(join(root, ".sudal", "gh-auth.cjs"), "private auth helper");
  writeFileSync(join(root, ".sudal", "secret.html"), "private html");
  symlinkSync(join(root, ".sudal"), join(directory, "escape"), process.platform === "win32" ? "junction" : "dir");
  const server = new PreviewServer();
  const preview = (file: string) => server.urlForArtifact(root, file, join(root, "unused-codex-home"));
  try {
    assert.equal(await server.urlFor(root, join(directory, "index.html")), null);
    const url = await preview(join(directory, "index.html"));
    assert.ok(url);
    assert.equal((await get(url)).status, 200);
    assert.equal((await get(new URL("assets/main.js", url).href)).body, "window.preview = true;");
    for (const file of [".env", ".hidden/index.html", "escape/secret.html", "..%2Fgh-auth.cjs", "..%2Fsecret.html"]) assert.equal((await get(new URL(file, url).href)).status, 404, file);
    assert.equal(await preview(join(root, ".sudal", "secret.html")), null);
    assert.equal(await preview(join(directory, "escape", "secret.html")), null);
    assert.equal(await preview(join(directory, "assets", "main.js")), null);
    assert.equal(await preview(join(directory, ".hidden", "index.html")), null);
  } finally {
    server.close();
    assert.equal(root.startsWith(realpathSync(tmpdir())), true);
    assert.equal(root.includes("sudal-artifact-preview-"), true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreviewServer: 루트 안 파일만 토큰 경로로 서비스하고, 밖·추측 경로·심링크 탈출은 404", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wb-preview-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wb-outside-")));
  mkdirSync(join(dir, "site", "css"), { recursive: true });
  writeFileSync(join(dir, "site", "index.html"), "<h1>hi</h1><link rel=stylesheet href=css/a.css>");
  writeFileSync(join(dir, "site", "css", "a.css"), "h1{color:red}");
  writeFileSync(join(dir, "한글 폴더.html"), "<p>k</p>");
  writeFileSync(join(outside, "secret.txt"), "nope");
  writeFileSync(join(dir, ".env"), "TOKEN=secret");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config"), "[remote]");
  writeFileSync(join(outside, "other.html"), "<p>other</p>");
  symlinkSync(outside, join(dir, "site", "escape"), process.platform === "win32" ? "junction" : "dir");
  const srv = new PreviewServer();
  try {
    const url = await srv.urlFor(dir, join(dir, "site", "index.html"));
    assert.ok(url && /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/site\/index\.html$/.test(url), url ?? "null");
    const page = await get(url!);
    assert.equal(page.status, 200);
    assert.match(page.type ?? "", /text\/html/);
    assert.equal(page.cache, "no-store");
    assert.match(page.body, /<h1>hi<\/h1>/);
    // 상대 자원은 같은 루트에서
    const css = await get(url!.replace("index.html", "css/a.css"));
    assert.equal(css.status, 200);
    assert.match(css.type ?? "", /text\/css/);
    // 디렉토리는 index.html
    assert.equal((await get(url!.replace("/index.html", ""))).status, 200);
    // 한글 이름은 인코딩돼 나가고 풀려서 읽힌다
    const k = await srv.urlFor(dir, join(dir, "한글 폴더.html"));
    assert.ok(k?.endsWith("/" + encodeURIComponent("한글 폴더.html")));
    assert.equal((await get(k!)).body, "<p>k</p>");
    // 루트 밖 파일은 URL 자체를 안 만든다
    assert.equal(await srv.urlFor(dir, join(outside, "secret.txt")), null);
    // 루트 밖을 가리키는 심링크·.. 탈출·틀린 토큰·없는 파일
    assert.equal((await get(url!.replace("index.html", "escape/secret.txt"))).status, 404);
    assert.equal((await get(url!.replace("site/index.html", "..%2F..%2Fetc%2Fpasswd"))).status, 404);
    assert.equal((await get(url!.replace(/\/p\/[0-9a-f]{32}\//, "/p/" + "0".repeat(32) + "/"))).status, 404);
    assert.equal((await get(url!.replace("index.html", "missing.html"))).status, 404);
    // 다른 origin 의 페이지가 보내는 요청은 거부
    assert.equal((await get(url!, { headers: { origin: "http://evil.example" } })).status, 403);
    // 포트 숫자가 앞부분만 같은 다른 origin 도 거부
    const port = new URL(url!).port;
    assert.equal((await get(url!, { headers: { origin: `http://127.0.0.1:${port}1` } })).status, 403);
    assert.equal((await get(url!, { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
    // 점으로 시작하는 경로(.env·.git)는 주지 않고 URL 도 만들지 않는다
    assert.equal((await get(url!.replace("site/index.html", ".env"))).status, 404);
    assert.equal((await get(url!.replace("site/index.html", ".git/config"))).status, 404);
    assert.equal(await srv.urlFor(dir, join(dir, ".env")), null);
    // 저장소마다 토큰이 달라, 한 저장소의 미리보기로 다른 저장소의 파일을 읽을 수 없다
    const other = await srv.urlFor(outside, join(outside, "other.html"));
    assert.ok(other);
    const otherToken = new URL(other!).pathname.split("/")[2];
    const myToken = new URL(url!).pathname.split("/")[2];
    assert.notEqual(otherToken, myToken);
    assert.equal((await get(url!.replace("site/index.html", "other.html"))).status, 404);
    assert.equal((await get(other!.replace("other.html", "site/index.html"))).status, 404);
    assert.equal((await fetch(url!, { method: "POST" })).status, 405);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
