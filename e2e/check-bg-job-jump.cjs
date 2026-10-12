// 백그라운드 작업 줄을 누르면 그 작업을 띄운 하위 에이전트 카드로 간다(접혀 있으면 펼친다).
// job.id 는 SDK 의 task_id 라 tool_use 블록 id 와 다르다 — task_started 의 tool_use_id 를 따로 기억해 이어 붙인다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "백그라운드이동" + Date.now(), "--activate").tab.id;
  await page.evaluate((t) => window.sudal.chat.configure(t, { policy: "full" }), tab);
  const snap = () => page.evaluate((t) => window.sudal.chat.snapshot(t), tab);

  cli("tab", "send", "--tab", tab, "--text",
    `Task 도구를 run_in_background: true 로 한 번 써라(subagent_type: general-purpose). 하위 에이전트에게는 'Bash 도구로 node -e "setTimeout(()=>console.log(1),15000)" 을 세 번 차례로 실행해라' 를 맡겨라. 너는 '맡겼어요' 한 마디만 하고 바로 턴을 끝내라.`);

  let idleAt = 0;
  for (let i = 0; i < 90 && !idleAt; i++) { await sleep(1000); if ((await snap()).status === "idle") idleAt = Date.now(); }
  result("메인 턴이 끝난다", !!idleAt);

  await sleep(3000);
  const jobs = await page.evaluate(() => window.sudal.jobs.list());
  const job = jobs.find((j) => j.label === "general-purpose");
  result("백그라운드 작업에 띄운 tool_use 의 id 가 붙는다", !!job?.toolUseId, JSON.stringify(job));

  const before = await page.evaluate((id) => document.querySelector(`[data-tool-id="${id}"]`)?.getAttribute("data-tool-open"), job?.toolUseId);
  await page.click("[data-background-job]");
  await sleep(500);
  const after = await page.evaluate((id) => {
    const el = document.querySelector(`[data-tool-id="${id}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { open: el.getAttribute("data-tool-open"), inView: rect.top >= 0 && rect.top < window.innerHeight };
  }, job?.toolUseId);
  console.log("클릭 전 open:", before, "클릭 후:", JSON.stringify(after));
  result("줄을 누르면 접혀 있던 카드가 펼쳐진다", before === "false" && after?.open === "true");
  result("그 카드가 화면 안으로 스크롤된다", !!after?.inView);

  await page.screenshot({ path: E2E + "/shot-bg-job-jump.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
