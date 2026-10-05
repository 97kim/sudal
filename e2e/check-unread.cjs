// 응답이 왔는데 아직 확인하지 않은 세션을 좌측 패널에서 알아볼 수 있는가.
// 예전에도 표시는 있었지만 지름 5px 점의 색만 바뀌어 사실상 안 보였다.
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const dir = `/tmp/sudal-unread-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  const ws = cli("ws", "add", "--path", dir).workspaceId;
  const a = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "보고있는탭", "--activate").tab.id;
  const target = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "응답올탭").tab.id;
  cli("tab", "activate", "--tab", a);
  await page.waitForTimeout(1500);

  const rowState = (id) => ev((t) => {
    const el = document.querySelector(`[data-session="${t}"]`);
    if (!el) return null;
    const dot = el.querySelector("[data-unread]");
    const title = el.querySelector("span.min-w-0");
    return { unread: dot?.getAttribute("data-unread") ?? null, weight: title ? getComputedStyle(title).fontWeight : null };
  }, id);
  const wsBadge = () => ev((id) => {
    const head = document.querySelector(`[data-workspace-head="${id}"] [data-ws-unread]`);
    return head ? Number(head.getAttribute("data-ws-unread")) : 0;
  }, ws);

  // 다른 탭을 보는 동안 응답이 온다
  cli("tab", "send", "--tab", target, "--text", "한 글자로만 답해라. 좋다는 뜻으로.");
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    const st = await ev(async (t) => (await window.sudal.chat.snapshot(t)).status, target);
    if (st === "idle" || st === "error") break;
  }
  await page.waitForTimeout(1200);

  const marked = await rowState(target);
  const badge = await wsBadge();
  console.log("응답 온 뒤:", JSON.stringify({ ...marked, badge }));
  result("확인 안 한 세션에 표시가 붙는다", marked?.unread === "done", `(unread=${marked?.unread})`);
  result("제목이 굵어진다", Number(marked?.weight) >= 600, `(weight=${marked?.weight})`);
  result("워크스페이스 헤더에 개수가 뜬다", badge >= 1, `(badge=${badge})`);

  // 표시가 붙어 있는 상태를 남긴다 — 지운 뒤에 찍으면 정작 확인할 것이 안 담긴다.
  await ev((id) => {
    const el = document.querySelector(`[data-session="${id}"]`);
    if (el) el.scrollIntoView({ block: "center" });
  }, target);
  await page.waitForTimeout(400);
  await page.screenshot({ path: E2E + "/shot-unread.png" });

  // 보고 있던 탭에는 표시가 없다
  const other = await rowState(a);
  result("보던 탭에는 표시가 없다", other?.unread === null, `(unread=${other?.unread})`);

  // 저장돼 있어야 껐다 켜도 남는다
  const saved = JSON.parse(fs.readFileSync(E2E + "/userdata/attention.json", "utf8"));
  result("표시가 디스크에 남는다", saved[target] === "done", `(${JSON.stringify(saved[target])})`);

  // 탭을 열면 지워진다
  cli("tab", "activate", "--tab", target);
  await page.waitForTimeout(1500);
  const after = await rowState(target);
  result("탭을 열면 표시가 사라진다", after?.unread === null, `(unread=${after?.unread})`);

  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
