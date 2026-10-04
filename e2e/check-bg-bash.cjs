// 백그라운드로 넘긴 명령이 화면에 남는가. 턴은 먼저 끝나고 명령만 계속 도는 구간이 문제였다 —
// 그때 탭이 놀고 있는 것처럼 보여서, 무엇이 도는지도 끝났는지도 알 수 없었다.
// 확인: (1) 턴이 끝난 뒤에도 표시가 남는다 (2) 무슨 일인지 알아볼 수 있다 (3) 끝나면 사라진다.
// 표시는 SDK 의 background_tasks_changed(살아 있는 전체 집합)를 그대로 갈아 끼운 결과다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };


const MARK = "백그라운드시험";

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "bg" + Date.now(), "--activate");
  await page.waitForTimeout(2500);
  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));

  const jobs = () => ev(() => {
    const wrap = document.querySelector("[data-background-jobs]");
    return {
      n: wrap ? Number(wrap.getAttribute("data-background-jobs")) : 0,
      text: wrap ? wrap.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : "",
    };
  });
  const status = () => ev(async (id) => (await window.workbench.chat.snapshot(id)).status, tabId).catch(() => null);

  cli("tab", "send", "--tab", tabId, "--text",
    `Bash 도구를 run_in_background:true 로 \`sleep 30 && echo ${MARK}\` 를 실행하고, 기다리지 말고 즉시 '시작했습니다' 한 마디만 답해라.`);

  // 턴이 끝날 때까지 (여기서부터가 문제의 구간이다)
  let st = null;
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); st = await ev((id) => window.workbench.chat.snapshot(id), tabId); if (st.status === "idle") break; }
  await page.waitForTimeout(1500);
  const idle = await jobs();
  console.log("턴이 끝난 뒤:", JSON.stringify({ status: st && st.status, ...idle }));
  result("턴이 끝나도 도는 명령이 보인다", idle.n > 0);
  result("무슨 일인지 알아볼 수 있다", /명령/.test(idle.text) && idle.text.replace(/\s+/g, "").length > 12, `(${idle.text})`);

  // 대화를 위로 올려도 보여야 한다 — 예전엔 대화 맨 끝에 있어 화면 밖으로 밀렸다.
  await ev(() => { const el = document.querySelector("[data-message-list]"); if (el) el.scrollTop = 0; });
  await page.waitForTimeout(500);
  const pinned = await ev(() => {
    const el = document.querySelector("[data-background-jobs]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight };
  });
  result("위로 올려 읽어도 표시가 보인다", !!pinned && pinned.bottom > 0 && pinned.top < pinned.h, `(${JSON.stringify(pinned)})`);

  await page.screenshot({ path: E2E + "/shot-bg-bash.png" });

  // 명령이 끝나면 목록에서 빠진다
  let gone = false;
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(2000); if ((await jobs()).n === 0) { gone = true; break; } }
  result("끝나면 표시가 사라진다", gone);

  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
