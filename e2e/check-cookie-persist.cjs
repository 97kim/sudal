// 앱을 껐다 켜면 로그인이 풀린다는 제보. partition 이 "persist:" 라 남아야 하는데 왜 끊기나.
// 만료 있는 쿠키(persistent)와 만료 없는 쿠키(session)를 따로 심고, 앱을 재시작해 무엇이 살아남는지 본다.
//
// 쓰는 법: node check-cookie-persist.cjs set   → 쿠키를 심고 확인
//          node check-cookie-persist.cjs check → (앱 재시작 뒤) 무엇이 남았는지
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

// 재시작 뒤에도 같은 출처여야 쿠키가 붙는다 — 포트를 고정한다.
const PORT = 45711;
const mode = process.argv[2] === "check" ? "check" : "set";

const srv = http.createServer((req, res) => {
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (req.url === "/set") {
    // 하나는 만료가 있고(디스크에 남을 수 있음), 하나는 없다(브라우저를 닫으면 사라지는 종류).
    res.writeHead(200, {
      ...headers,
      "set-cookie": [
        "persistent=P; Max-Age=86400; Path=/",
        "sessiononly=S; Path=/",
      ],
    });
    return res.end("<!doctype html><meta charset=utf-8><title>쿠키 심음</title><body>심었다</body>");
  }
  const got = req.headers.cookie ?? "";
  res.writeHead(200, headers);
  res.end(`<!doctype html><meta charset=utf-8><title>쿠키 확인</title><body>COOKIES[${got}]</body>`);
});

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const base = `http://127.0.0.1:${PORT}`;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  if (mode === "set") cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "쿠키", "--activate");
  await page.waitForTimeout(2200);

  const go = async (url) => {
    cli("browser", "open", "--tab", "쿠키", "--url", url);
    await page.waitForTimeout(3500);
  };
  // 웹뷰 안에서 직접 읽는다 — 서버가 받은 Cookie 헤더가 진짜 증거다.
  const body = () =>
    page.evaluate(() => {
      const wv = [...document.querySelectorAll("webview")].find((w) => w.getBoundingClientRect().width > 50);
      return wv ? wv.executeJavaScript("document.body.innerText").catch(() => "") : "";
    });

  if (mode === "set") {
    await go(`${base}/set`);
    await go(`${base}/show`);
    console.log("심은 직후:", (await body()).trim());
    console.log("이제 앱을 껐다 켜고 `node check-cookie-persist.cjs check` 를 실행하세요.");
  } else {
    await go(`${base}/show`);
    const t = (await body()).trim();
    console.log("재시작 뒤:", t);
    const hasP = /persistent=P/.test(t);
    const hasS = /sessiononly=S/.test(t);
    console.log("RESULT (만료 있는 쿠키가 살아남는다):", hasP ? "PASS" : "FAIL");
    console.log("RESULT (세션 쿠키가 살아남는다):", hasS ? "PASS" : "FAIL(종료 시 사라짐 — 이게 로그인이 풀리는 이유)");
  }

  await b.close();
  srv.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
