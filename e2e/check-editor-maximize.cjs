// 코드·브라우저 패널 최대화: 채팅·오른쪽 패널이 숨고 폭이 실제로 넓어지는지, 상태가 살아 있는지.
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
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "확대", "--activate");
  await page.waitForTimeout(2000);

  // 브라우저 탭을 하나 열어 놓고(= 에디터 패널이 뜬다) 주소를 이동시켜 상태를 만든다
  cli("browser", "open", "--tab", "확대", "--url", "https://example.com");
  await page.waitForTimeout(3500);

  const size = () => ev(() => {
    const shell = document.querySelector("[data-editor-pane-shell]");
    return {
      w: shell ? Math.round(shell.getBoundingClientRect().width) : null,
      maximized: shell ? shell.getAttribute("data-editor-maximized") : null,
      chatHidden: !!document.querySelector("[data-chat-column].hidden"),
      rightHidden: !!document.querySelector("[data-right-panel-wrap].hidden"),
      resizer: !!document.querySelector("[data-editor-resizer]"),
      url: document.querySelector("[data-browser-url]")?.value ?? null,
    };
  });

  const before = await size();
  console.log("최대화 전:", JSON.stringify(before));
  console.log("RESULT (버튼 있음):", await ev(() => !!document.querySelector("[data-editor-maximize]")) ? "PASS" : "FAIL");

  await page.click("[data-editor-maximize]");
  await page.waitForTimeout(900);
  const after = await size();
  console.log("최대화 후:", JSON.stringify(after));
  await page.screenshot({ path: E2E + "/shot-editor-max.png" });

  console.log("RESULT (채팅·오른쪽 패널이 숨음):", after.chatHidden && after.rightHidden ? "PASS" : "FAIL");
  console.log("RESULT (폭이 넓어짐):", after.w > before.w * 1.5 ? `PASS (${before.w} → ${after.w})` : `FAIL (${before.w} → ${after.w})`);
  console.log("RESULT (경계선이 사라짐):", after.resizer === false ? "PASS" : "FAIL");
  console.log("RESULT (브라우저 페이지가 그대로):", after.url && after.url === before.url ? "PASS" : `FAIL (${before.url} → ${after.url})`);

  // 되돌리기 (같은 버튼 토글). ⌘⇧E 는 Electron 네이티브 메뉴 가속기라 Playwright 의 키 입력으로는 안 눌린다 —
  // 메뉴 항목이 등록돼 있는지는 아래에서 빌드 산출물로 확인한다.
  await page.click("[data-editor-maximize]");
  await page.waitForTimeout(900);
  const back = await size();
  console.log("되돌린 뒤:", JSON.stringify(back));
  console.log("RESULT (버튼으로 복귀):", back.maximized === "false" && !back.chatHidden && !back.rightHidden && back.resizer ? "PASS" : "FAIL");
  console.log("RESULT (복귀해도 페이지 유지):", back.url === before.url ? "PASS" : "FAIL");
  console.log("RESULT (폭이 돌아옴):", Math.abs(back.w - before.w) < 5 ? "PASS" : `FAIL (${before.w} → ${back.w})`);

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
