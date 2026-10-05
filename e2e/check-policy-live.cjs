// 턴 도중에 권한을 "전부 자동" 으로 바꾸면 그 턴부터 바로 먹는가.
// 예전에는 다음 메시지부터라, 계속 물어봐서 바꿨는데 그 턴 내내 계속 묻는 일이 생겼다.
const path = require("path"), { execFileSync } = require("child_process");
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

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "권한" + Date.now(), "--activate").tab.id;
  await page.waitForTimeout(2000);
  // 기본은 "변경 전 물어보기"
  await ev((t) => window.sudal.chat.configure(t, { policy: "ask" }), tab);
  await page.waitForTimeout(400);

  const status = () => ev(async (t) => (await window.sudal.chat.snapshot(t)).status, tab);
  const prompts = () => ev(() => document.querySelectorAll("[data-permission-request], [data-tool-card][data-permission='pending']").length);

  // 읽기만 하는 명령(echo·ls)은 CLI 가 안전하다고 보고 그냥 통과시킨다 — 반드시 묻는 동작(파일 쓰기)을 시킨다.
  cli("tab", "send", "--tab", tab, "--text",
    "Write 도구로 파일 세 개를 따로 만들어라. perm-1.txt 에 '하나', perm-2.txt 에 '둘', perm-3.txt 에 '셋'. 한 번에 묶지 말고 세 번 호출해라. 끝나면 '끝' 한 마디만.");

  // 첫 승인 대기까지
  let waited = 0;
  for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); waited = i; if ((await status()) === "waiting_permission") break; }
  const st1 = await status();
  console.log(`첫 승인 대기까지 ${waited}초 · status=${st1}`);
  result("승인 대기가 걸린다", st1 === "waiting_permission");

  // 여기서 "전부 자동" 으로 바꾼다 — 대기 중인 창이 풀려야 한다
  const t0 = Date.now();
  await ev((t) => window.sudal.chat.configure(t, { policy: "full" }), tab);
  let freed = false;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(500); if ((await status()) !== "waiting_permission") { freed = true; break; } }
  console.log(`바꾼 뒤 풀리기까지 ${Math.round((Date.now() - t0) / 100) / 10}초 · freed=${freed}`);
  result("대기 중이던 승인이 바로 풀린다", freed);

  // 남은 도구 호출에서 다시 묻지 않고 턴이 끝나야 한다
  let askedAgain = false;
  let done = false;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const st = await status();
    if (st === "waiting_permission") askedAgain = true;
    if (st === "idle" || st === "error") { done = true; break; }
  }
  console.log(`턴 종료=${done} · 다시 물음=${askedAgain}`);
  result("같은 턴에서 다시 묻지 않는다", done && !askedAgain);

  await page.screenshot({ path: E2E + "/shot-policy-live.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
