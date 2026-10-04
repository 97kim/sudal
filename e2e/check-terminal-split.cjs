// ⌘D 좌우 · ⌘⇧D 상하 분할. 실제로 두 xterm 이 나란히 놓이는지 좌표로 본다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let fails = 0;
const result = (n, ok, note) => { if (!ok) fails += 1; console.log(`RESULT (${n}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, a) => page.evaluate(fn, a);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "분할 확인", "--activate");
  await page.waitForTimeout(2500);

  // 터미널 열기
  await page.click("[data-header-more]");
  await page.waitForTimeout(400);
  const opened = await ev(() => {
    const it = document.querySelector("[data-header-menu-item='attach-terminal']");
    if (it) { it.click(); return true; }
    return false;
  });
  result("터미널을 연다", opened);
  await page.waitForTimeout(3000);

  // 보이는 xterm 들의 자리
  const boxes = () => ev(() => [...document.querySelectorAll("[data-terminal-view]")]
    .filter((el) => !el.hidden)
    .map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; }));

  const one = await boxes();
  result("처음에는 하나만 보인다", one.length === 1, `(${one.length})`);

  // ⌘D — 좌우
  await ev(() => document.querySelector("[data-terminal-view]:not([hidden]) .xterm-helper-textarea")?.focus());
  await page.keyboard.press("Meta+d");
  await page.waitForTimeout(1500);
  const lr = await boxes();
  result("⌘D 로 둘이 된다", lr.length === 2, `(${lr.length})`);
  const sideBySide = lr.length === 2 && Math.abs(lr[0].y - lr[1].y) < 5 && Math.abs(lr[0].x - lr[1].x) > 50;
  result("좌우로 나뉜다", sideBySide, JSON.stringify(lr));
  result("구분선이 세로다", await ev(() => document.querySelector("[data-terminal-split-resizer='row']") !== null));

  // ⌘⇧D — 상하 (이미 나뉘어 있으면 방향만 바뀐다)
  await page.keyboard.press("Meta+Shift+d");
  await page.waitForTimeout(1500);
  const tb = await boxes();
  result("터미널이 더 늘지 않는다", tb.length === 2, `(${tb.length})`);
  const stacked = tb.length === 2 && Math.abs(tb[0].x - tb[1].x) < 5 && Math.abs(tb[0].y - tb[1].y) > 30;
  result("상하로 바뀐다", stacked, JSON.stringify(tb));
  result("구분선이 가로다", await ev(() => document.querySelector("[data-terminal-split-resizer='col']") !== null));
  await page.screenshot({ path: E2E + "/shot-terminal-split.png" });

  // ⌘⌥방향키로 옆 칸에 포커스가 간다. 지금은 상하로 나뉘어 있다.
  const focusedView = () => ev(() => document.activeElement?.closest("[data-terminal-view]")?.getAttribute("data-terminal-view") ?? null);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await page.waitForTimeout(400);
  const lower = await focusedView();
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await page.waitForTimeout(400);
  const upper = await focusedView();
  result("⌘⌥↓ ⌘⌥↑ 로 칸을 오간다", Boolean(lower) && Boolean(upper) && lower !== upper, `(${lower} → ${upper})`);
  // 나뉜 축과 다른 방향은 갈 곳이 없으니 포커스가 그대로다.
  await page.keyboard.press("Meta+Alt+ArrowLeft");
  await page.waitForTimeout(400);
  result("축과 다른 방향은 움직이지 않는다", (await focusedView()) === upper);

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
