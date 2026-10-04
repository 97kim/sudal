// 사이드바 접기. 아주 없애지 않고 얇은 띠로 두는 이유는 macOS 신호등 버튼(hiddenInset, x=14)이
// 본문을 덮지 않게 자리를 지켜야 해서다 — 그래서 폭이 0 이 아니라 신호등보다 넓은지까지 본다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const state = (page) => page.evaluate(() => {
  const el = document.querySelector("[data-sidebar]");
  const chat = document.querySelector("[data-tab]")?.closest("div");
  return {
    mode: el?.getAttribute("data-sidebar") ?? null,
    width: el ? Math.round(el.getBoundingClientRect().width) : 0,
    toggle: !!document.querySelector("[data-sidebar-toggle]"),
    chatLeft: chat ? Math.round(chat.getBoundingClientRect().left) : null,
  };
});

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "사이드바", "--activate");
  await page.waitForTimeout(2000);

  const open = await state(page);
  console.log("펼침:", JSON.stringify(open));

  // 버튼으로 접기
  await ev(() => document.querySelector("[data-sidebar-toggle]")?.click());
  await page.waitForTimeout(600);
  const railed = await state(page);
  console.log("접힘:", JSON.stringify(railed));

  // ⌘B 로 다시 펼치기
  await ev(() => window.__sudalShortcut?.("toggle-sidebar"));
  await page.waitForTimeout(600);
  const reopened = await state(page);
  console.log("⌘B 뒤:", JSON.stringify(reopened));

  // 접은 채로 재시작해도 유지되는지 — 접어 두고 끝낸다
  await ev(() => window.__sudalShortcut?.("toggle-sidebar"));
  await page.waitForTimeout(600);
  const persisted = await state(page);

  console.log("RESULT (접으면 좁아진다):", railed.mode === "collapsed" && railed.width < open.width ? "PASS" : "FAIL");
  console.log("RESULT (본문이 넓어진다):", railed.chatLeft !== null && open.chatLeft !== null && railed.chatLeft < open.chatLeft ? "PASS" : "FAIL");
  console.log("RESULT (신호등 자리를 남긴다 — 폭 > 28):", railed.width > 28 ? "PASS" : "FAIL");
  console.log("RESULT (접힌 상태에도 펼치기 버튼이 있다):", railed.toggle ? "PASS" : "FAIL");
  console.log("RESULT (⌘B 로 다시 펼쳐진다):", reopened.mode === "expanded" && reopened.width === open.width ? "PASS" : "FAIL");
  console.log("RESULT (다시 접힌다):", persisted.mode === "collapsed" ? "PASS" : "FAIL");

  await page.screenshot({ path: E2E + "/shot-sidebar-rail.png" });
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
