// ⌘⇧↓/↑(응답 필요 세션으로)가 입력창에 포커스가 있어도 앱으로 오는지. 편집 명령("끝까지 선택")이 먼저 가져가면 안 된다.
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
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "응답 필요 키", "--activate");
  await page.waitForTimeout(2500);

  const focused = await ev(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return false;
    ta.focus();
    return document.activeElement === ta;
  });
  result("입력창에 포커스가 있다", focused);
  await page.keyboard.type("첫 줄 둘째 말");
  // 입력창이 키를 먹으면 ⌘⇧↑ 는 "처음까지 선택", ⌘⇧↓ 는 "끝까지 선택"이 된다. 앱이 먼저 받으면 선택이 생기지 않는다.
  const selection = () => ev(() => { const ta = document.activeElement; return ta && "selectionStart" in ta ? ta.selectionEnd - ta.selectionStart : -1; });
  await page.keyboard.press("Meta+Shift+ArrowUp");
  await page.waitForTimeout(300);
  result("⌘⇧↑ 를 앱이 먼저 받는다(입력창에 선택이 생기지 않는다)", (await selection()) === 0, `(선택 ${await selection()}자)`);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Meta+Shift+ArrowDown");
  await page.waitForTimeout(300);
  result("⌘⇧↓ 도", (await selection()) === 0, `(선택 ${await selection()}자)`);
  result("포커스는 입력창에 남는다", await ev(() => document.activeElement?.tagName === "TEXTAREA"));

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
