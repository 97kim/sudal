// 우측 패널(변경 파일 목록)에서 파일을 열면 포커스는 그 버튼에 남는다.
// 그 상태의 ⌘W 가 세션이 아니라 에디터 탭을 닫아야 한다 — 사용자가 겪은 경우.
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  // 변경 파일이 있어야 우측 패널 목록에 뜬다
  fs.writeFileSync(path.join(E2E, "repo", "a.txt"), "고친 내용 " + Date.now() + "\n");

  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "패널", "--activate");
  await page.waitForTimeout(3000);

  const state = () => ev(() => ({
    editorTabs: [...document.querySelectorAll("[data-editor-tab]")].length,
    chatTabs: [...document.querySelectorAll("[data-tab]")].length,
    ae: document.activeElement?.tagName,
    focusIsEditor: !!document.activeElement?.closest?.("[data-editor-pane-shell]"),
  }));

  // 우측 패널의 변경 파일을 더블클릭해 연다 (열기 경로는 ContextPanel → openEditorFile)
  const opened = await ev(() => {
    const row = document.querySelector("[data-right-panel-wrap] [data-change-row], [data-right-panel-wrap] [data-file-row]");
    return row ? row.textContent?.trim().slice(0, 40) : null;
  });
  console.log("우측 패널의 변경 파일 행:", JSON.stringify(opened));
  if (opened) {
    await page.dblclick("[data-right-panel-wrap] [data-change-row], [data-right-panel-wrap] [data-file-row]");
  } else {
    // 행 선택자가 다르면 열기 아이콘을 찾는다
    await ev(() => document.querySelector("[data-right-panel-wrap] [data-open-file]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }
  await page.waitForTimeout(1500);

  const after = await state();
  console.log("파일 연 직후:", JSON.stringify(after));
  console.log("RESULT (에디터 탭이 열림):", after.editorTabs >= 1 ? "PASS" : "FAIL");
  console.log("RESULT (포커스는 에디터 밖 — 이게 원인이었다):", after.focusIsEditor === false ? "PASS (재현됨)" : "참고: 포커스가 에디터에 있음");

  await ev(() => window.__sudalShortcut?.("close-tab"));
  await page.waitForTimeout(1200);
  const closed = await state();
  console.log("⌘W 뒤:", JSON.stringify(closed));
  console.log("RESULT (에디터 탭이 닫힘):", closed.editorTabs === after.editorTabs - 1 ? "PASS" : `FAIL (${after.editorTabs} → ${closed.editorTabs})`);
  console.log("RESULT (채팅 세션은 유지):", closed.chatTabs === after.chatTabs ? "PASS" : `FAIL (${after.chatTabs} → ${closed.chatTabs})`);

  // 채팅을 건드리면 다시 세션 쪽으로
  await page.click("textarea");
  await page.waitForTimeout(400);
  await ev(() => window.__sudalShortcut?.("close-tab"));
  await page.waitForTimeout(1200);
  const last = await state();
  console.log("채팅 클릭 뒤 ⌘W:", JSON.stringify(last));
  console.log("RESULT (이번엔 세션이 닫힘):", last.chatTabs === closed.chatTabs - 1 ? "PASS" : `FAIL (${closed.chatTabs} → ${last.chatTabs})`);

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
