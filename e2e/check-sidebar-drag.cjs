// 사이드바에서 끌어 옮기기. 워크스페이스끼리, 같은 워크스페이스의 열린 세션끼리 자리를 바꾼다.
// 브라우저 드래그를 사람 없이 재현해야 하므로 HTML5 드래그 이벤트를 직접 쏜다.
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

// 실행마다 새 워크스페이스를 쓴다 — 지난 실행의 세션이 섞이면 순서를 볼 수 없다.
const stamp = Date.now();
const A = `/tmp/sudal-drag-a-${stamp}`, B = `/tmp/sudal-drag-b-${stamp}`;

(async () => {
  for (const d of [A, B]) fs.mkdirSync(d, { recursive: true });
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const wsA = cli("ws", "add", "--path", A).workspaceId;
  const wsB = cli("ws", "add", "--path", B).workspaceId;
  const t1 = cli("tab", "new", "--ws", wsA, "--provider", "claude", "--title", "하나").tab.id;
  const t2 = cli("tab", "new", "--ws", wsA, "--provider", "claude", "--title", "둘").tab.id;
  const t3 = cli("tab", "new", "--ws", wsA, "--provider", "claude", "--title", "셋").tab.id;
  await page.waitForTimeout(2000);

  const order = (sel) => ev((s) => [...document.querySelectorAll(s)].map((e) => e.getAttribute(s.slice(1, -1))), sel);
  const sessionsIn = (wsId) => ev((id) => {
    const w = document.querySelector(`[data-workspace="${id}"]`);
    return w ? [...w.querySelectorAll("[data-session]")].map((e) => e.getAttribute("data-session")) : [];
  }, wsId);
  // 닫힌 세션은 자리를 정할 수 없다 — 순서를 볼 때는 열린 것만 센다.
  const openSessionsIn = (wsId) => ev((id) => {
    const w = document.querySelector(`[data-workspace="${id}"]`);
    return w ? [...w.querySelectorAll('[data-session][data-open="true"]')].map((e) => e.getAttribute("data-session")) : [];
  }, wsId);

  // 사람 없이 드래그를 재현한다 — React 는 이 이벤트들을 그대로 받는다.
  // 실제 드래그처럼 이벤트 사이에 틈을 둔다(한 틱에 몰아 쏘면 화면이 아직 갱신되지 않은 상태를 시험하게 된다).
  const fire = (sel, type, y, outside = false) => ev(([s, t, yy, out]) => {
    const el = document.querySelector(s);
    if (!el) return "없음";
    window.__dt = window.__dt || new DataTransfer();
    el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientY: yy, relatedTarget: out ? document.body : null }));
    return "ok";
  }, [sel, type, y, outside]);
  const dropMark = (sel) => ev((s) => document.querySelector(s)?.getAttribute("data-drop") ?? null, sel);
  const midY = (sel, af) => ev(([s, a]) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return r.top + r.height * (a ? 0.75 : 0.25);
  }, [sel, af]);
  const dragTo = async (srcSel, dstSel, after) => {
    await fire(srcSel, "dragstart", 0);
    await page.waitForTimeout(150);
    const y = await midY(dstSel, after);
    await fire(dstSel, "dragover", y);
    await page.waitForTimeout(150);
    await fire(dstSel, "drop", y);
    await fire(srcSel, "dragend", y);
  };

  const before = await sessionsIn(wsA);
  console.log("처음 세션 순서:", JSON.stringify(before.map((id) => ({ [id.slice(0, 4)]: 1 }))));
  // 워크스페이스를 만들면 빈 세션이 하나 딸려 오므로, 셋의 상대 순서만 본다.
  const rank = (list) => [t1, t2, t3].map((id) => list.indexOf(id));
  const inOrder = (list, ids) => { const r = ids.map((id) => list.indexOf(id)); return r.every((v) => v >= 0) && r.every((v, i) => i === 0 || r[i - 1] < v); };
  result("세 세션이 순서대로 만들어졌다", inOrder(before, [t1, t2, t3]), `(순위 ${rank(before).join(",")})`);

  // 셋 → 하나 위로
  await dragTo(`[data-session="${t3}"]`, `[data-session="${t1}"]`, false);
  await page.waitForTimeout(800);
  const afterTab = await sessionsIn(wsA);
  result("세션을 끌어 위로 옮긴다", inOrder(afterTab, [t3, t1, t2]), `(순위 ${rank(afterTab).join(",")})`);

  // 되돌리기: 셋을 둘 뒤로
  await dragTo(`[data-session="${t3}"]`, `[data-session="${t2}"]`, true);
  await page.waitForTimeout(800);
  const back = await sessionsIn(wsA);
  result("아래로도 옮긴다", inOrder(back, [t1, t2, t3]), `(순위 ${rank(back).join(",")})`);

  // 워크스페이스 순서
  const wsBefore = await order("[data-workspace]");
  const iA = wsBefore.indexOf(wsA), iB = wsBefore.indexOf(wsB);
  result("두 워크스페이스가 보인다", iA >= 0 && iB >= 0);
  await dragTo(`[data-workspace-head="${wsB}"]`, `[data-workspace-head="${wsA}"]`, false);
  await page.waitForTimeout(800);
  const wsAfter = await order("[data-workspace]");
  result("워크스페이스를 끌어 옮긴다", wsAfter.indexOf(wsB) < wsAfter.indexOf(wsA), `(B=${wsAfter.indexOf(wsB)}, A=${wsAfter.indexOf(wsA)})`);

  // 닫힌 세션은 끌 수 없다(최근 순으로 보여 주므로 자리를 정할 수 없다)
  cli("tab", "close", "--tab", t2);
  await page.waitForTimeout(800);
  const closedDraggable = await ev((id) => {
    const el = document.querySelector(`[data-session="${id}"]`);
    return el ? el.getAttribute("draggable") : null;
  }, t2);
  result("닫힌 세션은 끌 수 없다", closedDraggable === "false", `(draggable=${closedDraggable})`);

  // 닫힌 세션은 받지도 않아야 한다. draggable=false 는 출발만 막는다 —
  // 선이 뜨고 드롭까지 받으면 "될 것처럼 보이고 아무 일도 안 일어나는" 상태가 된다.
  const beforeClosed = await sessionsIn(wsA);
  await fire(`[data-session="${t1}"]`, "dragstart", 0);
  await page.waitForTimeout(150);
  const yClosed = await midY(`[data-session="${t2}"]`, false);
  await fire(`[data-session="${t2}"]`, "dragover", yClosed);
  await page.waitForTimeout(200);
  const markOnClosed = await dropMark(`[data-session="${t2}"]`);
  await fire(`[data-session="${t2}"]`, "drop", yClosed);
  await fire(`[data-session="${t1}"]`, "dragend", yClosed);
  await page.waitForTimeout(500);
  const afterClosed = await sessionsIn(wsA);
  result("닫힌 세션 위에는 선이 뜨지 않는다", markOnClosed === null, `(data-drop=${markOnClosed})`);
  result("닫힌 세션에 떨어뜨려도 순서가 그대로다", afterClosed.join() === beforeClosed.join());

  // 유효한 자리를 벗어나면 선을 지운다
  await fire(`[data-session="${t1}"]`, "dragstart", 0);
  await page.waitForTimeout(150);
  const yOver = await midY(`[data-session="${t3}"]`, false);
  await fire(`[data-session="${t3}"]`, "dragover", yOver);
  await page.waitForTimeout(200);
  const shown = await dropMark(`[data-session="${t3}"]`);
  await fire(`[data-session="${t3}"]`, "dragleave", yOver, true);
  await page.waitForTimeout(200);
  const cleared = await dropMark(`[data-session="${t3}"]`);
  await fire(`[data-session="${t1}"]`, "dragend", yOver);
  result("유효한 자리에는 선이 뜬다", shown !== null, `(data-drop=${shown})`);
  result("벗어나면 선이 지워진다", cleared === null, `(data-drop=${cleared})`);

  // 드래그 중 자동 스크롤 — 목적지가 화면 밖일 때 끌고 갈 수 있어야 한다
  const treeState = () => ev(() => {
    const el = document.querySelector("[data-workspace-tree]");
    return el ? { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), rect: el.getBoundingClientRect().toJSON() } : null;
  });
  const t0 = await treeState();
  if (!t0 || t0.max < 60) {
    console.log("SKIP (목록이 스크롤될 만큼 길지 않다)");
  } else {
    await ev(() => { document.querySelector("[data-workspace-tree]").scrollTop = 0; });
    await fire(`[data-session="${t1}"]`, "dragstart", 0);
    await page.waitForTimeout(150);
    // 목록 아래 가장자리 안쪽으로 끌고 간다
    const y = Math.round(t0.rect.bottom - 8);
    for (let i = 0; i < 8; i++) { await fire("[data-workspace-tree]", "dragover", y); await page.waitForTimeout(100); }
    const t1s = await treeState();
    await fire(`[data-session="${t1}"]`, "dragend", y);
    await page.waitForTimeout(300);
    const t2s = await treeState();
    result("가장자리로 끌면 목록이 스스로 내려간다", t1s.top > 20, `(scrollTop=${t1s?.top})`);
    result("드래그가 끝나면 스크롤도 멈춘다", Math.abs(t2s.top - t1s.top) < 40, `(${t1s?.top} → ${t2s?.top})`);
  }

  // 우클릭 메뉴로도 옮긴다(끌기 대안)
  const menuPick = async (sel, label) => {
    await ev((s) => {
      const el = document.querySelector(s);
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
    }, sel);
    await page.waitForTimeout(400);
    return ev((l) => {
      const items = [...document.querySelectorAll("[data-session-menu] [role=menuitem]")];
      const it = items.find((e) => e.textContent.trim() === l);
      if (!it) return "없음";
      if (it.disabled) return "잠김";
      it.click();
      return "눌림";
    }, label);
  };

  const beforeMenu = await openSessionsIn(wsA);
  const last = beforeMenu[beforeMenu.length - 1];
  const picked = await menuPick(`[data-session="${last}"]`, "위로 이동");
  await page.waitForTimeout(700);
  const afterMenu = await openSessionsIn(wsA);
  result("메뉴의 '위로 이동' 이 있다", picked === "눌림", `(${picked})`);
  result("메뉴로 순서가 바뀐다", afterMenu.indexOf(last) === beforeMenu.indexOf(last) - 1, `(${beforeMenu.indexOf(last)} → ${afterMenu.indexOf(last)})`);

  // 맨 위에서는 '위로 이동' 이 잠겨 있다
  const first = (await openSessionsIn(wsA))[0];
  const lockedPick = await menuPick(`[data-session="${first}"]`, "위로 이동");
  await ev(() => document.body.click());
  result("맨 위에서는 '위로 이동' 이 잠긴다", lockedPick === "잠김", `(${lockedPick})`);

  await page.screenshot({ path: E2E + "/shot-sidebar-drag.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
