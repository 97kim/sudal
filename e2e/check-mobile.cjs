// 휴대폰에서 이어 쓰기: 짝짓기 → 탭 목록 → 휴대폰에서 보내기 → 권한 시트로 허용 → 중단 → 닫힌 탭 거부 → 기기 끊기.
// 서버는 이 Mac 의 Tailscale 주소에만 열린다 — Tailscale 이 없으면 건너뛴다. 휴대폰 화면은 휴대폰 크기 Chrome 으로 띄운다.
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const until = async (fn, ms = 30000, step = 300) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); } return null; };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  await ev(() => window.sudal.app.setSettings({ mobileAccess: true }));
  const st = await until(async () => { const s = await ev(() => window.sudal.mobile.status()); return s.urls.length || s.error ? s : null; }, 15000);
  if (!st?.urls.length) {
    console.log(`SKIP: 휴대폰 서버가 열리지 않았어요(${st?.error ?? "시간 초과"}). Tailscale 이 켜진 Mac 에서 돌리세요.`);
    await b.close();
    process.exit(0);
  }
  const base = st.urls[0];
  console.log("서버:", base);

  // 잘못된 코드는 401, 맞는 코드는 토큰
  const pair = (code) => fetch(base + "/api/pair", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ code, name: "e2e" }) });
  const { code } = (await ev(() => window.sudal.mobile.newCode())).code;
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  result("틀린 코드는 거부", (await pair(wrong)).status === 401);
  const paired = await (await pair(code)).json();
  result("맞는 코드로 연결", typeof paired.token === "string" && paired.token.length > 20);
  result("코드는 한 번만", (await pair(code)).status === 401);
  const auth = { authorization: `Bearer ${paired.token}` };
  // DNS 리바인딩: 같은 주소로 닿아도 Host 가 다른 이름이면 거부(fetch 는 Host 를 못 바꿔 http 로 보낸다)
  const u = new URL(base);
  const otherHost = await new Promise((res) => require("http").get({ host: u.hostname, port: u.port, path: "/api/tabs", headers: { ...auth, host: "evil.example:" + u.port } }, (r) => { r.resume(); res(r.statusCode); }).on("error", () => res(0)));
  result("다른 Host 이름으로 닿으면 거부", otherHost === 403, String(otherHost));

  // 권한을 묻는 탭을 하나 만든다
  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const title = "휴대폰" + Date.now();
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", title).tab.id;
  await ev((t) => window.sudal.chat.configure(t, { policy: "ask" }), tab);
  const file = path.join(E2E, "repo", `mobile-${Date.now()}.txt`);

  // 휴대폰 화면
  const phone = await chromium.launch({ channel: "chrome" });
  const ctx = await phone.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = await ctx.newPage();
  await m.goto(base + "/");
  result("처음엔 연결 화면", !!(await m.waitForSelector("[data-mobile-code]", { timeout: 10000 }).catch(() => null)));
  await m.evaluate((t) => localStorage.setItem("sudal.mobile.token", t), paired.token);
  await m.reload();
  const row = await m.waitForSelector(`[data-mobile-tab="${tab}"]`, { timeout: 10000 }).catch(() => null);
  result("탭 목록에 새 탭이 보인다", !!row);
  await m.screenshot({ path: E2E + "/shot-mobile-tabs.png" });
  await row?.tap();
  await m.waitForSelector("[data-mobile-input]");

  // 휴대폰에서 보낸다 → 앱 탭이 권한을 묻는다 → 휴대폰 시트가 뜬다
  await m.fill("[data-mobile-input]", `Write 도구로 ${file} 파일을 만들고 내용은 '폰' 한 단어로 해라. 끝나면 '끝' 한 마디만.`);
  await m.tap("[data-mobile-send]");
  const sheet = await m.waitForSelector("[data-mobile-permission]", { timeout: 90000 }).catch(() => null);
  result("권한 시트가 뜬다", !!sheet);
  const preview = sheet ? await m.textContent("[data-mobile-permission-preview]") : "";
  result("시트에 만들 파일 경로가 보인다", preview.includes(path.basename(file)), preview.slice(0, 120));
  result("시트에 작업 폴더가 보인다", !!(await m.$("[data-mobile-permission-cwd]")));
  await m.screenshot({ path: E2E + "/shot-mobile-permission.png" });
  if (sheet) await m.tap("[data-mobile-permission] button:last-child");
  const idle = await until(async () => (await ev(async (t) => (await window.sudal.chat.snapshot(t)).status, tab)) === "idle", 120000, 1000);
  result("허용하면 파일이 생기고 턴이 끝난다", !!idle && fs.existsSync(file));
  result("휴대폰에도 답이 실시간으로 온다", !!(await until(async () => (await m.textContent("main"))?.includes("끝"), 15000)));
  await m.screenshot({ path: E2E + "/shot-mobile-chat.png" });

  // 오래 걸리는 일을 휴대폰에서 중단한다
  // 백그라운드로 돌리면 턴이 바로 끝나 중단할 게 없다 — 포그라운드로 못박는다
  await m.fill("[data-mobile-input]", "Bash 도구로 `sleep 60` 을 실행해라. run_in_background 는 쓰지 말고 끝날 때까지 기다려라. 끝나면 '다 잤다' 라고만 말해라.");
  await m.tap("[data-mobile-send]");
  // 권한을 물으면 허용해서 실제로 오래 걸리게 하고, 명령이 돌기 시작하면 중단한다
  let tapped = false;
  const t0 = Date.now();
  while (!tapped && Date.now() - t0 < 60000) {
    if (await m.$("[data-mobile-permission]")) await m.tap("[data-mobile-permission] button:last-child").catch(() => {});
    else if ((await ev(async (t) => (await window.sudal.chat.snapshot(t)).status, tab)) === "running" && (await m.textContent("main"))?.includes("sleep")) {
      await m.waitForTimeout(2000);
      if (!(await m.$("[data-mobile-permission]")) && (await m.$("[data-mobile-stop]"))) {
        await m.tap("[data-mobile-stop]");
        tapped = true;
      }
    }
    await m.waitForTimeout(500);
  }
  const stopped = await until(async () => (await ev(async (t) => (await window.sudal.chat.snapshot(t)).status, tab)) !== "running", 20000);
  result("휴대폰에서 중단", tapped && !!stopped && Date.now() - t0 < 55000, `tapped=${tapped}`);

  // 닫은 탭에는 예전 id 로도 보내지 못한다
  await until(async () => (await ev(async (t) => (await window.sudal.chat.snapshot(t)).status, tab)) === "idle", 20000);
  cli("tab", "close", "--tab", tab);
  const sendClosed = await fetch(`${base}/api/tabs/${tab}/send`, { method: "POST", headers: { ...auth, origin: base, "content-type": "application/json" }, body: JSON.stringify({ text: "다시 살아나라" }) });
  result("닫은 탭에는 보낼 수 없다", sendClosed.status === 409, String(sendClosed.status));
  result("닫은 탭 대화도 읽을 수 없다", (await fetch(`${base}/api/tabs/${tab}/events`, { headers: auth })).status === 404);

  // 기기를 끊으면 휴대폰은 연결 화면으로 돌아간다
  await m.goto(base + "/");
  await m.waitForSelector("[data-mobile-tab]", { timeout: 10000 }).catch(() => null);
  await ev((id) => window.sudal.mobile.revoke(id), paired.device.id);
  result("기기를 끊으면 연결 화면으로", !!(await m.waitForSelector("[data-mobile-code]", { timeout: 15000 }).catch(() => null)));
  result("끊은 토큰은 거부", (await fetch(base + "/api/tabs", { headers: auth })).status === 401);

  await phone.close();
  await ev(() => window.sudal.app.setSettings({ mobileAccess: false }));
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
