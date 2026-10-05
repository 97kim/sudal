// 보내고 나면 맨 아래로 가는가. 위로 올려 읽던 중에 보내는 경우가 문제로 지목됐다.
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

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "스크롤" + Date.now(), "--activate");
  await page.waitForTimeout(2500);
  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));
  const settle = async () => { for (let i = 0; i < 180; i++) { const s = await ev((id) => window.sudal.chat.snapshot(id), tabId); if (s.status === "idle" || s.status === "error") return s; await page.waitForTimeout(1000); } };
  const metrics = () => ev(() => {
    const el = document.querySelector("[data-message-list]");
    if (!el) return null;
    return { gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), h: el.scrollHeight, pill: !!document.querySelector("[data-scroll-bottom]") };
  });

  // 스크롤이 생길 만큼 내용을 만든다
  cli("tab", "send", "--tab", tabId, "--text", "1부터 150까지를 마크다운 목록으로 출력해라. 각 줄은 정확히 `- N` 형식이고 다른 말은 하지 마라.");
  await settle();
  await page.waitForTimeout(1200);
  const first = await metrics();
  console.log("첫 응답 뒤:", JSON.stringify(first));
  const overflow = await ev(() => { const el = document.querySelector("[data-message-list]"); return el.scrollHeight - el.clientHeight; });
  console.log("넘치는 높이:", overflow);
  if (overflow < 200) { console.log("RESULT: SKIP (스크롤이 생길 만큼 길지 않다)"); await b.close(); return; }

  // 사용자가 위로 올려 읽는 상황
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(600);
  const up = await metrics();
  console.log("위로 올린 뒤:", JSON.stringify(up));

  // 여기서 메시지를 보낸다 — 자기 메시지는 보여야 한다
  cli("tab", "send", "--tab", tabId, "--text", "좋아, 고마워.");
  await page.waitForTimeout(1500);
  const afterSend = await metrics();
  console.log("보낸 직후:", JSON.stringify(afterSend));
  result("보내면 맨 아래로 간다", afterSend && afterSend.gap < 80, `(아래까지 ${afterSend && afterSend.gap}px 남음)`);

  await settle();
  await page.waitForTimeout(1200);
  const afterTurn = await metrics();
  console.log("응답 끝난 뒤:", JSON.stringify(afterTurn));
  result("응답까지 따라 내려간다", afterTurn && afterTurn.gap < 80, `(아래까지 ${afterTurn && afterTurn.gap}px 남음)`);


  // 실제 사용 경로: 입력창에 쳐서 Enter. cli 로 넣는 것과 달리 입력창 높이가 바뀐다.
  const typeSend = async (text) => {
    await ev((t) => {
      const ta = document.querySelector("textarea");
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      set.call(ta, t);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
    }, text);
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
  };

  // 위로 올려 둔 상태에서 입력창으로 보낸다
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(600);
  console.log("다시 위로:", JSON.stringify(await metrics()));
  await typeSend("입력창으로 보낸다. 짧게 답해라.");
  await page.waitForTimeout(1500);
  const typed = await metrics();
  console.log("입력창으로 보낸 직후:", JSON.stringify(typed));
  result("입력창으로 보내도 맨 아래로 간다", typed && typed.gap < 80, `(아래까지 ${typed && typed.gap}px 남음)`);

  // 응답이 도는 중에 한 번 더 보낸다(대기열로 들어가는 경로). 보낸 메시지는 앞 응답이 끝나야 목록에 나타나므로,
  // 앞 응답이 아직 흐르는 동안 맨 아래로 왔는지 본다. 앞 응답이 금방 끝나 버리면 검사가 안 되니 긴 응답을 쓴다.
  await settle();
  cli("tab", "send", "--tab", tabId, "--text", "1부터 200까지를 마크다운 목록으로 출력해라. 각 줄은 정확히 `- N` 형식이고 다른 말은 하지 마라.");
  const h0 = (await metrics()).h;
  for (let i = 0; i < 60 && (await metrics()).h - h0 < 300; i++) await page.waitForTimeout(250);
  const box = await ev(() => { const r = document.querySelector("[data-message-list]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(600);
  const before = await metrics();
  await typeSend("이건 대기열로 들어갈 것이다.");
  await page.waitForTimeout(800);
  const queued = await metrics();
  const still = (await ev((id) => window.sudal.chat.snapshot(id), tabId)).status;
  console.log("올린 뒤:", JSON.stringify(before), "· 응답 중에 보낸 직후:", JSON.stringify(queued), "· 상태:", still);
  result("응답 중에 올려 읽고 있었다", before.gap > 300 && before.pill, `(간격 ${before.gap}px)`);
  result("응답 중에 보내도 맨 아래로 간다(앞 응답이 아직 도는 중)", still === "running" && queued.gap < 2 && !queued.pill, `(상태 ${still}, 아래까지 ${queued.gap}px)`);
  await settle();

  await page.screenshot({ path: E2E + "/shot-scroll-send.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
