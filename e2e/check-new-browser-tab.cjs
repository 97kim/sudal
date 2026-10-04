// 탭 띠의 "새 브라우저 탭" 버튼. + 대신 지구본으로 둔 이유는 파일이 아니라 브라우저만 열리기 때문.
// 확인: 파일을 연 상태에서도 버튼이 보이고, 누르면 브라우저 탭이 늘고, 주소창이 준비된다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const tabs = (page) => page.evaluate(() => ({
  total: document.querySelectorAll("[data-editor-tab]").length,
  browser: [...document.querySelectorAll("[data-editor-tab]")].filter((t) => /^(browser:|https?:)/i.test(t.getAttribute("data-editor-tab"))).length,
  button: !!document.querySelector("[data-editor-new-browser]"),
  buttonTitle: document.querySelector("[data-editor-new-browser]")?.getAttribute("title") ?? null,
  url: document.querySelector("[data-browser-pane]")?.getAttribute("data-browser-pane") ?? null,
  addressFocused: document.activeElement?.hasAttribute?.("data-browser-url") ?? false,
}));

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "새탭", "--activate");
  await page.waitForTimeout(2200);

  // 파일을 먼저 연다 — 코드와 브라우저가 섞인 상태에서도 버튼이 제자리에 있어야 한다.
  cli("file", "open", "--tab", "새탭", "--path", E2E + "/repo/a.txt");
  await page.waitForTimeout(2500);
  const withFile = await tabs(page);
  console.log("파일만 열린 상태:", JSON.stringify(withFile));

  // 버튼을 누른다
  await ev(() => document.querySelector("[data-editor-new-browser]")?.click());
  await page.waitForTimeout(1800);
  const after = await tabs(page);
  console.log("버튼 누른 뒤:", JSON.stringify(after));

  // 한 번 더 — 여러 개 열린다
  await ev(() => document.querySelector("[data-editor-new-browser]")?.click());
  await page.waitForTimeout(1800);
  const twice = await tabs(page);
  console.log("두 번 누른 뒤:", JSON.stringify(twice));

  console.log("RESULT (파일 탭만 있어도 버튼이 보인다):", withFile.button ? "PASS" : "FAIL");
  console.log("RESULT (무엇이 열리는지 툴팁에 있다):", /브라우저/.test(after.buttonTitle ?? "") ? "PASS" : "FAIL");
  console.log("RESULT (누르면 브라우저 탭이 는다):", after.browser === withFile.browser + 1 ? "PASS" : "FAIL");
  console.log("RESULT (파일 탭은 그대로다):", after.total === withFile.total + 1 ? "PASS" : "FAIL");
  console.log("RESULT (여러 개 열린다):", twice.browser === after.browser + 1 ? "PASS" : "FAIL");
  console.log("RESULT (빈 탭으로 열려 주소를 칠 수 있다):", after.url === "blank" || after.addressFocused ? "PASS" : `FAIL (url=${after.url}, focus=${after.addressFocused})`);

  await page.screenshot({ path: E2E + "/shot-new-browser-tab.png" });
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
