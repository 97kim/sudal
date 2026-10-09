import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { injectTsserverPath, parseLspFrames } from "./lsp";

const IS_WIN = process.platform === "win32";

/**
 * 가짜 언어 서버: --version 은 바로 답하고, 서버 모드는 죽일 때까지 기다린다.
 * Windows 는 sh 스크립트를 못 띄우니 npm 처럼 node 를 감싼 .cmd 로 — 앱이 cmd.exe 로 띄우는 경로를 그대로 탄다.
 */
function writeFakeServer(dir: string, name: string): string {
  if (IS_WIN) {
    const p = join(dir, `${name}.cmd`);
    writeFileSync(p, ["@echo off", 'if "%~1"=="--version" (echo 1.0.0& exit /b 0)', `"${process.execPath}" -e "setTimeout(() => {}, 600000)"`, ""].join("\r\n"));
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0.0; exit 0; }\nexec /bin/sleep 600\n');
  chmodSync(p, 0o755);
  return p;
}

/** Windows 의 서버 종료는 taskkill 을 거쳐 비동기다 — exit 통지를 고정 시간 대신 조건으로 기다린다. */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
}

/** node 가 SystemRoot 없이는 제대로 뜨지 않는다(Windows). macOS 에서는 lspChildEnv 가 버린다. */
const FAKE_ENV = { PATH: "", SystemRoot: process.env.SystemRoot };

test("parseLspFrames: 여러 프레임·잘린 프레임·한글 본문", () => {
  const body1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { 한글: "값" } });
  const body2 = JSON.stringify({ jsonrpc: "2.0", method: "x" });
  const frame = (b: string) => `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
  const all = Buffer.from(frame(body1) + frame(body2) + "Content-Length: 50\r\n\r\n{partial", "utf8");
  const r = parseLspFrames(all);
  assert.deepEqual(r.messages, [body1, body2]);
  assert.equal(r.rest.toString(), "Content-Length: 50\r\n\r\n{partial");
  // 이어서 나머지가 오면 완성된다
  const r2 = parseLspFrames(Buffer.concat([r.rest, Buffer.from("x".repeat(42))]));
  assert.equal(r2.messages.length, 1);
  assert.equal(r2.rest.length, 0);
});

test("injectTsserverPath: initialize 에만 tsserver.path 를 넣고, 있으면 유지, 다른 메시지는 그대로", () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: "file:///x", capabilities: {} } });
  const out = JSON.parse(injectTsserverPath(init, "/ts/lib")) as { params: { initializationOptions: { tsserver: { path: string } } } };
  assert.equal(out.params.initializationOptions.tsserver.path, "/ts/lib");
  const has = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { initializationOptions: { tsserver: { path: "/mine" } } } });
  assert.equal(injectTsserverPath(has, "/ts/lib"), has);
  const other = JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} });
  assert.equal(injectTsserverPath(other, "/ts/lib"), other);
  assert.equal(injectTsserverPath(init, null), init);
});

test("resolveTypescriptLib: 프로젝트 node_modules 는 맨 뒤 — 서버 동봉·전역이 있으면 그것을 쓴다", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveTypescriptLib, isExecutableFile, lspChildEnv } = await import("./lsp");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wb-lsp-"))); // 서버 경로는 realpath 로 풀려 나온다
  const mk = (p: string) => {
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "tsserver.js"), "");
  };
  const root = join(base, "proj");
  mk(join(root, "node_modules", "typescript", "lib"));
  const serverBin = join(base, "srv", "bin", "typescript-language-server");
  mkdirSync(join(base, "srv", "bin"), { recursive: true });
  writeFileSync(serverBin, "#!/bin/sh\n");
  chmodSync(serverBin, 0o755);
  // 서버 동봉 typescript 가 없으면 프로젝트 것으로 떨어진다
  assert.equal(resolveTypescriptLib(root, serverBin, { PATH: "" }), join(root, "node_modules", "typescript", "lib"));
  // 있으면 서버 동봉이 우선
  mk(join(base, "srv", "node_modules", "typescript", "lib"));
  assert.equal(resolveTypescriptLib(root, serverBin, { PATH: "" }), join(base, "srv", "node_modules", "typescript", "lib"));
  // 실행 파일 판정: 디렉토리·실행 비트 없는 파일은 아님(Windows 에는 실행 비트가 없어 X_OK 가 늘 통과한다)
  assert.equal(isExecutableFile(serverBin), true);
  assert.equal(isExecutableFile(join(base, "srv")), false);
  writeFileSync(join(base, "plain"), "");
  if (!IS_WIN) assert.equal(isExecutableFile(join(base, "plain")), false);
  // 자식 env 는 필요한 키만
  const env = lspChildEnv({ PATH: "/a", HOME: "/h", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "s2" });
  assert.deepEqual(env, { PATH: "/a", HOME: "/h" });
  rmSync(base, { recursive: true, force: true });
});

test("LspManager: spawn 실패도 servers 에서 지우고 onExit 를 알린다, 같은 루트 동시 start 는 하나만 뜬다", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { LspManager } = await import("./lsp");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wb-lspm-")));
  const exits: Array<[string, number | null]> = [];
  const mk = (bin: string) =>
    new LspManager({
      env: async () => FAKE_ENV,
      resolveRoot: async (cwd) => cwd,
      loadOverride: () => bin,
      // (typescript 로 취급)
      saveOverride: () => {},
      onMessage: () => {},
      onExit: (id, code) => exits.push([id, code]),
    });
  // 실행 비트만 있고 실제로는 없는 인터프리터를 가리키는 스크립트 → spawn 은 성공했다가 바로 실패(ENOENT)하거나 exit 127
  const bad = join(base, "bad");
  writeFileSync(bad, "#!/nonexistent/interpreter\n");
  chmodSync(bad, 0o755);
  const m = mk(bad);
  const r = await m.start(base, "typescript");
  assert.equal(r.ok, true);
  await until(() => exits.length > 0);
  assert.equal((await m.status())[0].running.length, 0, "죽은 서버가 running 에 남으면 안 된다");
  assert.equal(exits.length, 1);
  assert.equal(exits[0][0], (r as { id: string }).id);
  // 동시 start: 정상 서버(sleep 스크립트)로 두 번 부르면 id 가 같다
  const ok = writeFakeServer(base, "ok");
  const m2 = mk(ok);
  const [a, b] = await Promise.all([m2.start(base, "typescript"), m2.start(base, "typescript")]);
  assert.equal(a.ok && b.ok && a.id === b.id, true);
  assert.deepEqual((await m2.status())[0].running, [base]);
  m2.stopAll();
  assert.equal((await m2.status())[0].running.length, 0);
  await until(() => exits.length === 2); // 서버가 base 를 cwd 로 물고 있으면 Windows 에서 지워지지 않는다
  rmSync(base, { recursive: true, force: true });
});

test("LspManager: 열린 문서가 없으면 idleMs 뒤에 서버를 끄고, didOpen 이 있으면 살려 둔다", async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { LspManager, documentLifecycle } = await import("./lsp");
  assert.deepEqual(documentLifecycle(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///a.ts", text: "" } } })), { uri: "file:///a.ts", open: true });
  assert.deepEqual(documentLifecycle(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: "file:///a.ts" } } })), { uri: "file:///a.ts", open: false });
  assert.equal(documentLifecycle(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.ts" }, contentChanges: [{ text: '"textDocument/didOpen"' }] } })), null);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wb-lspidle-")));
  const ok = writeFakeServer(base, "ok");
  const exits: string[] = [];
  const m = new LspManager({
    env: async () => FAKE_ENV,
    resolveRoot: async (cwd) => cwd,
    loadOverride: () => ok,
    saveOverride: () => {},
    onMessage: () => {},
    onExit: (id) => exits.push(id),
    idleMs: 150,
  });
  // 문서를 열지 않으면 idle 로 꺼진다
  const r1 = await m.start(base, "typescript");
  assert.equal(r1.ok, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await m.status())[0].running.length, 0);
  await until(() => exits.length > 0);
  assert.deepEqual(exits, [(r1 as { id: string }).id]);
  // 문서가 열려 있으면 살아 있고, 닫으면 그때부터 idle 계산
  const r2 = await m.start(base, "typescript");
  assert.equal(r2.ok, true);
  const id = (r2 as { id: string }).id;
  const open = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///x.ts", languageId: "typescript", version: 1, text: "" } } });
  const close = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: "file:///x.ts" } } });
  assert.equal(m.send(id, open), true);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual((await m.status())[0].running, [base], "문서가 열려 있는 동안은 끄지 않는다");
  m.send(id, close);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await m.status())[0].running.length, 0, "마지막 문서를 닫으면 idleMs 뒤에 꺼진다");
  await until(() => exits.length === 2);
  assert.equal(exits.length, 2);
  rmSync(base, { recursive: true, force: true });
});

test("binFileNames: Windows 는 PATHEXT 확장자를 붙여 찾고, macOS 는 이름 그대로", async () => {
  const { binFileNames } = await import("./lsp");
  assert.deepEqual(binFileNames("pyright-langserver", "darwin"), ["pyright-langserver"]);
  assert.deepEqual(binFileNames("tls", "win32"), ["tls.com", "tls.exe", "tls.bat", "tls.cmd"]);
  assert.deepEqual(binFileNames("tls", "win32", ".EXE;.CMD;"), ["tls.exe", "tls.cmd"]);
});
