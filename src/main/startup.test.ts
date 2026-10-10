import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import type { Provider } from "@shared/ipc";

// Electron 전체를 실행하지 않고 실제 시작 코드와 IPC 진입점을 가져와 순서를 검증한다.
const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function statement(match: (node: ts.Statement) => boolean): string {
  const node = source.statements.find(match);
  assert.ok(node, "startup statement exists");
  return node.getText(source);
}
function fn(name: string): string {
  return statement((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
}
function variable(name: string): string {
  return statement((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name));
}
function ipcHandler(channel: string): string {
  let found = "";
  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "ipcMain.handle" && node.expression.arguments[0]?.getText(source) === `IPC.${channel}`) found = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, channel);
  return found;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const scan = deferred<void>();
  const cookies = deferred<number>();
  const app = new EventEmitter();
  let start!: () => Promise<void>;
  let ipcReady = false;
  const windows: { ipcReady: boolean; focused: number }[] = [];
  const createdTabs: Provider[][] = [];
  let find: (provider: Provider) => Promise<{ installed: boolean }> = async (provider) => {
    await scan.promise;
    return { installed: provider === "codex" };
  };
  const workspaces = {
    availableProviders: [] as Provider[],
    createTab: () => { createdTabs.push([...workspaces.availableProviders]); return "new-tab"; },
  };
  const ctx = createContext({
    app: Object.assign(app, {
      requestSingleInstanceLock: () => true,
      setAppUserModelId() {},
      isPackaged: true,
      getPath: () => "unused",
      whenReady: () => ({ then: (cb: () => Promise<void>) => { start = cb; } }),
    }),
    process: { platform: "win32", env: {} },
    console: { log() {}, error() {} },
    PROVIDERS: ["claude", "codex"], workspaces,
    cliDiscovery: () => ({ invalidate() {}, find: (provider: Provider) => find(provider) }),
    bootstrap() {}, registerIpc: () => { ipcReady = true; },
    buildMenu() {}, watchBrowserNetwork() {}, watchBrowserDownloads() {}, watchBrowserConsole() {},
    appSettings: () => ({ keepBrowserLogin: true }),
    session: { fromPartition() {} }, BROWSER_PARTITION: "test",
    restoreSessionCookies: () => cookies.promise,
    startBackgroundJobWatcher() {}, startSchedules() {}, startControlServer() {},
    cliStatus: async () => ({ installed: false }),
    createWindow: () => {
      const entry = { ipcReady, focused: 0 };
      windows.push(entry);
      return { isDestroyed: () => false, isMinimized: () => false, show() {}, focus: () => entry.focused++ };
    },
    IPC: { tabCreate: "tabCreate" },
    ipcMain: { handle: (_channel: string, handler: unknown) => { ctx.tabCreate = handler; } },
  });
  const code = [
    variable("mainWindow"), variable("mainWindowReady"), variable("cliDefaultsReady"),
    fn("refreshAvailableProviders"), fn("liveMainWindow"), fn("showMainWindow"),
    statement((s) => ts.isIfStatement(s) && s.expression.getText(source).includes("app.requestSingleInstanceLock()")),
    statement((s) => ts.isExpressionStatement(s) && s.getText(source).startsWith("app.whenReady().then(")),
    ipcHandler("tabCreate"),
  ].join("\n");
  runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return {
    app, scan, cookies, windows, createdTabs, workspaces,
    start: () => start(),
    tabCreate: () => ctx.tabCreate(null, "workspace") as Promise<string>,
    refresh: () => runInContext("refreshAvailableProviders()", ctx) as Promise<void>,
    ready: () => runInContext("cliDefaultsReady", ctx) as Promise<void>,
    setFind: (next: typeof find) => { find = next; },
  };
}

test("느린 CLI 탐색은 첫 창을 막지 않고 새 탭 생성만 기다린다", async () => {
  const h = harness();
  h.cookies.resolve(0);
  await h.start();
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].ipcReady, true);
  const tab = h.tabCreate();
  await Promise.resolve();
  assert.equal(h.createdTabs.length, 0);
  h.scan.resolve();
  assert.equal(await tab, "new-tab");
  assert.deepEqual(h.createdTabs, [["codex"]]);
});

test("초기화 전과 중간의 재실행 요청은 IPC 준비 후 첫 창 하나로 처리한다", async () => {
  const h = harness();
  h.app.emit("second-instance");
  const starting = h.start();
  h.app.emit("second-instance");
  h.app.emit("second-instance");
  assert.equal(h.windows.length, 0);
  h.cookies.resolve(0);
  await starting;
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].ipcReady, true);
  h.app.emit("second-instance");
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].focused, 1);
  h.scan.resolve();
  await h.ready();
});

test("연속 재탐색은 이전 탐색을 기다리고 마지막 결과를 적용한다", async () => {
  const h = harness();
  h.cookies.resolve(0);
  await h.start();
  const rescanned = h.refresh();
  h.setFind(async (provider) => ({ installed: provider === "claude" }));
  h.scan.resolve();
  await rescanned;
  assert.deepEqual([...h.workspaces.availableProviders], ["claude"]);
});

test("탐색 실패가 창이나 새 탭을 멈추지 않고 다음 재탐색으로 복구된다", async () => {
  const h = harness();
  h.setFind(async () => { throw new Error("discovery failed"); });
  h.cookies.resolve(0);
  await h.start();
  await h.tabCreate();
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.createdTabs, [[]]);
  h.setFind(async (provider) => ({ installed: provider === "codex" }));
  await h.refresh();
  assert.deepEqual([...h.workspaces.availableProviders], ["codex"]);
});
