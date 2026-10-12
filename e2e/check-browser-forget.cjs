// 인앱 브라우저 방문 기록 지우기: 주소창 추천의 ×, 빈 탭 자주 간 곳의 ×, "방문 기록 모두 지우기".
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const serve = () => new Promise((r) => {
  const s = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><title>${req.url}</title>${req.url}`); });
  s.listen(0, "127.0.0.1", () => r(s));
});

(async () => {
  const [a, c] = [await serve(), await serve()];
  const A = `http://127.0.0.1:${a.address().port}`, C = `http://127.0.0.1:${c.address().port}`;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((x) => x.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  const title = "기록지우기" + Date.now();
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", title, "--activate");
  await page.waitForTimeout(2000);
  // 앞 시험이 남긴 기록을 먼저 비운다 — 빈 브라우저 탭의 "모두 지우기" 로
  await ev(() => document.querySelector("[data-editor-new-browser]")?.click());
  await page.waitForTimeout(1500);
  await ev(() => document.querySelector("[data-browser-clear-history]")?.click());
  await page.waitForTimeout(200);
  await ev(() => document.querySelector("[data-browser-clear-history-yes]")?.click());
  await page.waitForTimeout(300);
  cli("browser", "open", "--tab", title, "--url", `${A}/start`);
  await page.waitForTimeout(3000);
  for (const u of [`${A}/alpha`, `${A}/beta`, `${A}/alpha`, `${C}/other`]) {
    await ev((x) => [...document.querySelectorAll("webview")].find((w) => w.getBoundingClientRect().width > 50)?.loadURL(x).catch(() => {}), u);
    await page.waitForTimeout(1500);
  }

  // 1) 주소창 추천에서 × 로 한 주소만 지운다
  const typeAddr = (q) => ev((v) => {
    const inp = document.querySelector("[data-browser-url]");
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    inp.focus();
    set.call(inp, v);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, q);
  const sugUrls = () => ev(() => [...document.querySelectorAll("[data-browser-suggest] li")].map((li) => li.querySelector("button")?.textContent ?? ""));
  await typeAddr("beta");
  await page.waitForTimeout(500);
  const before = await sugUrls();
  await ev(() => document.querySelector("[data-browser-suggest] [data-browser-suggest-forget]")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await page.waitForTimeout(400);
  const after = await sugUrls();
  console.log("추천:", before, "→", after);
  result("추천의 × 로 그 주소가 사라진다", before.some((u) => u.startsWith(`${A}/beta`)) && !after.some((u) => u.startsWith(`${A}/beta`)));
  await ev(() => document.querySelector("[data-browser-url]")?.blur());

  // 2) 빈 탭의 자주 간 곳에서 × 로 한 사이트를 지운다
  await ev(() => document.querySelector("[data-editor-new-browser]")?.click());
  await page.waitForTimeout(1500);
  const sites = () => ev(() => [...document.querySelectorAll("[data-browser-frequent] [data-browser-frequent-forget]")].map((b) => b.getAttribute("title")));
  const s1 = await sites();
  const cPort = String(c.address().port);
  await ev((port) => {
    const btn = [...document.querySelectorAll("[data-browser-frequent-forget]")].find((b) => b.getAttribute("title")?.includes(port));
    btn?.click();
  }, cPort);
  await page.waitForTimeout(400);
  const s2 = await sites();
  console.log("자주 간 곳:", s1, "→", s2);
  result("자주 간 곳의 × 로 그 사이트가 사라진다", s1.some((t) => t.includes(cPort)) && !s2.some((t) => t.includes(cPort)) && s2.length === s1.length - 1);
  await page.screenshot({ path: E2E + "/shot-browser-forget.png" });

  // 3) 모두 지우기는 한 번 더 묻고 지운다
  await ev(() => document.querySelector("[data-browser-clear-history]")?.click());
  await page.waitForTimeout(300);
  const asked = await ev(() => !!document.querySelector("[data-browser-clear-history-yes]"));
  await ev(() => document.querySelector("[data-browser-clear-history-yes]")?.click());
  await page.waitForTimeout(400);
  const left = await ev(() => document.querySelectorAll("[data-browser-frequent-forget]").length);
  result("모두 지우기는 한 번 더 묻는다", asked);
  result("모두 지우면 자주 간 곳이 비고, 다시 열어도 비어 있다", left === 0);
  // 저장도 비었는지: 새 빈 탭을 하나 더 열어 본다
  await ev(() => document.querySelector("[data-editor-new-browser]")?.click());
  await page.waitForTimeout(1200);
  result("저장된 기록도 비었다", (await ev(() => document.querySelectorAll("[data-browser-frequent]").length)) === 0);

  await b.close();
  a.close();
  c.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
