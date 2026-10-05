// 제보: 도구 카드 아래의 진행 표시·푸터 글자가 왼쪽으로 쏠려 보인다.
// 코드상으로는 셋 다 44px 이어야 한다(아바타 32 + gap 12 = ml-11). 실제 좌표를 재서 확인한다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const measure = (page) => page.evaluate(() => {
  const L = (el) => (el ? Math.round(el.getBoundingClientRect().left) : null);
  const card = document.querySelector("[data-tool-card]");
  const thinking = document.querySelector("[data-thinking]");
  // 진행 표시의 "글자"는 라벨 span 이다 — 컨테이너가 아니라 눈에 보이는 글의 왼쪽 끝을 잰다.
  const thinkingText = thinking?.querySelector(".shimmer");
  const thinkingTail = document.querySelector("[data-thinking-text]");
  const footer = document.querySelector("[data-turn-elapsed]");
  const footerText = footer?.querySelector(".shimmer");
  const avatar = document.querySelector("svg, img");
  const assistantText = [...document.querySelectorAll("[data-block-id]")].find((b) => !b.querySelector("[data-tool-card]"));
  return {
    toolCard: L(card),
    thinkingBox: L(thinking),
    thinkingText: L(thinkingText),
    thinkingTail: L(thinkingTail),
    footerBox: L(footer),
    footerText: L(footerText),
  };
});

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "정렬", "--activate");
  await page.waitForTimeout(2500);
  const tabId = await page.evaluate(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));
  // 도구를 쓰게 만든다. 승인 대기로 멈추지 않게 전부 자동으로.
  await page.evaluate((id) => window.sudal.chat.configure(id, { policy: "full" }), tabId);
  cli("tab", "send", "--tab", "정렬", "--text", "ls 로 이 디렉토리를 보고, 그다음 pwd 도 실행해라. 각 도구 전후로 한 문장씩 설명해라.");

  // 진행 표시("… 결과 보는 중")는 도구 사이에만 잠깐 보인다 — 자주 재서 잡히는 대로 모은다.
  let m = null, withThinking = null;
  for (let i = 0; i < 220; i++) {
    await page.waitForTimeout(250);
    const cur = await measure(page);
    if (cur.toolCard === null) continue;
    if (cur.footerBox !== null) m = cur;
    if (cur.thinkingText !== null && !withThinking) withThinking = cur;
    if (m && withThinking) break;
  }
  if (!m) { console.log("RESULT: FAIL (도구 카드와 푸터를 같이 못 잡음)"); process.exit(1); }
  if (withThinking) { m.thinkingBox = withThinking.thinkingBox; m.thinkingText = withThinking.thinkingText; m.thinkingTail = withThinking.thinkingTail; }

  console.log("왼쪽 좌표:", JSON.stringify(m, null, 1));
  await page.screenshot({ path: E2E + "/shot-align.png" });

  const ref = m.toolCard;
  const diff = (v) => (v === null ? null : v - ref);
  // 푸터는 맨 앞에 회전 표시가 있어 "글자" 는 그만큼 오른쪽이 맞다 — 상자 기준으로 잰다.
  // 진행 표시는 앞에 아이콘이 없으므로 글자가 곧 칼럼 시작이다.
  const checks = {
    "푸터 상자": diff(m.footerBox),
    "진행 표시 글자": diff(m.thinkingText),
    "진행 표시 본문": diff(m.thinkingTail),
  };
  console.log("도구 카드 기준 차이:", JSON.stringify(checks));
  const bad = Object.entries(checks).filter(([, d]) => d !== null && Math.abs(d) > 1);
  console.log("RESULT (아바타 없는 줄이 도구 카드와 같은 선에서 시작한다):", bad.length === 0 ? "PASS" : `FAIL (${bad.map(([k, d]) => `${k} ${d}px`).join(", ")})`);
  if (m.thinkingText === null) console.log("주의: 진행 표시를 못 잡았다 — 푸터만 확인됨");

  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
