// 번들에서 다른 아키텍처의 node-pty 프리빌드를 뺀 뒤에도 통합 터미널이 실제로 붙는지 본다.
// arm64 프리빌드까지 잘못 빼면 여기서 pty 가 안 열린다 — 경고만 지우고 기능을 깨뜨리는 것을 막는 자리.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  const tab = cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "pty 확인용", "--activate");
  await page.waitForTimeout(2000);

  const out = await page.evaluate(async ({ tabId, cwd }) => {
    let buf = "";
    const off = window.workbench.terminal.onData((id, data) => { if (id === tabId) buf += data; });
    const opened = await window.workbench.terminal.open(tabId, cwd, 80, 24);
    await new Promise((r) => setTimeout(r, 1200));
    window.workbench.terminal.write(tabId, "echo PTY_SALUTE_OK\n");
    await new Promise((r) => setTimeout(r, 2000));
    off();
    await window.workbench.terminal.close(tabId);
    return { opened: !!opened, sawEcho: buf.includes("PTY_SALUTE_OK"), tail: buf.slice(-200) };
  }, { tabId: tab.tabId, cwd: E2E + "/repo" });

  console.log("터미널 열림:", out.opened, "| 출력 일부:", JSON.stringify(out.tail.slice(-80)));
  console.log("RESULT (pty 가 열린다):", out.opened ? "PASS" : "FAIL");
  console.log("RESULT (명령 출력이 돌아온다):", out.sawEcho ? "PASS" : "FAIL");

  const s = await page.evaluate(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await page.evaluate((id) => window.workbench.workspaces.deleteTab(id), t.id); await page.evaluate((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
