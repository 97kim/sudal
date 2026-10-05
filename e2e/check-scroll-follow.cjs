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
  const statusOf = () => ev(async (id) => (await window.sudal.chat.snapshot(id)).status, tabId).catch(() => "?");
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
  // 코드로 scrollTop 을 바꾸면 사람의 스크롤과 구분할 수 없다 — 진짜 휠로 올린다.
  const box = await ev(() => { const r = document.querySelector("[data-message-list]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(700);
  const justUp = await m();
  console.log("흐르는 중에 올린 직후:", JSON.stringify(justUp));
  const stayed = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(500); stayed.push(await m()); if ((await statusOf()) === "idle" && i > 2) break; }
  const pulled = stayed.filter((x) => x.gap < 200).length;
  console.log("올린 뒤 표본:", stayed.map((x) => x.gap).join(","));
  result("올려 읽는 중에는 끌어내리지 않는다", justUp.gap > 300 && pulled === 0, `(끌려 내려간 표본 ${pulled}개)`);

  // (2b) 트랙패드처럼 몇 px 씩 올려도 떨리지 않는다 — 바닥 근처에서 다시 따라가기가 켜져 끌어내리면
  // 사람은 올리고 앱은 내리는 줄다리기가 된다. 진짜 휠 이벤트로 조금씩 올리며 scrollTop 이 도로 내려가는지 본다.
  await settle();
  // 글이 실제로 흐르기 시작할 때까지 기다린다 — 멈춘 화면에서는 끌어내리는 경쟁이 일어나지 않아 검사가 안 된다.
  const flowing = async () => {
    const h0 = (await m()).sh;
    for (let i = 0; i < 60; i++) { await page.waitForTimeout(250); if ((await m()).sh - h0 > 100) return true; }
    return false;
  };
  await page.mouse.move(box.x, box.y);
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  const started = await flowing();
  const before = await m();
  const tops = [];
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -3);
    await page.waitForTimeout(30);
    tops.push((await m()).st);
  }
  const grewWhileWheeling = (await m()).sh - before.sh;
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(300); tops.push((await m()).st); }
  const jumps = tops.filter((t, i) => i > 0 && t > tops[i - 1]).length;
  console.log("조금씩 올린 scrollTop:", tops.join(","), "· 그동안 자란 높이:", grewWhileWheeling);
  result("휠을 굴리기 전에 흐르는 글을 따라가고 있었다", started && before.gap < 2 && grewWhileWheeling > 100, `(시작 간격 ${before.gap}px, 자란 높이 ${grewWhileWheeling})`);
  result("조금씩 올려도 끌려 내려가지 않는다", jumps === 0 && tops[tops.length - 1] < tops[0], `(도로 내려간 횟수 ${jumps})`);
  await settle();

  // (2d) 스크롤바를 끌어 올려도 끌려 내려가지 않는다 — 휠 이벤트가 없어 scroll 이벤트보다 끌어내리기가 먼저 올 수 있다.
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  await flowing();
  const thumb = await ev(() => {
    const el = document.querySelector("[data-message-list]");
    const r = el.getBoundingClientRect();
    const bar = el.offsetWidth - el.clientWidth;
    return { bar, x: r.left + el.clientWidth + bar / 2, y: r.top + ((el.scrollTop + el.clientHeight / 2) / el.scrollHeight) * el.clientHeight };
  });
  const dragTops = [];
  if (thumb.bar > 0) {
    await page.mouse.move(thumb.x, thumb.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) { await page.mouse.move(thumb.x, thumb.y - i * 6); await page.waitForTimeout(40); dragTops.push((await m()).st); }
    await page.waitForTimeout(800);
    dragTops.push((await m()).st);
    await page.mouse.up();
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(400); dragTops.push((await m()).st); }
  }
  const dragJumps = dragTops.filter((t, i) => i > 0 && t > dragTops[i - 1]).length;
  console.log("스크롤바로 올린 scrollTop:", dragTops.join(","));
  result("스크롤바로 올려도 끌려 내려가지 않는다", thumb.bar > 0 && dragTops.length > 1 && dragJumps === 0 && dragTops[dragTops.length - 1] < dragTops[0], `(스크롤바 폭 ${thumb.bar}, 도로 내려간 횟수 ${dragJumps})`);
  await settle();

  // (2c) 조금 올렸다가 곧바로 바닥으로 돌아오면 다시 따라간다 — 유예 시간 안에 돌아와 멈춰도 풀린 채 남으면 안 된다.
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  await flowing();
  await page.mouse.wheel(0, -40);
  await page.waitForTimeout(40);
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(1500);
  const back = [];
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(400); back.push(await m()); }
  console.log("곧바로 돌아온 뒤 간격:", back.map((x) => x.gap).join(","));
  result("곧바로 바닥으로 돌아오면 다시 따라간다", back.length > 1 && back[back.length - 1].sh > back[0].sh && back.every((x) => x.gap < 2), `(간격 ${back.map((x) => x.gap).join(",")})`);

  // (2e) 사람이 손대지 않았는데 위쪽 내용이 줄면 브라우저가 스크롤 위치를 스스로 당긴다(scroll anchoring).
  // 레이아웃이 일찍 계산되면 그 scroll 이벤트가 크기 변화(ResizeObserver)보다 먼저 와서, 예전엔 "사람이 올렸다" 로 읽고 따라가기를 껐다.
  // 실제로는 보낸 직후 "생각 중" 이 붙을 때 위쪽 줄이 함께 줄며 일어났다. 같은 모양을 손으로 만든다.
  await settle();
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  await flowing();
  const anch = await ev(() => {
    const el = document.querySelector("[data-message-list]");
    const before = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
    const top = el.getBoundingClientRect().top;
    const above = [...el.querySelectorAll("[data-block-id]")].find((n) => n.getBoundingClientRect().bottom < top - 100 && n.offsetHeight > 80);
    if (!above) return { before, ok: false };
    above.style.height = `${above.offsetHeight - 55}px`;
    above.style.overflow = "hidden";
    above.setAttribute("data-e2e-shrunk", "");
    const tail = document.createElement("div");
    tail.style.height = "79px";
    tail.setAttribute("data-e2e-tail", "");
    el.firstElementChild.appendChild(tail);
    void el.scrollHeight; // 레이아웃을 지금 계산하게 해 scroll 이벤트가 먼저 오게 한다
    return { before, ok: true };
  });
  await page.waitForTimeout(400);
  const afterAnch = await m();
  await ev(() => { document.querySelector("[data-e2e-tail]")?.remove(); const n = document.querySelector("[data-e2e-shrunk]"); if (n) { n.style.height = ""; n.style.overflow = ""; n.removeAttribute("data-e2e-shrunk"); } });
  console.log("위쪽이 줄고 아래가 붙은 뒤:", JSON.stringify({ ...anch, ...afterAnch }));
  result("위쪽 내용이 줄어 브라우저가 위치를 당겨도 따라가기가 풀리지 않는다", anch.ok && anch.before < 2 && !afterAnch.pill && afterAnch.gap < 2, `(간격 ${afterAnch.gap}px, 버튼 ${afterAnch.pill})`);

  // (3) 보내면 맨 아래로
  await settle();
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, -2000);
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
