// 브라우저 탭에 파비콘과 제목이 크롬처럼 나오는지. 제목은 원래 됐고 파비콘이 새로 붙었다.
// 렌더러 CSP 가 원격 이미지를 막으므로 main 이 data URL 로 바꿔 주는 경로를 함께 확인한다.
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

// 1x1 파란 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const srv = http.createServer((req, res) => {
  if (req.url === "/icon.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    return res.end(PNG);
  }
  if (req.url === "/huge.png") {
    // 상한(128KB)을 넘는 것 — 파비콘이 아니라고 보고 버려야 한다
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.alloc(200 * 1024, 1));
  }
  if (req.url === "/nofav") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><meta charset=utf-8><title>아이콘 없는 페이지</title><body>없음</body>");
  }
  if (req.url === "/big") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end('<!doctype html><meta charset=utf-8><title>너무 큰 아이콘</title><link rel="icon" href="/huge.png"><body>큼</body>');
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end('<!doctype html><meta charset=utf-8><title>파비콘 시험 페이지</title><link rel="icon" href="/icon.png"><body>본문</body>');
});

const tabInfo = (page) => page.evaluate(() => {
  const t = document.querySelector('[data-editor-tab][data-active="true"]') ?? document.querySelector("[data-editor-tab]");
  const img = t?.querySelector("[data-tab-favicon]");
  const addr = document.querySelector("[data-browser-url]");
  return {
    label: t?.querySelector("span")?.textContent ?? null,
    favicon: img ? (img.getAttribute("src") || "").slice(0, 24) : null,
    globe: !!t?.querySelector("svg"),
    addrFont: addr ? getComputedStyle(addr).fontFamily.split(",")[0].replace(/"/g, "") : null,
    addrSize: addr ? getComputedStyle(addr).fontSize : null,
  };
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port, base = `http://127.0.0.1:${port}`;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "파비콘", "--activate");
  await page.waitForTimeout(2200);

  cli("browser", "open", "--tab", "파비콘", "--url", `${base}/`);
  let a = null;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(500); a = await tabInfo(page); if (a.favicon) break; }
  console.log("파비콘 있는 페이지:", JSON.stringify(a));

  console.log("RESULT (제목이 탭에 나온다):", /파비콘 시험 페이지/.test(a.label ?? "") ? "PASS" : "FAIL");
  console.log("RESULT (파비콘이 탭에 나온다):", a.favicon ? "PASS" : "FAIL");
  console.log("RESULT (원격 주소가 아니라 data URL 이다):", (a.favicon ?? "").startsWith("data:image/") ? "PASS" : "FAIL");
  console.log("RESULT (주소창이 본문 폰트다):", a.addrFont === "Inter Variable" ? "PASS" : `FAIL (${a.addrFont})`);

  // 아이콘이 없는 페이지 → 지구본으로 돌아간다
  cli("browser", "open", "--tab", "파비콘", "--url", `${base}/nofav`);
  let n = null;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(500); n = await tabInfo(page); if (/아이콘 없는/.test(n.label ?? "")) break; }
  console.log("아이콘 없는 페이지:", JSON.stringify(n));
  console.log("RESULT (아이콘이 없으면 지구본으로 돌아간다):", !n.favicon && n.globe ? "PASS" : "FAIL");

  // 상한을 넘는 아이콘 → 버린다
  cli("browser", "open", "--tab", "파비콘", "--url", `${base}/big`);
  let h = null;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(500); h = await tabInfo(page); if (/너무 큰/.test(h.label ?? "")) break; }
  await page.waitForTimeout(1500);
  h = await tabInfo(page);
  console.log("상한 넘는 아이콘:", JSON.stringify(h));
  console.log("RESULT (128KB 넘는 아이콘은 안 쓴다):", !h.favicon ? "PASS" : "FAIL");

  await page.screenshot({ path: E2E + "/shot-favicon.png" });
  await b.close();
  srv.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
