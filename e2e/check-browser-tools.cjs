// 브라우저 편의 기능: 페이지 내 찾기(⌘F), 보기 폭 프리셋, 확대·축소.
const os = require("os"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset=utf-8><title>도구 시험</title><body>
    <h1>바나나</h1><p>바나나는 노랗다. 바나나 우유도 있다.</p><p>사과는 빨갛다.</p></body>`);
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "도구", "--activate");
  await page.waitForTimeout(2000);
  cli("browser", "open", "--tab", "도구", "--url", `http://127.0.0.1:${port}/`);
  await page.waitForTimeout(3500);

  // 브라우저를 클릭해 포커스를 준다
  const box = await ev(() => {
    const r = [...document.querySelectorAll("webview")].map((x) => x.getBoundingClientRect()).find((r) => r.width > 50);
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (box) await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(500);

  // 1) ⌘F — 브라우저를 보고 있으면 페이지 찾기가 열리고 대화 검색은 안 열린다
  await ev(() => window.__sudalShortcut?.("search"));
  await page.waitForTimeout(600);
  const findOpen = await ev(() => ({ find: !!document.querySelector("[data-browser-find]"), chatSearch: !!document.querySelector("[data-search-palette]") }));
  console.log("⌘F 뒤:", JSON.stringify(findOpen));
  console.log("RESULT (페이지 찾기가 열림):", findOpen.find ? "PASS" : "FAIL");
  console.log("RESULT (대화 검색은 안 열림):", findOpen.chatSearch === false ? "PASS" : "FAIL");

  await page.click("[data-browser-find-input]");
  await page.keyboard.type("바나나", { delay: 60 });
  await page.waitForTimeout(1500);
  const count = await ev(() => document.querySelector("[data-browser-find-count]")?.textContent?.trim());
  console.log("찾기 결과:", JSON.stringify(count));
  console.log("RESULT (3건을 찾음):", /\/3$/.test(count || "") ? "PASS" : `FAIL (${count})`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  console.log("RESULT (esc 로 닫힘):", await ev(() => !document.querySelector("[data-browser-find]")) ? "PASS" : "FAIL");

  // 2) 보기 폭 프리셋 — 패널이 좁으면(390px 미만) 프리셋이 의미가 없으므로 넓게 보기부터 켠다
  await page.click("[data-editor-maximize]");
  await page.waitForTimeout(900);
  const fullW = await ev(() => Math.round([...document.querySelectorAll("webview")].map((x) => x.getBoundingClientRect()).find((r) => r.width > 50)?.width ?? 0));
  // 보기 폭·확대는 ⋯ 메뉴 안에 있다
  await page.click("[data-browser-more]");
  await page.click('[data-browser-viewport-option="phone"]');
  await page.waitForTimeout(700);
  const phoneW = await ev(() => Math.round([...document.querySelectorAll("webview")].map((x) => x.getBoundingClientRect()).find((r) => r.width > 50)?.width ?? 0));
  console.log("폭:", fullW, "→", phoneW);
  console.log("RESULT (폰 폭으로 좁아짐):", phoneW > 0 && phoneW < fullW ? "PASS" : `FAIL (${fullW} → ${phoneW})`);
  console.log("RESULT (보기 폭 칩이 보임):", await ev(() => !!document.querySelector("[data-browser-viewport-chip]")) ? "PASS" : "FAIL");
  await page.click('[data-browser-viewport-option="full"]');
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const backW = await ev(() => Math.round([...document.querySelectorAll("webview")].map((x) => x.getBoundingClientRect()).find((r) => r.width > 50)?.width ?? 0));
  console.log("RESULT (전체로 복귀):", Math.abs(backW - fullW) < 5 ? "PASS" : `FAIL (${fullW} → ${backW})`);

  await page.click("[data-editor-maximize]");
  await page.waitForTimeout(700);

  // 3) 확대·축소
  const zoomOf = () => ev(() => document.querySelector("[data-browser-zoom]")?.getAttribute("data-browser-zoom"));
  await page.click("[data-browser-more]");
  console.log("처음 배율:", await zoomOf());
  await page.click("[data-browser-zoom] button:last-child");
  await page.waitForTimeout(500);
  const zoomed = await zoomOf();
  console.log("확대 뒤:", zoomed);
  console.log("RESULT (확대됨):", Number(zoomed) > 100 ? "PASS" : `FAIL (${zoomed})`);
  await page.click("[data-browser-zoom] button:nth-child(2)");
  await page.waitForTimeout(500);
  console.log("RESULT (100% 로 복귀):", (await zoomOf()) === "100" ? "PASS" : "FAIL");
  await page.keyboard.press("Escape");

  const s = await ev(() => window.sudal.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.sudal.workspaces.deleteTab(id), t.id); await ev((id) => window.sudal.workspaces.remove(id), w.id); }
  await b.close();
  srv.close();
})().catch((e) => { console.error("ERR", e.message); srv.close(); process.exit(1); });
