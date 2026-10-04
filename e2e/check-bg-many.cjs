// 백그라운드가 여러 개일 때. 붙박이 줄은 늘 한 줄이어야 하고, 눌러서 펼치면 무엇이 도는지 다 보여야 한다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "여러개" + Date.now(), "--activate").tab.id;
  await page.waitForTimeout(2000);
  cli("tab", "send", "--tab", tab, "--text",
    "Bash 도구를 run_in_background:true 로 네 번 실행해라. 각각 `sleep 300 && echo 하나`, `sleep 300 && echo 둘`, `sleep 300 && echo 셋`, `sleep 300 && echo 넷` 이다. 기다리지 말고 '시작했습니다' 한 마디만 답해라.");

  const state = () => ev(() => {
    const bar = document.querySelector("[data-background-jobs]");
    if (!bar) return null;
    const toggle = bar.querySelector("[data-background-jobs-toggle]");
    return {
      n: Number(bar.getAttribute("data-background-jobs")),
      toggle: toggle ? toggle.getAttribute("data-background-jobs-toggle") : null,
      rows: bar.querySelectorAll("[data-background-job]").length,
      lines: Math.round(bar.getBoundingClientRect().height),
      text: (toggle?.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  });

  let s = null;
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); s = await state(); if (s && s.n >= 4) break; }
  console.log("접힌 상태:", JSON.stringify(s));
  result("여러 개가 한 줄로 접힌다", s?.toggle === "closed" && s.rows === 0, `(rows=${s?.rows})`);
  result("몇 개인지와 경과가 보인다", /4개/.test(s?.text ?? "") && /경과/.test(s?.text ?? ""), `(${s?.text})`);
  const collapsedH = s.lines;
  await page.screenshot({ path: E2E + "/shot-bg-many-접힘.png" });

  await ev(() => document.querySelector("[data-background-jobs-toggle]").click());
  await page.waitForTimeout(500);
  const open = await state();
  console.log("펼친 상태:", JSON.stringify(open));
  result("누르면 무엇이 도는지 다 보인다", open?.toggle === "open" && open.rows === 4, `(rows=${open?.rows})`);
  result("펼치면 더 높아진다", open.lines > collapsedH, `(${collapsedH} → ${open?.lines})`);
  await page.screenshot({ path: E2E + "/shot-bg-many-펼침.png" });

  await ev(() => document.querySelector("[data-background-jobs-toggle]").click());
  await page.waitForTimeout(400);
  const back = await state();
  result("다시 누르면 접힌다", back?.toggle === "closed" && back.rows === 0, `(rows=${back?.rows})`);

  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
