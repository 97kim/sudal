// 자동 스크롤의 세 가지 규칙을 한 번에 본다.
//  (1) 글이 흐르는 동안 맨 아래를 따라간다 — 사람이 손대지 않았는데 풀리면 안 된다
//  (2) 사람이 위로 올려 읽으면 끌어내리지 않는다
//  (3) 메시지를 보내면 맨 아래로 간다 (자기 메시지는 보여야 하니 예외)
//
// (1) 이 깨졌던 이유: "바닥에서 멀면 사용자가 올린 것" 으로 판단했는데, 글이 흐르는 중에는
// 맨 아래로 맞춘 직후에 높이가 또 자라서 그 간격이 사용자 행동으로 읽혔다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };


const LONG = "1부터 150까지를 마크다운 목록으로 출력해라. 각 줄은 정확히 `- N` 형식이고 다른 말은 하지 마라.";

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "스크롤" + Date.now(), "--activate");
  await page.waitForTimeout(2500);
  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));

  const m = () => ev(() => {
    const el = document.querySelector("[data-message-list]");
    return { gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), pill: !!document.querySelector("[data-scroll-bottom]"), sh: el.scrollHeight, st: Math.round(el.scrollTop) };
  });
  const statusOf = () => ev(async (id) => (await window.workbench.chat.snapshot(id)).status, tabId).catch(() => "?");
  const settle = async () => { for (let i = 0; i < 180; i++) { if ((await statusOf()) === "idle") return; await page.waitForTimeout(1000); } };

  // (1) 흐르는 동안 따라가는가
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  const during = [];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    during.push(await m());
    if ((await statusOf()) === "idle" && i > 4) break;
  }
  const loose = during.filter((x) => x.gap > 80).length;
  // 정지 화면에서도 통과하면 검사가 아니다 — 표본을 뜨는 동안 실제로 내용이 자랐는지 본다.
  const grew = during.length > 1 && during[during.length - 1].sh - during[0].sh > 500;
  result("표본을 뜨는 동안 글이 실제로 흘렀다", grew, `(높이 ${during[0]?.sh} → ${during[during.length - 1]?.sh})`);
  console.log("흐르는 동안 표본:", during.length, "· 바닥에서 떨어진 표본:", loose, "· 최대 간격:", Math.max(...during.map((x) => x.gap)));
  result("흐르는 동안 맨 아래를 따라간다", loose === 0);
  await settle();
  await page.waitForTimeout(800);

  // (2) 사람이 올려 읽으면 그대로 둔다 — 흐르는 도중에 올린다(보내는 것은 맨 아래로 가는 게 맞으니 섞지 않는다)
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  await page.waitForTimeout(2500);
  const mid = await m();
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = Math.max(0, el.scrollTop - 1200); });
  await page.waitForTimeout(700);
  const justUp = await m();
  console.log("흐르는 중에 올린 직후:", JSON.stringify(justUp));
  const stayed = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(500); stayed.push(await m()); if ((await statusOf()) === "idle" && i > 2) break; }
  const pulled = stayed.filter((x) => x.gap < 200).length;
  console.log("올린 뒤 표본:", stayed.map((x) => x.gap).join(","));
  result("올려 읽는 중에는 끌어내리지 않는다", justUp.gap > 300 && pulled === 0, `(끌려 내려간 표본 ${pulled}개)`);

  // (3) 보내면 맨 아래로
  await settle();
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = Math.max(0, el.scrollTop - 2000); });
  await page.waitForTimeout(500);
  cli("tab", "send", "--tab", tabId, "--text", "고맙다. 한 글자로 답해라.");
  await page.waitForTimeout(2000);
  const afterSend = await m();
  console.log("보낸 직후:", JSON.stringify(afterSend));
  result("보내면 맨 아래로 간다", afterSend.gap < 80, `(${afterSend.gap}px 남음)`);

  await settle();
  await page.screenshot({ path: E2E + "/shot-scroll-follow.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
