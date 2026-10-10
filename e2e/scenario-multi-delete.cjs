// 사이드바 세션 여러 개 고르기·삭제 검증. usage: node e2e/scenario-multi-delete.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
//  A) 그냥 클릭 → Shift+클릭으로 범위 고르기, ⌘+클릭으로 하나 더하고 빼기, Esc 로 풀기
//  B) 고른 것 중 하나를 우클릭 → "고른 N개 삭제…" → 확인 줄 → 삭제하면 그 세션들만 사라진다
//  C) Delete 키로도 확인 줄이 뜬다
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-md-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-md-repo-"));
const cli = (...a) => {
  try {
    return JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: userData }, encoding: "utf8" }));
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { throw e; }
  }
};
const { chromium } = require("playwright-core");
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const results = [];
const res = (n, ok, x = "") => { results.push([n, ok]); log(`RESULT ${n}:`, ok ? "PASS" : "FAIL", x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(app + "/Contents/MacOS/Sudal", ["--remote-debugging-port=9333", `--user-data-dir=${userData}`], { stdio: "ignore", env: { ...process.env, SUDAL_USERDATA: userData } });
  let b = null;
  for (let i = 0; i < 60 && !b; i++) { await sleep(500); try { b = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch {} }
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost")); if (!page) await sleep(250); }
  await page.waitForSelector("[data-sidebar]", { timeout: 20000 });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });

  const ws = cli("ws", "add", "--path", repo);
  const titles = ["가", "나", "다", "라"];
  const ids = {};
  for (const t of titles) ids[t] = cli("tab", "new", "--ws", ws.workspaceId, "--title", t).tab.id;
  await sleep(800);
  const row = (t) => `[data-session="${ids[t]}"]`;
  const selected = () => ev(() => [...document.querySelectorAll("[data-session][data-selected]")].map((e) => e.getAttribute("data-session")));
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // A
  await page.click(row("가"));
  await page.click(row("다"), { modifiers: ["Shift"] });
  const range = await selected();
  await page.click(row("라"), { modifiers: [mod] });
  const plus = await selected();
  await page.click(row("나"), { modifiers: [mod] });
  const minus = await selected();
  await page.keyboard.press("Escape");
  const cleared = await selected();
  const want = (ts) => JSON.stringify(ts.map((t) => ids[t]).sort());
  res("A (Shift 범위 · ⌘ 더하기·빼기 · Esc 풀기)",
    JSON.stringify([...range].sort()) === want(["가", "나", "다"]) && JSON.stringify([...plus].sort()) === want(["가", "나", "다", "라"]) && JSON.stringify([...minus].sort()) === want(["가", "다", "라"]) && cleared.length === 0,
    JSON.stringify({ range: range.length, plus: plus.length, minus: minus.length, cleared: cleared.length }));

  // B
  await page.click(row("가"));
  await page.click(row("다"), { modifiers: ["Shift"] });
  await page.click(row("나"), { button: "right" });
  const menuItems = await ev(() => [...document.querySelectorAll("[data-session-menu] [role=menuitem]")].map((e) => e.textContent));
  await page.screenshot({ path: path.join(E2E, "shot-multi-menu.png") });
  const del = menuItems.find((x) => /3개 삭제/.test(x));
  if (del) await page.click(`[data-session-menu] [role=menuitem]:has-text("${del}")`);
  await sleep(300);
  const confirmText = await ev(() => document.querySelector(".bg-err-bg span")?.textContent ?? null);
  await page.screenshot({ path: path.join(E2E, "shot-multi-confirm.png") });
  await page.click('.bg-err-bg button:has-text("삭제")');
  await sleep(1200);
  const left = cli("tab", "list", "--ws", ws.workspaceId, "--all").tabs.map((t) => t.id);
  res("B (우클릭 → 고른 3개 삭제 → 확인 → 그 세션만 사라짐)",
    !!del && /3개/.test(confirmText || "") && !left.includes(ids["가"]) && !left.includes(ids["나"]) && !left.includes(ids["다"]) && left.includes(ids["라"]),
    JSON.stringify({ menuItems, confirmText, left: left.length }));

  // C
  await page.click(row("라"));
  await page.click(row("라"), { modifiers: [mod] }); // 보던 탭 자신을 ⌘+클릭 → 그것만 고른다
  const one = await selected();
  await page.keyboard.press(process.platform === "darwin" ? "Backspace" : "Delete");
  await sleep(300);
  const confirm2 = await ev(() => document.querySelector(".bg-err-bg span")?.textContent ?? null);
  await page.click('.bg-err-bg button:has-text("취소")');
  res("C (Delete 키로 확인 줄)", one.length === 1 && /1개/.test(confirm2 || ""), JSON.stringify({ one: one.length, confirm2 }));

  // D: 키보드로 고르기 — 행에 포커스 → Space 로 고르고, ↑ 로 옮겨 Space, Esc 로 확인 줄과 선택을 닫는다
  const ws2 = cli("tab", "new", "--ws", ws.workspaceId, "--title", "마").tab.id;
  await sleep(600);
  await page.focus(row("라"));
  await page.keyboard.press(" ");
  await page.focus(`[data-session="${ws2}"]`);
  await page.keyboard.press("ArrowUp");
  const focusedId = await ev(() => document.activeElement?.getAttribute("data-session"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  const kb = await selected();
  await page.keyboard.press(process.platform === "darwin" ? "Backspace" : "Delete");
  await sleep(200);
  const before = await ev(() => !!document.querySelector(".bg-err-bg"));
  await page.keyboard.press("Escape");
  await sleep(200);
  const after = await ev(() => ({ confirm: !!document.querySelector(".bg-err-bg"), selected: document.querySelectorAll("[data-session][data-selected]").length }));
  res("D (키보드로 고르기 · Esc 로 확인 줄과 선택 닫기)", kb.length === 2 && before && !after.confirm && after.selected === 0, JSON.stringify({ kb: kb.length, focusedId: focusedId === ids["라"], before, after }));

  if (errs.length) log("CONSOLE ERRORS:", errs.slice(0, 5));
  log(results.filter(([, ok]) => !ok).length === 0 ? "ALL PASS" : "FAILED: " + results.filter(([, ok]) => !ok).map(([n]) => n).join(", "));
  await b.close();
  proc.kill();
  await sleep(500);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
