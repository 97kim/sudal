// 화면 이동 요청(sudal file open·알림 클릭)이 메인 창의 이동 뒤에도 전달되는지. usage: node e2e/scenario-control-open-nav.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
//  A) 앱이 막은 이동(will-navigate) 뒤에도 file open 이 열린다 — 이동 "시작"만으로 준비를 풀면 요청이 대기열에 갇혔다
//  B) 실제로 새로고침한 뒤에도 렌더러가 다시 준비되면 file open 이 열린다
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-nav-")));
const userData = path.join(tmp, "userdata");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
for (const n of ["alpha-file.txt", "beta-file.txt", "gamma-file.txt"]) fs.writeFileSync(path.join(repo, n), n);
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
  const mainPage = async () => {
    for (let i = 0; i < 40; i++) {
      const p = b.contexts().flatMap((c) => c.pages()).find((x) => x.url().startsWith("file:") && x.url().endsWith("index.html"));
      if (p) return p;
      await sleep(250);
    }
    throw new Error("메인 창을 찾지 못함");
  };
  let page = await mainPage();
  await page.waitForSelector("[data-sidebar]", { timeout: 20000 });
  await sleep(1000);
  const ws = cli("ws", "add", "--path", repo).workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--title", "이동", "--activate").tab.id;
  await sleep(800);
  const opened = async (name) => {
    cli("file", "open", "--path", path.join(repo, name), "--tab", tab);
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      if (await page.evaluate((n) => document.body.innerText.includes(n), name)) return true;
    }
    return false;
  };

  // A
  const first = await opened("alpha-file.txt");
  const before = page.url();
  await page.evaluate((u) => { location.href = u; }, "file://" + path.join(repo, "nothing.html")).catch(() => {});
  await sleep(1500);
  const stayed = page.url() === before;
  res("A (막힌 이동 뒤에도 file open 이 열린다)", first && stayed && (await opened("beta-file.txt")), JSON.stringify({ first, stayed }));

  // B
  await page.reload().catch(() => {});
  page = await mainPage();
  await page.waitForSelector("[data-sidebar]", { timeout: 20000 });
  await sleep(1500);
  res("B (새로고침 뒤에도 다시 준비되면 열린다)", await opened("gamma-file.txt"));

  log(results.filter(([, ok]) => !ok).length === 0 ? "ALL PASS" : "FAILED: " + results.filter(([, ok]) => !ok).map(([n]) => n).join(", "));
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
  await b.close();
  proc.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; proc?.kill(); });
