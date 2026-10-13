// 새 탭 기본 모델 검증. usage: node e2e/scenario-new-tab-model.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
//  A) 설정 > 일반에 Claude·Codex 줄이 있고, 처음엔 CLI 기본("")이다
//  B) Claude 를 opus 로 고르면 저장되고, 새 Claude 탭이 opus 로 시작한다
//  C) Codex 기본을 정하면 `tab new --provider codex`(provider 만 바뀌는 길)도 그 모델로 시작한다
//  D) --model 을 주면 그쪽이 먼저다
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-model-")));
const userData = path.join(tmp, "userdata");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: userData }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const results = [];
const res = (n, ok, x = "") => { results.push([n, ok]); log(`RESULT ${n}:`, ok ? "PASS" : "FAIL", x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc = null;
(async () => {
  proc = spawn(app + "/Contents/MacOS/Sudal", ["--remote-debugging-port=9333", `--user-data-dir=${userData}`], { stdio: "ignore", env: { ...process.env, SUDAL_E2E_MOCK_KEYCHAIN: "1", SUDAL_USERDATA: userData } });
  let b = null;
  for (let i = 0; i < 60 && !b; i++) { await sleep(500); try { b = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch {} }
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost")); if (!page) await sleep(250); }
  await page.waitForSelector("[data-sidebar]", { timeout: 20000 });
  const settings = () => page.evaluate(() => window.sudal.app.getSettings());
  const ws = cli("ws", "add", "--path", repo).workspaceId;

  // A
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "설정")?.click());
  await page.waitForSelector("[data-setting=new-tab-model] [data-new-tab-model=claude] select", { timeout: 10000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-new-tab-model]")].map((r) => ({ p: r.getAttribute("data-new-tab-model"), v: r.querySelector("select").value, n: r.querySelectorAll("option").length })));
  res("A (Claude·Codex 줄, 처음엔 CLI 기본)", rows.length === 2 && rows.every((r) => r.v === "" && r.n > 1), JSON.stringify(rows));

  // B
  await page.selectOption("[data-new-tab-model=claude] select", "opus");
  await sleep(500);
  const s1 = await settings();
  await page.locator("[data-setting=new-tab-model]").screenshot({ path: path.join(E2E, "shot-new-tab-model.png") });
  const tabB = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "기본모델").tab.id;
  const snapB = await page.evaluate((t) => window.sudal.chat.snapshot(t), tabB);
  res("B (opus 저장 → 새 Claude 탭이 opus)", s1.newTabModel.claude === "opus" && snapB.model === "opus", JSON.stringify({ saved: s1.newTabModel, model: snapB.model }));

  // C
  await page.evaluate(() => window.sudal.app.getSettings().then((s) => window.sudal.app.setSettings({ newTabModel: { ...s.newTabModel, codex: "gpt-6.1-sol" } })));
  await sleep(300);
  const tabC = cli("tab", "new", "--ws", ws, "--provider", "codex", "--title", "코덱스기본").tab.id;
  const snapC = await page.evaluate((t) => window.sudal.chat.snapshot(t), tabC);
  res("C (provider 만 codex 로 → Codex 기본 모델)", snapC.provider === "codex" && snapC.model === "gpt-6.1-sol", JSON.stringify({ provider: snapC.provider, model: snapC.model }));

  // D
  const tabD = cli("tab", "new", "--ws", ws, "--provider", "claude", "--model", "sonnet", "--title", "직접지정").tab.id;
  const snapD = await page.evaluate((t) => window.sudal.chat.snapshot(t), tabD);
  res("D (--model 이 먼저)", snapD.model === "sonnet", JSON.stringify({ model: snapD.model }));

  log(results.filter(([, ok]) => !ok).length === 0 ? "ALL PASS" : "FAILED: " + results.filter(([, ok]) => !ok).map(([n]) => n).join(", "));
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
  await b.close();
  proc.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; proc?.kill(); });
