// 들여쓰기를 6px 늘렸으니 글 폭이 그만큼 줄었다. 좁은 창에서 가로로 넘치거나
// 푸터 한 줄이 깨지지 않는지 본다. 넘침은 "요소의 오른쪽 끝 > 담는 상자의 오른쪽 끝" 으로 잰다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const probe = (page) => page.evaluate(() => {
  const scroller = document.querySelector(".h-full.overflow-y-auto");
  if (!scroller) return { err: "목록을 못 찾음" };
  const box = scroller.getBoundingClientRect();
  const right = box.right - parseFloat(getComputedStyle(scroller).paddingRight || "0");
  const over = [];
  for (const el of scroller.querySelectorAll("[data-tool-card], [data-turn-elapsed], [data-thinking], [data-block-id], [data-verify-card], [data-review-card]")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > right + 1) over.push({ what: el.getAttribute("data-tool-card") || el.dataset.turnElapsed !== undefined ? "footer/tool" : el.tagName, over: Math.round(r.right - right) });
  }
  const footer = document.querySelector("[data-turn-elapsed]");
  const thinking = document.querySelector("[data-thinking]");
  return {
    listWidth: Math.round(box.width),
    hScroll: scroller.scrollWidth - scroller.clientWidth,
    overflowing: over,
    // 푸터가 한 줄인지 — 두 줄이 되면 높이가 대략 두 배가 된다
    footerHeight: footer ? Math.round(footer.getBoundingClientRect().height) : null,
    footerRight: footer ? Math.round(footer.getBoundingClientRect().right) : null,
    thinkingHeight: thinking ? Math.round(thinking.getBoundingClientRect().height) : null,
    contentRight: Math.round(right),
  };
});

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "줄바꿈", "--activate");
  await page.waitForTimeout(2500);
  const tabId = await page.evaluate(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));
  await page.evaluate((id) => window.workbench.chat.configure(id, { policy: "full" }), tabId);

  // 채팅 칼럼을 최대한 좁힌다: 사이드바를 접고 창을 줄인다.
  await page.evaluate(() => window.__sudalShortcut?.("toggle-sidebar"));
  await page.setViewportSize({ width: Number(process.env.W || 900), height: 760 });
  await page.waitForTimeout(800);

  cli("tab", "send", "--tab", "줄바꿈", "--text", "ls 를 실행하고, 결과를 세 문장 이상으로 길게 설명해라. 그다음 pwd 도 실행해라.");

  let worst = null;
  for (let i = 0; i < 160; i++) {
    await page.waitForTimeout(300);
    const p = await probe(page);
    if (p.err) continue;
    if (p.footerHeight !== null || p.thinkingHeight !== null) {
      if (!worst || p.overflowing.length > worst.overflowing.length) worst = p;
      if (p.footerHeight !== null && p.thinkingHeight !== null) break;
    }
  }
  if (!worst) { console.log("RESULT: FAIL (진행 중 화면을 못 잡음)"); process.exit(1); }

  console.log(`좁은 창(${process.env.W || 900}px):`, JSON.stringify(worst, null, 1));
  console.log("RESULT (가로 스크롤이 안 생긴다):", worst.hScroll <= 0 ? "PASS" : `FAIL (${worst.hScroll}px)`);
  console.log("RESULT (담는 상자 밖으로 넘치는 요소가 없다):", worst.overflowing.length === 0 ? "PASS" : `FAIL (${JSON.stringify(worst.overflowing)})`);
  console.log("RESULT (푸터가 한 줄이다):", worst.footerHeight === null || worst.footerHeight <= 24 ? "PASS" : `FAIL (높이 ${worst.footerHeight}px)`);

  await page.screenshot({ path: E2E + "/shot-wrap.png" });
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
