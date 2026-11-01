import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewServer } from "./preview-server";

async function get(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: await r.text() };
}

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
  try {
    assert.equal(await server.urlFor(root, join(directory, "index.html")), null);
    const url = await server.artifactUrlFor(root, join(directory, "index.html"));
    assert.ok(url);
    assert.equal((await get(url)).status, 200);
    assert.equal((await get(new URL("assets/main.js", url).href)).body, "window.preview = true;");
    for (const file of [".env", ".hidden/index.html", "escape/secret.html", "..%2Fgh-auth.cjs", "..%2Fsecret.html"]) assert.equal((await get(new URL(file, url).href)).status, 404, file);
    assert.equal(await server.artifactUrlFor(root, join(root, ".sudal", "secret.html")), null);
    assert.equal(await server.artifactUrlFor(root, join(directory, "escape", "secret.html")), null);
    assert.equal(await server.artifactUrlFor(root, join(directory, "assets", "main.js")), null);
    assert.equal(await server.artifactUrlFor(root, join(directory, ".hidden", "index.html")), null);
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
