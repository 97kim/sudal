// 분할 막대를 두 번 누르면 반반이 되는가. 끌어서 눈대중으로 맞추는 것 말고 돌아올 기준점을 주는 기능이다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

/** 에디터 영역의 최소 폭(ChatView 와 같은 값). 이 아래로는 못 줄인다. */
const MIN_PANE = 360;

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "분할" + Date.now(), "--activate").tab.id;
  await page.waitForTimeout(2000);
  cli("file", "open", "--tab", tab, "--path", E2E + "/repo/a.txt");
  await page.waitForTimeout(2500);

  // 막대 양옆 두 영역만 잰다 — 같은 행에 우측 패널도 들어 있어 행 전체 폭은 기준이 못 된다.
  const widths = () => ev(() => {
    const bar = document.querySelector("[data-editor-resizer]");
    if (!bar) return null;
    const w = (e) => Math.round(e.getBoundingClientRect().width);
    return { left: w(bar.previousElementSibling), right: w(bar.nextElementSibling), bar: w(bar), row: w(bar.parentElement) };
  });
  const dbl = async () => {
    await ev(() => document.querySelector("[data-editor-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await page.waitForTimeout(500);
    return widths();
  };
  const dragBy = async (dx) => {
    await ev((d) => {
      const bar = document.querySelector("[data-editor-resizer]");
      const x = Math.round(bar.getBoundingClientRect().left);
      bar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x + d }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, dx);
    await page.waitForTimeout(500);
    return widths();
  };

  // 우측 패널을 접어 끌 여유를 만든다. 열려 있으면 채팅·에디터가 둘 다 최소 폭에 붙어 시험이 성립하지 않는다.
  const clickTitle = (re) => ev((r) => {
    const b = [...document.querySelectorAll("button[title]")].find((x) => new RegExp(r).test(x.getAttribute("title")));
    if (!b) return "없음";
    b.click();
    return "눌림";
  }, re);
  console.log("우측 패널 접기:", await clickTitle("^패널 접기$"));
  await page.waitForTimeout(700);

  const before = await widths();
  console.log("열었을 때:", JSON.stringify(before));
  result("분할 막대가 있다", !!before);

  const even = await dbl();
  console.log("두 번 누른 뒤:", JSON.stringify(even));
  result("두 번 누르면 반반이 된다", Math.abs(even.left - even.right) <= 8, `(왼쪽 ${even.left} · 오른쪽 ${even.right})`);
  result("전체 폭은 그대로다", Math.abs(even.row - before.row) <= 2, `(${before.row} → ${even.row})`);

  // 치우친 상태에서 되돌아오는지. 창이 좁아 두 영역 모두 최소 폭이면 끌 여유가 없어 시험이 성립하지 않는다.
  const room = even.left + even.right - 2 * MIN_PANE;
  if (room < 60) {
    console.log(`SKIP (창이 좁아 끌 여유가 없다 — 좌우 합 ${even.left + even.right}px, 최소 ${MIN_PANE}px씩)`);
  } else {
    const skewed = await dragBy(200); // 오른쪽으로 = 에디터를 좁힌다
    console.log("좁게 끈 뒤:", JSON.stringify(skewed));
    result("끌면 넓이가 바뀐다", even.right - skewed.right > 10, `(${even.right} → ${skewed.right})`);
    const back = await dbl();
    console.log("다시 두 번 누른 뒤:", JSON.stringify(back));
    result("치우쳐 있어도 반반으로 돌아온다", Math.abs(back.left - back.right) <= 8, `(왼쪽 ${back.left} · 오른쪽 ${back.right})`);
  }

  // ===== 터미널(위아래 분할) =====
  console.log("터미널 열기:", await clickTitle("터미널 패널"));
  await page.waitForTimeout(1500);
  const heights = () => ev(() => {
    const bar = document.querySelector("[data-terminal-resizer]");
    if (!bar) return null;
    const panel = bar.parentElement;
    const above = panel.previousElementSibling;
    const h = (e) => Math.round(e.getBoundingClientRect().height);
    return { above: h(above), panel: h(panel) };
  });
  const t0 = await heights();
  console.log("터미널 연 직후:", JSON.stringify(t0));
  result("터미널 막대가 있다", !!t0);
  if (t0) {
    await ev(() => document.querySelector("[data-terminal-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await page.waitForTimeout(500);
    const t1 = await heights();
    console.log("두 번 누른 뒤:", JSON.stringify(t1));
    result("터미널도 두 번 누르면 반반이 된다", Math.abs(t1.above - t1.panel) <= 8, `(위 ${t1.above} · 아래 ${t1.panel})`);
    result("위아래 합은 그대로다", Math.abs(t1.above + t1.panel - (t0.above + t0.panel)) <= 4, `(${t0.above + t0.panel} → ${t1.above + t1.panel})`);
  }

  await page.screenshot({ path: E2E + "/shot-split-even.png" });
  // 다음 시험에 영향이 없게 되돌린다
  console.log("우측 패널 펼치기:", await clickTitle("펼치기"));

  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
