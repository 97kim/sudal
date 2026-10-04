// 압축을 provider 에게 맡기는 경로. 핵심 확인 두 가지 —
// (1) SDK 로 /compact 를 보내면 compact_boundary 가 돌아와 화면에 경계가 남는가
// (2) 압축 뒤에도 세션 id 가 그대로인가 (요약 후 새 세션과 달리 대화가 끊기지 않아야 한다)
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "압축", "--activate");
  await page.waitForTimeout(2500);

  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab") ?? null);
  console.log("활성 탭:", tabId);
  if (!tabId) { console.log("RESULT: FAIL (탭을 못 찾음)"); process.exit(1); }

  const snap = () => ev((id) => window.workbench.chat.snapshot(id), tabId);
  // 턴이 끝나고 세션 id 가 잡힐 때까지 기다린다 — 압축은 유휴 상태의 살아 있는 세션에만 맡길 수 있다.
  const settle = async (label) => {
    for (let i = 0; i < 180; i++) {
      const s = await snap();
      if (s.sessionId && s.status !== "running" && s.status !== "waiting_permission") return s;
      await page.waitForTimeout(1000);
    }
    throw new Error(`${label}: 턴이 안 끝남`);
  };

  // 압축할 거리가 있어야 한다 — 짧은 턴 하나를 실제로 돌린다.
  cli("tab", "send", "--tab", "압축", "--text", "한 단어로만 답해라. 대한민국의 수도는?");
  const settled = await settle("첫 턴");
  console.log("첫 턴 끝:", JSON.stringify({ status: settled.status, sessionId: settled.sessionId }));

  const before = await snap().then((s) => ({ sessionId: s.sessionId, provider: s.provider }));
  console.log("압축 전:", JSON.stringify(before));

  // 여기가 본론 — provider 에게 압축을 맡긴다.
  const r = await ev((id) => window.workbench.chat.compact(id), tabId);
  console.log("compact() 반환:", JSON.stringify(r));

  // 압축은 턴 하나라 시간이 걸린다. 경계가 그려질 때까지 기다린다.
  let seen = null;
  for (let i = 0; i < 90; i++) {
    seen = await ev(() => {
      const el = document.querySelector("[data-compacted]");
      return el ? { trigger: el.getAttribute("data-compacted"), text: el.textContent } : null;
    });
    if (seen) break;
    await page.waitForTimeout(1000);
  }
  const after = await snap().then((s) => ({ sessionId: s.sessionId, provider: s.provider }));

  console.log("압축 경계:", JSON.stringify(seen));
  console.log("압축 후:", JSON.stringify(after));

  console.log("RESULT (provider 에게 맡겼다 — native):", r && r.ok && r.native === true ? "PASS" : "FAIL");
  console.log("RESULT (압축 경계가 화면에 남았다):", seen ? "PASS" : "FAIL");
  console.log("RESULT (세션이 끊기지 않았다):", after.sessionId && after.sessionId === before.sessionId ? "PASS" : "FAIL");

  // 압축 턴은 말 없이 통계만 온다. 그때 아바타와 "Claude" 이름표까지 그리면 빈 말풍선으로 보인다.
  const tail = await ev(() => {
    const div = document.querySelector("[data-compacted]");
    const next = div?.nextElementSibling ?? null;
    return next ? { silent: next.hasAttribute("data-silent-turn"), text: next.textContent.trim().slice(0, 80) } : null;
  });
  console.log("구분선 다음 요소:", JSON.stringify(tail));
  console.log("RESULT (압축 뒤 빈 말풍선이 없다):", tail && tail.silent && !/Claude/.test(tail.text) ? "PASS" : "FAIL");

  await page.screenshot({ path: E2E + "/shot-compact.png" });
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
