// 터미널 안의 ⌘W·⌘K·⌘F 가 세션·워크스페이스·대화 검색이 아니라 터미널을 향하는지, 분할 불변식과 배치 복원이 지켜지는지 본다.
// 네이티브 메뉴 가속기는 자동화로 못 누르므로 App 이 열어 둔 window.__sudalShortcut 으로 같은 경로를 탄다.
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
  const shortcut = (name) => ev((n) => window.__sudalShortcut(n), name);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  const tab1 = cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "터미널 키", "--activate");
  await page.waitForTimeout(2500);
  const openTabCount = () => cli("tab", "list", "--ws", ws.workspaceId).tabs.length;

  // 터미널 열기
  await page.click("[data-header-more]");
  await page.waitForTimeout(400);
  await ev(() => document.querySelector("[data-header-menu-item='attach-terminal']")?.click());
  await page.waitForTimeout(3000);
  const views = () => ev(() => [...document.querySelectorAll("[data-terminal-view]")].filter((el) => !el.hidden).map((el) => el.getAttribute("data-terminal-view")));
  const focusedView = () => ev(() => document.activeElement?.closest("[data-terminal-view]")?.getAttribute("data-terminal-view") ?? null);
  const inPanel = () => ev(() => !!document.activeElement?.closest("[data-terminal-panel]"));
  const focusTerm = () => ev(() => document.querySelector("[data-terminal-view]:not([hidden]) .xterm-helper-textarea")?.focus());
  const rowsText = () => ev(() => document.querySelector("[data-terminal-view]:not([hidden]) .xterm-rows")?.textContent ?? "");

  const [first] = await views();
  result("셸 하나가 보인다", Boolean(first));

  // 둘째 칸 탭을 누르면 분할이 풀리고 그 터미널이 한 화면이 된다
  await focusTerm();
  await page.keyboard.press("Meta+d");
  await page.waitForTimeout(1200);
  const two = await views();
  result("⌘D 로 둘이 된다", two.length === 2, `(${two.length})`);
  const second = two.find((id) => id !== first);
  await ev((id) => document.querySelector(`[data-terminal-tab='${id}']`)?.click(), second);
  await page.waitForTimeout(600);
  const afterClick = await views();
  result("둘째 칸 탭을 누르면 분할이 풀리고 그것만 보인다", afterClick.length === 1 && afterClick[0] === second, JSON.stringify(afterClick));
  result("구분선이 없다", await ev(() => document.querySelector("[data-terminal-split-resizer]") === null));

  // 나뉜 상태에서 오른쪽 칸에 포커스를 두고 ⌘W — 포커스 있던 칸만 닫히고 세션은 남는다
  await focusTerm();
  await page.keyboard.press("Meta+d");
  await page.waitForTimeout(1200);
  const pair = await views();
  const focusedBefore = await focusedView();
  result("⌘D 뒤 새 칸에 포커스가 간다", pair.length === 2 && focusedBefore !== null && focusedBefore !== second, `(${focusedBefore})`);
  const tabsBefore = openTabCount();
  await shortcut("close-tab");
  await page.waitForTimeout(800);
  const afterW = await views();
  result("⌘W 는 포커스 있던 터미널만 닫는다", afterW.length === 1 && afterW[0] === second, JSON.stringify(afterW));
  result("채팅 세션은 그대로다", openTabCount() === tabsBefore, `(${openTabCount()} vs ${tabsBefore})`);
  result("남은 칸으로 포커스가 온다", (await focusedView()) === second, `(${await focusedView()})`);

  // ⌘K — 워크스페이스 전환창이 아니라 화면 지우기
  await focusTerm();
  await page.keyboard.type("echo KEYS_$((6*7))");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40 && !(await rowsText()).includes("KEYS_42"); i++) await page.waitForTimeout(250);
  result("출력이 보인다", (await rowsText()).includes("KEYS_42"));
  await shortcut("switch-workspace");
  await page.waitForTimeout(600);
  result("⌘K 뒤에도 포커스가 터미널에 있다(전환창이 안 뜬다)", await inPanel());
  result("⌘K 로 화면이 지워진다", !(await rowsText()).includes("KEYS_42"));

  // ⌘← / ⌘→ — 줄 처음 / 끝. 끝에서 친 글이 앞으로, 앞에서 친 글이 뒤로 들어가면 두 방향 모두 맞은 것.
  await page.keyboard.type("echo CUR_B");
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.type("echo CUR_A; ");
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type("; echo CUR_C");
  await page.waitForTimeout(300);
  result("⌘← ⌘→ 로 줄 처음·끝에 글이 들어간다", (await rowsText()).includes("echo CUR_A; echo CUR_B; echo CUR_C"), JSON.stringify((await rowsText()).slice(-120)));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  // 다시 출력을 만들고 ⌘F — 대화 검색이 아니라 터미널 안 찾기
  await page.keyboard.type("echo FIND_ME_1; echo FIND_ME_2");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40 && !(await rowsText()).includes("FIND_ME_2"); i++) await page.waitForTimeout(250);
  await shortcut("search");
  await page.waitForTimeout(500);
  result("⌘F 로 터미널 찾기 창이 뜬다", await ev(() => document.querySelector("[data-terminal-find]") !== null));
  result("찾기 입력창에 포커스가 간다", await ev(() => document.activeElement?.closest("[data-terminal-find]") !== null));
  await page.keyboard.type("FIND_ME");
  await page.waitForTimeout(600);
  const count = await ev(() => document.querySelector("[data-terminal-find-count]")?.textContent ?? "");
  result("결과 수가 보인다", /\/\s*[2-9]$/.test(count) || /\/\s*\d+$/.test(count), `(${JSON.stringify(count)})`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  result("Esc 로 닫히고 터미널로 돌아온다", (await ev(() => document.querySelector("[data-terminal-find]") === null)) && (await focusedView()) !== null);

  // 채팅 탭을 오가도 분할·열림이 돌아온다
  await page.keyboard.press("Meta+d");
  await page.waitForTimeout(1200);
  result("다시 둘로 나뉜다", (await views()).length === 2);
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "다른 탭", "--activate");
  await page.waitForTimeout(1500);
  cli("tab", "activate", "--tab", tab1.tab.id);
  await page.waitForTimeout(3500);
  result("돌아오면 패널이 열려 있다", await ev(() => document.querySelector("[data-terminal-panel]")?.hidden === false));
  const restored = await views();
  result("돌아오면 분할이 그대로다", restored.length === 2 && await ev(() => document.querySelector("[data-terminal-split-resizer='row']") !== null), JSON.stringify(restored));
  await page.screenshot({ path: E2E + "/shot-terminal-keys.png" });

  // 마지막 터미널까지 ⌘W 로 닫으면 패널이 접히고 세션은 남는다
  // 분할을 풀 때 남은 숨은 탭까지 있으니 탭 수만큼 닫는다
  const tabCount = await ev(() => document.querySelectorAll("[data-terminal-tab]").length);
  for (let i = 0; i < tabCount; i++) {
    await focusTerm();
    await shortcut("close-tab");
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(300);
  result("마지막 ⌘W 는 패널을 접는다", await ev(() => document.querySelector("[data-terminal-panel]")?.hidden === true));
  result("그래도 채팅 세션은 남는다", openTabCount() === tabsBefore + 1, `(${openTabCount()})`);

  const s = await ev(() => window.sudal.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.sudal.workspaces.deleteTab(id), t.id); await ev((id) => window.sudal.workspaces.remove(id), w.id); }
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
