// 회차 완료 판정을 위한 실측: 백그라운드 후속 턴이 있는 실행의 SDK 메시지 순서를 잡는다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const kind = process.argv[2] || "bg";
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", `추적-${kind}-${Date.now()}`, "--activate").tab.id;
  await page.waitForTimeout(2000);
  console.log("TAB", tab.slice(0, 6));
  const prompt = kind === "bg"
    ? "Bash 도구를 run_in_background:true 로 `sleep 15 && echo 끝` 실행하고, 기다리지 말고 '시작' 한 마디만. 그 명령이 끝나면 결과를 한 줄로 알려라."
    : "'안녕' 한 마디만 답해라. 도구는 쓰지 마라.";
  cli("tab", "send", "--tab", tab, "--text", prompt);
  const status = () => ev(async (t) => (await window.workbench.chat.snapshot(t)).status, tab);
  for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); if ((await status()) === "idle") break; }
  console.log("첫 턴 끝");
  if (kind === "bg") { for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); } }
  console.log("관찰 종료");
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
