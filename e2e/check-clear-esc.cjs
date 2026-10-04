// 입력창에서 /clear 로 대화가 비워지는가, 응답 중 esc 로 턴이 중단되는가.
// 둘 다 화면 쪽 동작이라 단위 테스트가 닿지 않는다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let fails = 0;
const result = (name, ok, note) => { if (!ok) fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "clear·esc 확인", "--activate");
  await page.waitForTimeout(2500);

  const box = "[data-composer] textarea, textarea";
  const blocks = () => ev(() => document.querySelectorAll("[data-block-id], [data-tool-card], [data-user-message]").length);

  // 대화를 한 번 만든다
  await page.fill(box, "'하나' 라고만 답해라. 도구는 쓰지 마라.");
  await page.press(box, "Enter");
  for (let i = 0; i < 60 && (await blocks()) < 2; i += 1) await page.waitForTimeout(1000);
  const before = await blocks();
  result("대화가 쌓인다", before >= 2, `(${before})`);

  // /clear — 자동완성 목록이 뜨면 Enter 를 가로채므로(정상 동작) 먼저 닫고 보낸다.
  await page.fill(box, "/clear");
  await page.waitForTimeout(400);
  await page.press(box, "Escape");
  await page.waitForTimeout(200);
  await page.press(box, "Enter");
  await page.waitForTimeout(1500);
  const after = await blocks();
  result("/clear 로 화면이 비워진다", after === 0, `(${before} → ${after})`);
  const left = await ev(() => document.querySelector("[data-composer] textarea, textarea")?.value ?? "");
  result("/clear 는 입력창에 남지 않는다", left === "", `(${JSON.stringify(left)})`);

  // 응답 중 esc
  await page.fill(box, "1 부터 50 까지 세면서 각 숫자마다 한 문장씩 설명해라.");
  await page.press(box, "Enter");
  await page.waitForTimeout(3000);
  const running = await ev(() => !!document.querySelector("[data-abort], [title^='중단']"));
  result("응답 중이다", running);
  await page.focus(box);
  await page.press(box, "Escape");
  await page.waitForTimeout(2500);
  const stopped = await ev(() => !document.querySelector("[data-abort], [title^='중단']"));
  result("esc 로 중단된다", stopped);

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
