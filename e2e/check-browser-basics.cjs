// 브라우저 기본기 셋: 강력 새로고침(캐시 무시), 주소창 기록·자동완성, 닫은 탭 다시 열기(⌘⇧T).
// 캐시 무시는 서버가 "캐시해도 된다" 고 말한 응답을 그래도 다시 받아 오는지로 잰다 — 요청 수를 센다.
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let hits = 0;
const cacheHeaders = [];
const srv = http.createServer((req, res) => {
  if (req.url === "/cached") {
    hits += 1;
    // 캐시 무시로 받아오면 Chromium 이 이 헤더를 붙인다 — 요청 수보다 확실한 증거다.
    cacheHeaders.push(`${req.headers["cache-control"] ?? "-"} / ${req.headers["pragma"] ?? "-"}`);
    // 한참 캐시해도 된다고 말한다 — 보통 새로고침이면 다시 안 물어봐야 한다.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" });
    res.end(`<!doctype html><meta charset=utf-8><title>캐시</title><body>hits=${hits}</body>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset=utf-8><title>${req.url}</title><body>${req.url}</body>`);
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "기본기", "--activate");
  await page.waitForTimeout(2000);

  // ---------- 1) 강력 새로고침 ----------
  cli("browser", "open", "--tab", "기본기", "--url", `${base}/cached`);
  await page.waitForTimeout(3500);
  const first = hits;
  // 보통 새로고침: 캐시가 살아 있으면 서버까지 안 온다
  await ev(() => window.__sudalShortcut?.("browser-reload"));
  await page.waitForTimeout(2500);
  const afterSoft = hits;
  // 강력 새로고침: 캐시를 무시하므로 반드시 서버까지 온다
  await ev(() => window.__sudalShortcut?.("browser-hard-reload"));
  await page.waitForTimeout(2500);
  const afterHard = hits;
  console.log(`요청 수: 최초 ${first} → 보통 새로고침 ${afterSoft} → 강력 새로고침 ${afterHard}`);
  console.log("요청 헤더(cache-control / pragma):", JSON.stringify(cacheHeaders));
  const hard = cacheHeaders[cacheHeaders.length - 1] ?? "";
  const soft = cacheHeaders[cacheHeaders.length - 2] ?? "";
  console.log("RESULT (강력 새로고침이 서버까지 간다):", afterHard > afterSoft ? "PASS" : "FAIL");
  console.log("RESULT (캐시 무시 헤더가 붙는다 — 보통 새로고침과 다르다):", /no-cache/.test(hard) && !/no-cache/.test(soft) ? "PASS" : "FAIL");

  // ---------- 2) 주소창 기록·자동완성 ----------
  for (const p of ["/alpha", "/beta", "/alpha"]) {
    await ev((u) => {
      const el = [...document.querySelectorAll("webview")].find((w) => w.getBoundingClientRect().width > 50);
      // 다음 탐색이 이전 것을 끊으면 loadURL 이 ERR_ABORTED 로 거부된다 — 검증과 무관하니 삼킨다.
      return el?.loadURL(u).catch(() => {});
    }, base + p);
    await page.waitForTimeout(1800);
  }
  // 주소창에 "alpha" 를 쳐서 목록이 뜨는지
  const sug = await ev(() => {
    const inp = document.querySelector("[data-browser-url]") ?? document.querySelector("form input.mono");
    if (!inp) return { err: "주소창 없음" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    inp.focus();
    setter.call(inp, "alpha");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true };
  });
  await page.waitForTimeout(600);
  const rows = await ev(() => [...document.querySelectorAll("[data-browser-suggest] button")].map((b) => b.textContent.trim()));
  console.log("자동완성:", JSON.stringify(sug), rows);
  console.log("RESULT (기록에서 자동완성이 뜬다):", rows.some((r) => r.includes("alpha")) ? "PASS" : "FAIL");
  console.log("RESULT (자주 간 곳에 횟수가 보인다):", rows.some((r) => /\d+회/.test(r)) ? "PASS" : "FAIL");

  // ---------- 3) 닫은 탭 다시 열기 ----------
  await ev(() => document.querySelector("[data-browser-url]")?.blur());
  await page.waitForTimeout(300);
  const before = await ev(() => document.querySelectorAll("[data-editor-tab]").length);
  // 활성 에디터 탭을 닫는다(⌘W 와 같은 경로)
  await ev(() => {
    const id = document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab");
    window.dispatchEvent(new CustomEvent("sudal:editor-close-active", { detail: id }));
  });
  await page.waitForTimeout(1200);
  const closed = await ev(() => document.querySelectorAll("[data-editor-tab]").length);
  await ev(() => window.__sudalShortcut?.("reopen-tab"));
  await page.waitForTimeout(2500);
  const reopened = await ev(() => ({
    tabs: document.querySelectorAll("[data-editor-tab]").length,
    url: document.querySelector("[data-browser-pane]")?.getAttribute("data-browser-pane") ?? null,
  }));
  console.log(`탭 수: ${before} → 닫고 ${closed} → 되살려 ${reopened.tabs} (주소 ${reopened.url})`);
  console.log("RESULT (닫으면 줄어든다):", closed < before ? "PASS" : "FAIL");
  console.log("RESULT (⌘⇧T 로 되살아난다):", reopened.tabs === before ? "PASS" : "FAIL");
  console.log("RESULT (보던 주소까지 되살아난다):", reopened.url && reopened.url.includes("alpha") ? "PASS" : "FAIL");

  await page.screenshot({ path: E2E + "/shot-browser-basics.png" });
  await b.close();
  srv.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
