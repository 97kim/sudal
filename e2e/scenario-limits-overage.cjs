// 사이드바 구독 한도의 추가 사용량 줄. usage: node e2e/scenario-limits-overage.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
//  A) 크레딧이 없어도(out_of_credits) 구독 한도가 남아 있으면 "크레딧 없음"을 회색으로 — 막힌 것처럼 빨갛게 보이지 않는다
//  B) 한도에 닿았으면 같은 줄을 빨간색으로
//  C·D) 조회 실패(fetch_error)는 "쓸 수 없음", 끈 경우(org_level_disabled 등)는 "꺼짐"
const os = require("os"), path = require("path"), fs = require("fs"), { spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const { chromium } = require("playwright-core");
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const results = [];
const res = (n, ok, x = "") => { results.push([n, ok]); log(`RESULT ${n}:`, ok ? "PASS" : "FAIL", x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = Math.floor(Date.now() / 1000) + 3600;

async function line(weeklyPercent, disabledReason = "out_of_credits") {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-overage-"));
  fs.writeFileSync(path.join(userData, "rate-limits.json"), JSON.stringify({
    claude: {
      session: { usedPercent: 16, windowMinutes: 300, resetsAt: later },
      weekly: { usedPercent: weeklyPercent, windowMinutes: 10080, resetsAt: later },
      modelWeekly: null,
      observedAt: Date.now(),
      overage: { enabled: true, inUse: false, status: "rejected", disabledReason },
    },
  }));
  const proc = spawn(app + "/Contents/MacOS/Sudal", ["--remote-debugging-port=9333", `--user-data-dir=${userData}`], { stdio: "ignore", env: { ...process.env, SUDAL_E2E_MOCK_KEYCHAIN: "1", SUDAL_USERDATA: userData } });
  try {
    let b = null;
    for (let i = 0; i < 60 && !b; i++) { await sleep(500); try { b = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch {} }
    let page = null;
    for (let i = 0; i < 40 && !page; i++) { page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost")); if (!page) await sleep(250); }
    await page.waitForSelector("[data-limits-overage]", { timeout: 20000 });
    const got = await page.evaluate(() => {
      const el = document.querySelector("[data-limits-overage]");
      return { text: el.textContent.trim(), red: el.className.includes("text-err") };
    });
    await b.close();
    return got;
  } finally {
    proc.kill();
    await sleep(800);
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

(async () => {
  const a = await line(76);
  res("A (한도가 남았으면 크레딧 없음을 회색으로)", a.text === "추가 사용량 크레딧 없음" && !a.red, JSON.stringify(a));
  const b = await line(100);
  res("B (한도에 닿았으면 빨간색)", b.text === "추가 사용량 크레딧 없음" && b.red, JSON.stringify(b));
  const c = await line(76, "fetch_error");
  res("C (조회 실패는 꺼짐이 아니라 쓸 수 없음)", c.text === "추가 사용량 쓸 수 없음" && !c.red, JSON.stringify(c));
  const d = await line(76, "org_level_disabled");
  res("D (관리자가 끈 경우는 꺼짐)", d.text === "추가 사용량 꺼짐" && !d.red, JSON.stringify(d));
  log(results.filter(([, ok]) => !ok).length === 0 ? "ALL PASS" : "FAILED: " + results.filter(([, ok]) => !ok).map(([n]) => n).join(", "));
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; });
