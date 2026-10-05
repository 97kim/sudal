// 헤더 정리: 버튼 수가 줄었는지, 제목·경로가 안 잘리는지, 가끔 쓰는 동작이 "더보기" 메뉴에 들어갔는지.
const os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "헤더 정리 확인용 긴 제목", "--activate");
  await page.waitForTimeout(2500);

  const head = await ev(() => {
    const h = document.querySelector("header");
    if (!h) return null;
    const btns = [...h.querySelectorAll("button")].map((x) => x.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
    const cwd = h.querySelector("[data-cwd]");
    const path2 = cwd ? cwd.innerText.trim() : null;
    const clipped = cwd ? cwd.scrollWidth > cwd.clientWidth + 1 : null;
    return { btns, path: path2, clipped, more: !!h.querySelector("[data-header-more]") };
  });
  console.log("헤더 버튼:", JSON.stringify(head.btns));
  console.log("경로 표시:", JSON.stringify(head.path), "| 잘림:", head.clipped);
  console.log("RESULT (더보기 버튼 있음):", head.more ? "PASS" : "FAIL");
  const groups = head.btns.filter((t) => t.length > 0).length - 1; // 검증의 편집 버튼은 같은 덩어리
  console.log("RESULT (헤더 덩어리 5개 이하):", groups <= 5 ? "PASS" : `FAIL (${groups}개)`);
  console.log("RESULT (경로가 안 잘림):", head.clipped === false ? "PASS" : "FAIL");
  const gone = await ev(() => ["[data-fanout]", "[data-cross-review]", "[data-orch]", "[data-attach-terminal]"].filter((s) => document.querySelector("header " + s)));
  console.log("RESULT (가끔 쓰는 버튼이 헤더에서 빠짐):", gone.length === 0 ? "PASS" : `FAIL (${gone.join(",")} 남음)`);
  await page.screenshot({ path: E2E + "/shot-header-before-menu.png" });

  await page.click("[data-header-more]");
  await page.waitForTimeout(600);
  const menu = await ev(() => {
    const m = document.querySelector("[data-header-menu]");
    if (!m) return null;
    return [...m.querySelectorAll("[data-header-menu-item]")].map((x) => ({ key: x.getAttribute("data-header-menu-item"), text: x.innerText.replace(/\s+/g, " ").trim().slice(0, 60), disabled: x.disabled }));
  });
  console.log("메뉴 항목:", JSON.stringify(menu, null, 1));
  const keys = (menu || []).map((m) => m.key);
  console.log("RESULT (메뉴에 4개 동작):", ["fanout", "cross-review", "orchestration", "attach-terminal"].every((k) => keys.includes(k)) ? "PASS" : "FAIL");
  console.log("RESULT (설명 문구가 보임):", menu && menu[0].text.length > 10 ? "PASS" : "FAIL");
  await page.screenshot({ path: E2E + "/shot-header-menu.png" });

  // 같은 버튼을 다시 누르면 닫힌다(토글). 바깥 mousedown 으로 닫고 이어지는 click 이 다시 열어
  // 계속 열린 것처럼 보이던 자리다.
  await page.click("[data-header-more]");
  await page.waitForTimeout(400);
  console.log("RESULT (버튼을 다시 누르면 닫힘):", await ev(() => !document.querySelector("[data-header-menu]")) ? "PASS" : "FAIL");
  await page.click("[data-header-more]"); // esc 검사를 위해 다시 연다
  await page.waitForTimeout(400);

  await page.keyboard.press("Escape"); // 더보기 메뉴가 검증 버튼을 가리지 않게 먼저 닫는다
  await page.waitForTimeout(300);

  // 검증 편집 팝오버도 같은 토글이다. 여기는 anchor 가 "검증" 실행 버튼까지 감싸므로
  // 토글 버튼만 짚어 고쳤다 — 검증을 누르면 팝오버가 닫히는 것까지 같이 본다.
  await page.click("[data-verify-edit]");
  await page.waitForTimeout(400);
  console.log("RESULT (검증 편집이 열림):", await ev(() => !!document.querySelector("[data-verify-popover]")) ? "PASS" : "FAIL");
  await page.click("[data-verify-edit]");
  await page.waitForTimeout(400);
  console.log("RESULT (검증 편집을 다시 누르면 닫힘):", await ev(() => !document.querySelector("[data-verify-popover]")) ? "PASS" : "FAIL");
  // 토글 버튼만 예외로 뒀으니 바깥 클릭으로 닫히는 동작은 그대로여야 한다.
  // ("검증" 버튼은 저장된 명령이 없으면 편집기를 여는 것이 제 동작이라 바깥 클릭 예시로 쓸 수 없다.)
  await page.click("[data-verify-edit]");
  await page.waitForTimeout(400);
  await page.click("[data-header-more]"); // 바깥을 누른다 — 팝오버는 닫히고 더보기 메뉴가 열린다
  await page.waitForTimeout(500);
  console.log("RESULT (바깥을 누르면 검증 편집이 닫힘):", await ev(() => !document.querySelector("[data-verify-popover]")) ? "PASS" : "FAIL");

  // esc 로 닫힌다
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  console.log("RESULT (esc 로 닫힘):", await ev(() => !document.querySelector("[data-header-menu]")) ? "PASS" : "FAIL");

  const s = await ev(() => window.sudal.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.sudal.workspaces.deleteTab(id), t.id); await ev((id) => window.sudal.workspaces.remove(id), w.id); }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
