// 보안 점검 뒤 고친 두 가지를 실제 앱에서 본다.
// 1) 인앱 브라우저의 웹페이지는 위치·알림·클립보드 읽기 권한을 묻지 않고 얻지 못한다(기본 거부).
// 2) 채팅 답변 속 외부 이미지는 그리는 순간 불러오지 않고, "외부 이미지 불러오기" 를 눌러야 불러온다.
//    원격 이미지는 main 이 사설 주소를 막고 받으므로 공개 이미지(GitHub 아바타)로 본다.
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><meta charset=utf-8><title>perm</title><body>perm</body>");
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  const title = "보안" + Date.now();
  const tab = cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", title, "--activate").tab.id;
  await page.evaluate((t) => window.sudal.chat.configure(t, { policy: "full" }), tab);
  await page.waitForTimeout(1500);

  // ---------- 1) 브라우저 권한 ----------
  cli("browser", "open", "--tab", title, "--url", `${base}/perm`);
  await page.waitForTimeout(3500);
  const perms = await page.evaluate(async () => {
    const wv = [...document.querySelectorAll("webview")].find((w) => (w.getURL?.() ?? "").includes("/perm"));
    if (!wv) return null;
    return wv.executeJavaScript(`(async () => {
      const q = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return "error:" + e.name; } };
      const notif = await Notification.requestPermission();
      return { geolocation: await q("geolocation"), notifications: await q("notifications"), clipboardRead: await q("clipboard-read"), notifRequest: notif };
    })()`);
  });
  console.log("권한 상태:", JSON.stringify(perms));
  result("웹페이지를 찾았다(시험이 의미 있다)", !!perms);
  result("위치 권한은 거부", perms?.geolocation === "denied", perms?.geolocation);
  result("알림 권한은 거부", perms?.notifications === "denied" && perms?.notifRequest === "denied", `${perms?.notifications}/${perms?.notifRequest}`);
  result("클립보드 읽기는 거부", perms?.clipboardRead === "denied", perms?.clipboardRead);

  // ---------- 2) 채팅의 외부 이미지 ----------
  const img = "https://avatars.githubusercontent.com/u/9919?s=32";
  cli("tab", "send", "--tab", tab, "--text", `다음 한 줄만 그대로 답해. 다른 말은 하지 마.\n\n![logo](${img})`, "--wait", "--timeout-ms", "120000");
  await page.waitForTimeout(2000);
  const before = await page.evaluate(() => ({
    buttons: document.querySelectorAll("[data-remote-image]").length,
    imgs: document.querySelectorAll(".md img").length,
  }));
  console.log("누르기 전:", JSON.stringify(before));
  result("외부 이미지 자리에 버튼이 보인다", before.buttons >= 1, JSON.stringify(before));
  result("누르기 전에는 이미지를 불러오지 않는다(img 요소 자체가 없다)", before.imgs === 0, JSON.stringify(before));

  await page.click("[data-remote-image]");
  let shown = false;
  for (let i = 0; i < 20 && !shown; i++) {
    await page.waitForTimeout(500);
    shown = await page.evaluate(() => [...document.querySelectorAll(".md img")].some((i) => (i.getAttribute("src") ?? "").startsWith("data:image")));
  }
  result("누르면 그때 불러와 그린다", shown);

  await page.screenshot({ path: E2E + "/shot-security-hardening.png" });
  await b.close();
  srv.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
