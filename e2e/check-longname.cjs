// MCP 도구 이름은 길고 공백이 없다(mcp__playwright__playwright_evaluate).
// 공백이 없으면 감길 자리가 없어 상자 밖으로 넘칠 수 있다 — 앞선 검증은 Bash 처럼 짧은 이름만 봤다.
//
// 실제 MCP 서버 없이 재려고, 화면에 있는 요소를 복제해 글자만 긴 이름으로 바꿔 같은 자리에 넣고 잰다.
// 레이아웃 맥락(부모 폭·flex 규칙)이 원본과 같으므로 CSS 동작은 그대로 재현된다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

// 실제로 쓰이는 것 중 특히 긴 축. 공백이 없어 감길 자리가 없다.
const LONG = process.env.LONG || "mcp__plugin_oh-my-claudecode_t__merge_readiness_record_answer";

const probe = (page, long) => page.evaluate((LONG) => {
  const scroller = document.querySelector(".h-full.overflow-y-auto");
  if (!scroller) return { err: "목록 없음" };
  const cs = getComputedStyle(scroller);
  const right = scroller.getBoundingClientRect().right - parseFloat(cs.paddingRight || "0");

  const tryClone = (sel, setText) => {
    const src = document.querySelector(sel);
    if (!src) return null;
    const c = src.cloneNode(true);
    c.setAttribute("data-probe", "1");
    src.parentElement.insertBefore(c, src.nextSibling);
    setText(c);
    const r = c.getBoundingClientRect();
    // 안에서 가장 오른쪽까지 가는 자손을 찾는다(부모는 안 넘쳐도 글자가 삐져나올 수 있다)
    let maxRight = r.right;
    for (const el of c.querySelectorAll("*")) {
      const er = el.getBoundingClientRect();
      if (er.width > 0) maxRight = Math.max(maxRight, er.right);
    }
    const out = { height: Math.round(r.height), right: Math.round(r.right), innerRight: Math.round(maxRight), over: Math.round(maxRight - right) };
    c.remove();
    return out;
  };

  const thinking = tryClone("[data-thinking]", (c) => {
    const s = c.querySelector(".shimmer");
    if (s) s.textContent = `${LONG} 결과 보는 중`;
  });
  const card = tryClone("[data-tool-card]", (c) => {
    const name = c.querySelector("[data-tool-toggle] .font-medium");
    if (name) name.textContent = LONG;
  });
  return { listWidth: Math.round(scroller.getBoundingClientRect().width), contentRight: Math.round(right), thinking, card };
}, long);

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "긴이름", "--activate");
  await page.waitForTimeout(2500);
  const tabId = await page.evaluate(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));
  await page.evaluate((id) => window.workbench.chat.configure(id, { policy: "full" }), tabId);
  await page.evaluate(() => window.__sudalShortcut?.("toggle-sidebar"));
  await page.setViewportSize({ width: Number(process.env.W || 720), height: 760 });
  await page.waitForTimeout(600);

  cli("tab", "send", "--tab", "긴이름", "--text", "ls 를 실행하고 한 문장으로 설명해라.");

  let r = null;
  for (let i = 0; i < 160; i++) {
    await page.waitForTimeout(300);
    const p = await probe(page, LONG);
    if (p.err) continue;
    if (p.thinking || p.card) { r = p; if (p.thinking && p.card) break; }
  }
  if (!r) { console.log("RESULT: FAIL (잴 요소를 못 잡음)"); process.exit(1); }

  console.log(`창 ${process.env.W || 720}px · 목록 ${r.listWidth}px`);
  console.log("진행 표시(긴 이름):", JSON.stringify(r.thinking));
  console.log("도구 카드(긴 이름):", JSON.stringify(r.card));
  const ok = (x) => x === null || x.over <= 1;
  console.log("RESULT (진행 표시가 상자 밖으로 안 넘친다):", ok(r.thinking) ? "PASS" : `FAIL (${r.thinking.over}px 넘침)`);
  console.log("RESULT (도구 카드가 상자 밖으로 안 넘친다):", ok(r.card) ? "PASS" : `FAIL (${r.card.over}px 넘침)`);
  if (r.thinking === null) console.log("주의: 진행 표시를 못 잡음");
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
