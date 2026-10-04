// 워크스페이스 기본 경로: 우클릭 메뉴에 항목이 있고, 정하면 새 세션이 그 경로를 물려받는다.
// 폴더 고르기는 OS 다이얼로그라 자동화할 수 없어, 메뉴 존재는 화면으로 값 설정은 API 로 본다.
//
// 이 기능은 원래 있었는데 덮여 있었다 — 메뉴를 열어 보지 않으면 있는 줄 모른다.
// 있다는 사실을 테스트로 박아 둔다. 없앴다가 되살리는 일이 없게.
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
  await ev(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "채팅")?.click());
  await page.waitForTimeout(600);

  // 경로 없는 워크스페이스를 만든다
  const made = await ev(() => window.workbench.workspaces.create("경로시험"));
  const wsId = made.workspaceId;
  await page.waitForTimeout(700);
  result("워크스페이스를 만든다", Boolean(wsId));

  // 우클릭 메뉴에 항목이 있나
  const menuLabels = async () => {
    await ev((id) => {
      const el = [...document.querySelectorAll("[data-ws-name]")].find((x) => x.textContent.trim() === "경로시험");
      el?.closest("div")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
      return id;
    }, wsId);
    await page.waitForTimeout(400);
    return ev(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()));
  };
  const before = await menuLabels();
  result("경로가 없으면 '정하기' 가 보인다", before.includes("기본 경로 설정…"), JSON.stringify(before.filter((x) => x.includes("기본 경로"))));
  result("경로가 없으면 '지우기' 는 없다", !before.includes("기본 경로 해제"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 경로를 정한다(다이얼로그 대신 API)
  await ev(({ id, dir }) => window.workbench.workspaces.update(id, { path: dir }), { id: wsId, dir: E2E + "/repo" });
  await page.waitForTimeout(800);
  const saved = cli("ws", "list").workspaces.find((w) => w.id === wsId);
  result("정한 경로가 저장된다", saved?.path === E2E + "/repo", `(${saved?.path})`);

  const after = await menuLabels();
  result("경로가 있으면 '바꾸기' 와 '지우기' 가 보인다", after.includes("기본 경로 변경…") && after.includes("기본 경로 해제"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 그 워크스페이스의 첫 세션이 경로를 물려받나 — 이게 이 기능의 목적이다
  const tabId = cli("tab", "new", "--ws", wsId, "--provider", "claude", "--title", "물려받기").tab.id;
  await page.waitForTimeout(900);
  const cwd = cli("tab", "status", "--tab", tabId).tab.cwd;
  result("새 세션이 기본 경로를 물려받는다", cwd === E2E + "/repo", `(${cwd})`);

  const s = await ev(() => window.workbench.workspaces.state());
  for (const t of s.model.tabs.filter((t) => t.workspaceId === wsId)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id);
  await ev((id) => window.workbench.workspaces.remove(id), wsId);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
