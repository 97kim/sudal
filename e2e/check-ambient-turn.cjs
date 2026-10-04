// 우리가 시작하지 않은 턴도 화면에 보이는가.
// 백그라운드 작업이 끝나면 CLI 가 스스로 이어서 일하는데, 예전에는 그 턴을 통째로 버려서
// "다 끝났는데 화면엔 아무 말도 없는" 상태가 됐다(실제로 릴리즈 완료 보고가 8분간 안 보였다).
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const MARK = "백그라운드가끝났다";

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "이어받기" + Date.now(), "--activate").tab.id;
  await page.waitForTimeout(2000);

  const status = () => ev(async (t) => (await window.workbench.chat.snapshot(t)).status, tab);
  const blocks = () => ev(() => document.querySelectorAll("[data-block-id]").length);
  const bodyHas = (s) => ev((m) => document.body.innerText.includes(m), s);

  cli("tab", "send", "--tab", tab, "--text",
    `Bash 도구를 run_in_background:true 로 \`sleep 20 && echo ${MARK}\` 실행해라. 기다리지 말고 '시작했습니다' 한 마디만 답해라. 그 명령이 끝나면 결과 문구를 그대로 한 줄로 알려 줘라.`);

  for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); if ((await status()) === "idle") break; }
  const n0 = await blocks();
  console.log("첫 턴이 끝난 뒤 블록:", n0);
  result("첫 턴이 끝난다", n0 > 0);

  // 여기서부터가 본론 — 아무도 말을 걸지 않았는데 백그라운드가 끝나면 이어서 일해야 한다
  let woke = false, n1 = n0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    n1 = await blocks();
    if (n1 > n0) { woke = true; break; }
  }
  console.log(`말을 걸지 않고 기다린 결과: 블록 ${n0} → ${n1}`);
  result("백그라운드가 끝나면 화면이 이어진다", woke, `(블록 ${n0} → ${n1})`);

  for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); if ((await status()) === "idle") break; }
  const said = await bodyHas(MARK);
  console.log("결과 문구가 화면에 있나:", said);
  result("그 턴의 내용이 화면에 남는다", said);

  await page.screenshot({ path: E2E + "/shot-ambient-turn.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
