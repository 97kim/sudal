import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { notificationOptions, notificationTarget } from "./notification-target";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function named(name: string): string {
  const node = source.statements.find((s) =>
    (ts.isFunctionDeclaration(s) && s.name?.text === name) ||
    (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(source) === name)));
  assert.ok(node, name);
  return node.getText(source);
}

function harness(platform = "win32") {
  const notifications: FakeNotification[] = [];
  let activation!: (details: { type: string; arguments: string }) => void;
  class FakeNotification extends EventEmitter {
    static isSupported = () => true;
    static handleActivation = (cb: typeof activation) => { activation = cb; };
    constructor(readonly options: ReturnType<typeof notificationOptions>) { super(); notifications.push(this); }
    show() {}
  }
  const tabs = new Map([["open", { open: true }], ["closed", { open: false }]]);
  const actions: string[] = [];
  const sent: unknown[] = [];
  const win = { webContents: { send: (_channel: string, req: unknown) => sent.push(req) } };
  let live = true;
  const ctx = createContext({
    Notification: FakeNotification, notificationOptions, notificationTarget, process: { platform }, console: { log() {}, warn() {} },
    workspaces: {
      tab: (id: string) => tabs.get(id),
      reopenTab: (id: string) => { tabs.get(id)!.open = true; actions.push(`reopen:${id}`); },
      activateTab: (id: string) => actions.push(`activate:${id}`),
    },
    liveMainWindow: () => live ? win : null,
    createWindow: () => { live = true; actions.push("create"); return win; },
    showMainWindow: () => actions.push("show"),
    IPC: { controlOpen: "control:open", controlOpenReady: "control:open-ready" },
    ipcMain: { on: (_channel: string, cb: (event: unknown) => void) => { ctx.ready = cb; } },
  });
  const code = ["let mainWindow;", ...[
    "controlOpenReady", "pendingControlOpen", "liveNotifications", "deliverControlOpen",
    "openNotificationTab", "registerNotificationActivation", "notify",
  ].map(named)].join("\n");
  runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  // 실제 IPC 리스너를 검증한다. 다른 IPC 의존성은 실행하지 않는다.
  const register = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "registerIpc")!;
  const readyHandler = register.body!.statements.find((s) => s.getText(source).startsWith("ipcMain.on(IPC.controlOpenReady"))!;
  runInContext(ts.transpileModule(readyHandler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  runInContext("registerNotificationActivation()", ctx);
  return {
    actions, sent, notifications,
    notify: (id?: string) => { ctx.target = id; runInContext('notify("title", "body", target)', ctx); },
    click: (id: string | null) => activation({ type: "click", arguments: new URLSearchParams({ type: "click", sudal: "1", ...(id ? { tab: id } : {}) }).toString() }),
    ready: (main = true) => ctx.ready({ sender: main ? win.webContents : {} }),
    closeWindow: () => { live = false; runInContext("controlOpenReady = false", ctx); },
    retained: () => runInContext("liveNotifications.length", ctx),
  };
}

test("Windows 알림에 탭을 인코딩하고 제목·본문은 XML로 이스케이프한다", () => {
  const options = notificationOptions('A < B & "C"', "완료\u0000", "tab&한글", "win32");
  assert.ok(options.toastXml?.includes("A &lt; B &amp; &quot;C&quot;"));
  assert.ok(!options.toastXml?.includes("\u0000"));
  const args = /launch="([^"]+)"/.exec(options.toastXml!)![1].replace(/&amp;/g, "&");
  assert.equal(notificationTarget({ type: "click", arguments: args }), "tab&한글");
  assert.equal(notificationTarget({ type: "reply", arguments: args }), undefined);
  assert.equal(notificationTarget({ type: "click", arguments: "type=click&tag=old" }), undefined);
  assert.equal(notificationOptions("title", "x".repeat(250), undefined, "darwin").body?.length, 200);
  assert.equal(notificationOptions("title", "body", undefined, "darwin").toastXml, undefined);
});

test("Windows는 전역 클릭으로 이동하며 객체 클릭과 중복 처리하지 않는다", () => {
  const h = harness();
  h.ready();
  h.notify("open");
  h.notifications[0].emit("click");
  assert.deepEqual(h.actions, []);
  h.click("open");
  assert.deepEqual(h.actions, ["activate:open", "show"]);
  assert.equal(JSON.stringify(h.sent), '[{"kind":"tab","tabId":"open"}]');
});

test("알림 센터의 오래된 알림은 메모리 보관 한도와 무관하게 탭으로 이동한다", () => {
  const h = harness();
  h.ready();
  for (let i = 0; i < 25; i++) h.notify("open");
  assert.equal(h.retained(), 20);
  h.click("closed");
  assert.deepEqual(h.actions, ["reopen:closed", "activate:closed", "show"]);
});

test("재시작 후 객체가 없어도 클릭을 처리하고 렌더러가 준비될 때까지 보관한다", () => {
  const h = harness();
  h.closeWindow();
  h.click("closed");
  assert.deepEqual(h.actions, ["reopen:closed", "activate:closed", "create", "show"]);
  assert.deepEqual(h.sent, []);
  h.ready(false);
  assert.deepEqual(h.sent, [], "보조 창의 ready는 대기 요청을 소비하지 않는다");
  h.ready();
  h.ready();
  assert.equal(h.sent.length, 1);
});

test("삭제된 탭·탭 없는 알림은 창만 보여 주며 macOS는 객체 클릭을 유지한다", () => {
  const h = harness();
  h.click("deleted");
  h.click(null);
  assert.deepEqual(h.actions, ["show", "show"]);
  const mac = harness("darwin");
  mac.ready();
  mac.notify("open");
  mac.notifications[0].emit("click");
  assert.deepEqual(mac.actions, ["activate:open", "show"]);
});

test("렌더러 준비 전 들어온 여러 요청은 순서대로 한 번씩 전달한다", () => {
  const h = harness();
  h.click("open");
  h.click("closed");
  assert.equal(h.sent.length, 0);
  h.ready();
  assert.equal(JSON.stringify(h.sent), '[{"kind":"tab","tabId":"open"},{"kind":"tab","tabId":"closed"}]');
  h.ready();
  assert.equal(h.sent.length, 2);
});

test("알림 탭 요청은 설정 화면에서 채팅으로 전환하고 최대화된 에디터를 해제한다", () => {
  const app = ts.createSourceFile("App.tsx", readFileSync(new URL("../renderer/src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(app) === "window.sudal.app.onControlOpen") callback = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.ok(callback);
  const actions: unknown[] = [];
  const ctx = createContext({
    setView: (view: string) => actions.push(view),
    api: { activateTab: (id: string) => actions.push(id) },
    setEditorMaximized: (id: string, value: boolean) => actions.push([id, value]),
    openEditorFile: () => assert.fail("must not open file"),
    openBrowserTab: () => assert.fail("must not open browser"),
  });
  runInContext(ts.transpileModule(`const handle = ${callback.getText(app)}; handle({ kind: "tab", tabId: "open" });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  assert.deepEqual(actions, ["chat", "open", ["open", false]]);
});
