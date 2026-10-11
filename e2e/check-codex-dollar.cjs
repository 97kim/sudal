// Codex 탭 입력창에 "$" 를 치면 스킬·앱 목록이 뜨는가, 얼마나 걸리는가.
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
  // 처음 여는 폴더(목록 캐시가 없는 상태)에서 탭을 열자마자 "$" 를 친다
  const dir = path.join(E2E, "repo-dollar-" + Date.now());
  require("fs").mkdirSync(dir, { recursive: true });
  const ws = cli("ws", "add", "--path", dir).workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "codex", "--title", "달러" + Date.now(), "--activate").tab.id;
  // 탭을 열자마자 친다(목록을 받기 전) — "불러오는 중" 이 보여야 한다
  await page.waitForSelector("textarea[placeholder^='무엇이든']");
  const box = page.locator("textarea[placeholder^='무엇이든']").first();
  await box.click();
  await box.fill("");
  await page.keyboard.type("$");
  const t1 = Date.now();
  let rows = 0, loadingSeen = false;
  for (let i = 0; i < 120 && rows === 0; i++) {
    await page.waitForTimeout(100);
    if (await page.locator("[data-palette-loading]").count()) loadingSeen = true;
    rows = await page.locator("[data-palette-row]").count();
  }
  const firstMs = Date.now() - t1;
  console.log(`화면 목록: ${rows}줄 · ${firstMs}ms · 불러오는 중 표시=${loadingSeen}`);
  result("받는 동안은 불러오는 중을 보여 준다", loadingSeen);
  result("스킬 목록은 5초 안에 뜬다", rows > 0 && firstMs < 5000, `${firstMs}ms`);
  // 앱 목록은 뒤에서 마저 온다(늦으면 60초까지) — 늘어나는지 본다
  let later = rows;
  for (let i = 0; i < 140 && later <= rows; i++) { await page.waitForTimeout(500); later = await page.locator("[data-palette-row]").count(); }
  console.log(`앱까지: ${later}줄 · ${Date.now() - t1}ms`);
  await page.screenshot({ path: E2E + "/shot-codex-dollar.png" });
  result("$ 를 치면 목록이 뜬다", rows > 0);
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
