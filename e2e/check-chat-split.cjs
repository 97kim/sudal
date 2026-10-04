// 채팅 화면 분할: 사이드바 탭 우클릭 → "오른쪽에 나란히 열기" → 좌우 두 칸. 칸을 누르면 그 칸이 포커스(활성 탭)가 되고,
// 사이드바에서 다른 탭을 누르면 포커스된 칸만 바뀌고, 칸의 탭을 닫으면 남은 칸 하나로 돌아가고, 분할을 풀 수 있다.
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
  const t1 = cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "분할 왼쪽", "--activate").tab.id;
  const t2 = cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "분할 오른쪽").tab.id;
  const t3 = cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "분할 셋째").tab.id;
  cli("tab", "activate", "--tab", t1);
  await page.waitForTimeout(2000);

  const panes = () => ev(() => [...document.querySelectorAll("[data-chat-pane]")].map((el) => {
    const r = el.getBoundingClientRect();
    return { side: el.getAttribute("data-chat-pane"), focused: el.getAttribute("data-focused"), x: Math.round(r.left), w: Math.round(r.width) };
  }).sort((a, b) => a.x - b.x));
  const active = () => ev(async () => (await window.workbench.workspaces.state()).model.activeTabId);
  const textOf = (side) => ev((s) => document.querySelector(`[data-chat-pane='${s}']`)?.textContent ?? "", side);

  result("처음엔 한 칸", (await panes()).length === 1);

  // 사이드바에서 t2 우클릭 → 오른쪽에 나란히 열기
  await page.click(`[data-session='${t2}']`, { button: "right" });
  await page.waitForTimeout(300);
  const picked = await ev(() => {
    const item = [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.trim() === "오른쪽에 나란히 열기");
    if (item) { item.click(); return true; }
    return false;
  });
  result("우클릭 메뉴에 '오른쪽에 나란히 열기' 가 있다", picked);
  await page.waitForTimeout(1500);
  let p = await panes();
  result("두 칸이 좌우로 나란히 보인다", p.length === 2 && p[0].side === "left" && p[1].side === "right" && p[1].x > p[0].x + 200, JSON.stringify(p));
  result("오른쪽 칸이 포커스이고 활성 탭이 t2", p[1]?.focused === "true" && (await active()) === t2);

  // 분할 중엔 양쪽 오른쪽 패널이 접혀 있다
  const panelState = () => ev(() => [...document.querySelectorAll("[data-chat-pane]")].map((el) => el.querySelector("[data-right-panel]")?.getAttribute("data-right-panel")));
  result("분할 중엔 양쪽 오른쪽 패널이 기본으로 접혀 있다", (await panelState()).every((x) => x === "collapsed"), JSON.stringify(await panelState()));

  // 양쪽 칸에서 /model 로 모달을 열고, 오른쪽이 포커스인 채 Esc → 오른쪽 모달만 닫힌다
  const openModel = async (side) => {
    await ev((s) => document.querySelector(`[data-chat-pane='${s}'] textarea`)?.focus(), side);
    await page.keyboard.type("/model");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    // 자동완성이 떠 있으면 첫 Enter 는 명령 선택이다 — 창이 안 열렸으면 한 번 더 보낸다
    const open = await ev((s) => !!document.querySelector(`[data-chat-pane='${s}'] [data-model-picker]`), side);
    if (!open) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
    }
  };
  await openModel("left");
  await openModel("right");
  const modals = () => ev(() => ({ left: !!document.querySelector("[data-chat-pane='left'] [data-model-picker]"), right: !!document.querySelector("[data-chat-pane='right'] [data-model-picker]") }));
  const both = await modals();
  result("양쪽 칸에 모델 선택 창이 열린다", both.left && both.right, JSON.stringify(both));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const afterEsc = await modals();
  result("Esc 는 포커스된 칸(오른쪽)의 모달만 닫는다", afterEsc.left && !afterEsc.right, JSON.stringify(afterEsc));
  await ev(() => document.querySelector("[data-chat-pane='left'] [data-model-picker]")?.click());
  await page.waitForTimeout(400);

  // 왼쪽 칸을 누르면 포커스가 왼쪽으로
  const lx = p[0].x + 40;
  await page.mouse.click(lx, 300);
  await page.waitForTimeout(800);
  p = await panes();
  result("왼쪽 칸을 누르면 그 칸이 포커스, 활성 탭이 t1", p[0].focused === "true" && (await active()) === t1, JSON.stringify(p));

  // 사이드바에서 t3 을 누르면 포커스된 칸(왼쪽)만 바뀐다
  await page.click(`[data-session='${t3}']`);
  await page.waitForTimeout(1500);
  p = await panes();
  const leftTitle = (await textOf("left")).includes("분할 셋째");
  const rightStill = (await textOf("right")).includes("분할 오른쪽");
  result("사이드바에서 다른 탭을 누르면 포커스된 칸만 바뀐다", p.length === 2 && leftTitle && rightStill && (await active()) === t3);

  // 오른쪽 칸에 포커스를 두고 그 칸을 뺀다 — 남는 왼쪽(t3)은 활성 탭이 아니어서 활성화가 돌아오는 동안에도 다시 그려지면 안 된다.
  await page.mouse.click(p[1].x + 40, 300);
  await page.waitForTimeout(800);
  result("오른쪽 칸을 누르면 오른쪽이 포커스", (await active()) === t2);
  await ev(() => { const el = document.querySelector("[data-chat-pane='left']"); if (el) el.__keepMark = "same-node"; });
  await ev(() => document.querySelector("[data-chat-pane='right'] [data-unsplit]")?.click());
  await page.waitForTimeout(1000);
  result("분할을 풀어도 남는 칸은 다시 그려지지 않는다", await ev(() => document.querySelector("[data-chat-pane]")?.__keepMark === "same-node"));
  p = await panes();
  result("오른쪽 칸을 빼면 한 칸으로 돌아가고 남은 칸이 활성", p.length === 1 && (await active()) === t3, JSON.stringify(p));
  result("뺀 탭은 닫히지 않고 열려 있다", cli("tab", "status", "--tab", t2).tab.open === true);
  result("분할을 풀면 한 칸 화면의 패널 설정(펼침)으로 돌아간다", (await panelState())[0] !== "collapsed", JSON.stringify(await panelState()));

  // 다시 나누고 오른쪽 칸의 탭을 닫으면 왼쪽만 남는다(이웃 탭이 들어오지 않는다)
  await page.click(`[data-session='${t2}']`, { button: "right" });
  await page.waitForTimeout(300);
  await ev(() => [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.trim() === "오른쪽에 나란히 열기")?.click());
  await page.waitForTimeout(1500);
  result("다시 두 칸", (await panes()).length === 2);
  cli("tab", "close", "--tab", t2);
  await page.waitForTimeout(1500);
  p = await panes();
  result("칸의 탭을 닫으면 남은 칸(t3) 하나로", p.length === 1 && (await active()) === t3, JSON.stringify({ p, active: await active() }));
  await page.screenshot({ path: E2E + "/shot-chat-split.png" });

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
