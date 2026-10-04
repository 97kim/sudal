// 브라우저 "진단 첨부" 를 누르면 입력창에 긴 글이 붙는데 높이가 안 커진다는 제보.
// 보통 상태와 넓게 보기 상태를 나눠 잰다 — 넓게 보기면 채팅 칼럼이 CSS 로 숨겨져 있어
// scrollHeight 가 0 이 되고, 그 상태로 높이가 굳으면 돌아와도 한 줄로 남는다(가설).
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

// 콘솔 오류와 실패 요청이 있어야 진단에 담길 내용이 생긴다.
const srv = http.createServer((req, res) => {
  if (req.url !== "/") { res.writeHead(500); res.end("nope"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset=utf-8><title>진단 시험</title><body><h1>진단</h1>
    <script>
      for (let i = 0; i < 5; i++) console.error("일부러 낸 오류 " + i + " ${"y".repeat(60)}");
      fetch("/missing-1").catch(()=>{}); fetch("/missing-2").catch(()=>{});
    </script></body>`);
});

const H = (page) => page.evaluate(() => {
  const t = document.querySelector("textarea");
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { styleH: t.style.height, boxH: Math.round(r.height), scrollH: t.scrollHeight, len: t.value.length, visible: r.height > 0 };
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "진단", "--activate");
  await page.waitForTimeout(2000);
  cli("browser", "open", "--tab", "진단", "--url", `http://127.0.0.1:${port}/`);
  await page.waitForTimeout(4000);

  const clickDiag = async () => {
    const hit = await ev(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /진단 첨부|모으는 중/.test(b.textContent || ""));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!hit) { console.log("RESULT: FAIL (진단 첨부 버튼을 못 찾음)"); process.exit(1); }
    await page.waitForTimeout(4000);
  };

  // --- 1) 보통 상태 ---
  console.log("보통 · 첨부 전:", JSON.stringify(await H(page)));
  await clickDiag();
  const normal = await H(page);
  console.log("보통 · 첨부 후:", JSON.stringify(normal));
  console.log("RESULT (보통 상태에서 입력창이 커진다):", normal && normal.len > 100 && normal.boxH > 40 ? "PASS" : "FAIL");

  // 초기화: 입력창을 비운다
  await ev(() => {
    const t = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, "");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500);

  // --- 2) 넓게 보기 상태에서 첨부하고 돌아오기 ---
  await ev(() => window.__sudalShortcut?.("toggle-editor-maximize"));
  await page.waitForTimeout(800);
  console.log("넓게 보기 · 첨부 전:", JSON.stringify(await H(page)));
  await clickDiag();
  console.log("넓게 보기 · 첨부 후:", JSON.stringify(await H(page)));
  await ev(() => window.__sudalShortcut?.("toggle-editor-maximize"));
  await page.waitForTimeout(1000);
  const back = await H(page);
  console.log("돌아온 뒤:", JSON.stringify(back));
  console.log("RESULT (넓게 보기에서 붙여도 돌아오면 커져 있다):", back && back.len > 100 && back.boxH > 40 ? "PASS" : "FAIL");

  await page.screenshot({ path: E2E + "/shot-diag-composer.png" });
  await b.close();
  srv.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
