// 백그라운드 하위 에이전트가 일하는 동안 메인 턴이 끝났으면, 보낸 말은 대기열이 아니라 바로 들어가야 한다.
// 예전엔 하위 에이전트 소식이 올 때마다 탭이 "도는 중" 이 돼서, 하위 에이전트가 끝날 때까지 말이 대기열에 갇혔다.
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
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "백그라운드" + Date.now(), "--activate").tab.id;
  await page.evaluate((t) => window.sudal.chat.configure(t, { policy: "full" }), tab);
  const snap = () => page.evaluate((t) => window.sudal.chat.snapshot(t), tab);
  // 하위 에이전트 소식은 기록 파일에 남지 않는다 — 화면으로 오는 것을 직접 센다
  await page.evaluate((t) => {
    window.__sub = 0;
    window.sudal.chat.onEvent((env) => { if (env?.tabId === t && env.event?.type === "subagent_activity") window.__sub += 1; });
  }, tab);
  const subs = () => page.evaluate(() => window.__sub);

  cli("tab", "send", "--tab", tab, "--text",
    `Agent 도구를 run_in_background: true 로 한 번 써라. 하위 에이전트에게는 'Bash 도구로 node -e "setTimeout(()=>console.log(1),20000)" 을 다섯 번, 한 번에 하나씩 차례로 실행해라(run_in_background 쓰지 말 것). 다 끝나면 끝이라고 답해' 를 맡겨라. 너는 '맡겼어요' 한 마디만 하고 바로 턴을 끝내라. 기다리지 마라.`);

  // 메인 턴이 끝날 때까지
  let idleAt = 0;
  for (let i = 0; i < 120 && !idleAt; i++) { await sleep(1000); if ((await snap()).status === "idle") idleAt = Date.now(); }
  result("메인 턴이 먼저 끝난다", !!idleAt);

  // 하위 에이전트가 일하는 동안 30초 지켜본다 — 예전엔 여기서 "도는 중" 으로 올라갔다
  let wentBusy = false;
  for (let i = 0; i < 30; i++) { await sleep(1000); if ((await snap()).status === "running") wentBusy = true; }
  const bg = await page.evaluate(() => document.body.innerText.includes("백그라운드"));
  const subN = await subs();
  // 백그라운드 줄에 "하위 에이전트" 대신 에이전트 이름(general-purpose 등)이 보인다
  const barText = await page.evaluate(() => document.querySelector("[data-background-jobs]")?.textContent ?? "");
  console.log("백그라운드 줄:", JSON.stringify(barText.slice(0, 120)));
  result("백그라운드 줄에 에이전트 이름이 보인다", /general-purpose|[a-z]+-[a-z]+/.test(barText) && !barText.includes("하위 에이전트"), barText.slice(0, 80));
  console.log(`백그라운드 표시=${bg} · 지켜보는 동안 바빠짐=${wentBusy} · 그동안 온 하위 에이전트 소식 ${subN}개`);
  result("하위 에이전트 소식이 실제로 왔다(시험이 의미 있다)", subN > 0);
  result("하위 에이전트가 일해도 탭은 쉬는 상태다", !wentBusy);

  // 이때 보낸 말은 바로 들어가야 한다
  const r = cli("tab", "send", "--tab", tab, "--text", "'네' 한 마디만 답해라.", "--wait", "--timeout-ms", "90000");
  console.log("send:", JSON.stringify(r.send), "reply:", JSON.stringify(r.reply ?? r.wait?.reply ?? "").slice(0, 80));
  result("보낸 말이 대기열에 가지 않는다", r.send?.ok && !r.send.pending && !r.send.queued);
  result("하위 에이전트가 끝나기 전에 답한다", r.wait?.satisfied === true && Date.now() - idleAt < 115000, `${Math.round((Date.now() - idleAt) / 1000)}초`);

  await page.screenshot({ path: E2E + "/shot-bg-agent-send.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
