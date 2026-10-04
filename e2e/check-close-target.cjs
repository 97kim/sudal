// ⌘W: 에디터·브라우저를 보고 있으면 그 탭을 닫고, 채팅에 포커스가 있으면 세션을 닫는다.
// 네이티브 메뉴 가속기는 Playwright 로 못 누르므로, 앱이 그 단축키를 받았을 때와 같은 이벤트를 직접 쏴서 분기를 본다.
const os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "닫기", "--activate");
  await page.waitForTimeout(2000);

  // 브라우저 탭 둘을 연다
  cli("browser", "open", "--tab", "닫기", "--url", "https://example.com");
  await page.waitForTimeout(3000);
  cli("browser", "open", "--tab", "닫기", "--url", "https://example.org");
  await page.waitForTimeout(3000);

  const state = () => ev(() => ({
    editorTabs: [...document.querySelectorAll("[data-editor-tab]")].length,
    chatTabs: [...document.querySelectorAll("[data-tab]")].length,
    focusIsEditor: !!document.activeElement?.closest?.("[data-editor-pane-shell]"),
  }));

  const before = await state();
  console.log("처음:", JSON.stringify(before));
  console.log("RESULT (브라우저 탭 2개 열림):", before.editorTabs >= 2 ? "PASS" : `FAIL (${before.editorTabs})`);

  // 1) 브라우저를 클릭해 포커스를 에디터 패널에 둔다 (webview 안 클릭 → 호스트의 activeElement 가 <webview>)
  const box = await ev(() => {
    const w = [...document.querySelectorAll("webview")].map((x) => x.getBoundingClientRect()).find((r) => r.width > 50 && r.height > 50);
    return w ? { x: w.x + w.width / 2, y: w.y + w.height / 2 } : null;
  });
  if (box) await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(700);
  const focused = await state();
  console.log("브라우저 클릭 후:", JSON.stringify(await ev(() => ({ ae: document.activeElement?.tagName, inShell: !!document.activeElement?.closest?.("[data-editor-pane-shell]") }))));
  console.log("RESULT (webview 클릭이 에디터 포커스로 잡힘):", focused.focusIsEditor ? "PASS" : "FAIL");

  // 2) 그 상태에서 ⌘W → 브라우저 탭만 닫히고 채팅 세션은 남아야 한다
  await ev(() => window.__sudalShortcut?.("close-tab"));
  await page.waitForTimeout(900);
  const afterEditor = await state();
  console.log("에디터 포커스에서 ⌘W:", JSON.stringify(afterEditor));
  console.log("RESULT (에디터 탭이 닫힘):", afterEditor.editorTabs === before.editorTabs - 1 ? "PASS" : `FAIL (${before.editorTabs} → ${afterEditor.editorTabs})`);
  console.log("RESULT (채팅 세션은 유지):", afterEditor.chatTabs === before.chatTabs ? "PASS" : `FAIL (${before.chatTabs} → ${afterEditor.chatTabs})`);

  // 3) 채팅 입력창을 클릭해 포커스를 옮기면 ⌘W 는 세션을 닫는다
  await page.click("textarea");
  await page.waitForTimeout(500);
  const chatFocus = await state();
  console.log("RESULT (채팅 클릭이 채팅 포커스로):", chatFocus.focusIsEditor === false ? "PASS" : "FAIL");
  await ev(() => window.__sudalShortcut?.("close-tab"));
  await page.waitForTimeout(1200);
  const afterChat = await state();
  console.log("채팅 포커스에서 ⌘W:", JSON.stringify(afterChat));
  console.log("RESULT (채팅 세션이 닫힘):", afterChat.chatTabs === before.chatTabs - 1 ? "PASS" : `FAIL (${before.chatTabs} → ${afterChat.chatTabs})`);

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
