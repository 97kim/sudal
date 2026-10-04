// 에이전트가 인앱 브라우저를 직접 조작한다: sudal browser read / click / fill.
// CLI 로만 부른다 — 모델이 실제로 쓰게 될 통로가 그것이기 때문이다.
const path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const run = (...a) => execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" });
const cli = (...a) => JSON.parse(run(...a));
const tryCli = (...a) => {
  try {
    return JSON.parse(run(...a));
  } catch (e) {
    try {
      return JSON.parse(e.stdout || "{}");
    } catch {
      return { error: { message: String(e.message).slice(0, 160) } };
    }
  }
};
const { chromium } = require("playwright-core");

// 눌러야 상태가 바뀌고, 입력해야 값이 남는 페이지.
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset=utf-8><title>주문 폼</title><body>
    <h1>주문서</h1>
    <p id=status>상태: 대기</p>
    <input id=email name=email placeholder="이메일">
    <textarea id=memo placeholder="메모"></textarea>
    <button id=save>저장하기</button>
    <button id=cancel>취소</button>
    <a href="/next">다음 단계</a>
    <script>
      document.getElementById("save").onclick = () => {
        const e = document.getElementById("email").value;
        const m = document.getElementById("memo").value;
        document.getElementById("status").textContent = "상태: 저장됨 " + e + " / " + m;
      };
    </script></body>`);
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "조작", "--activate");
  await page.waitForTimeout(2000);

  // 브라우저가 없을 때는 뚜렷하게 거절해야 한다 — 모델이 뭘 해야 할지 알 수 있게.
  const noBrowser = tryCli("browser", "read", "--tab", "조작");
  console.log("브라우저 없을 때:", JSON.stringify(noBrowser).slice(0, 160));
  console.log("RESULT (브라우저가 없으면 무엇을 하라고 알려 준다):", /browser open/.test(JSON.stringify(noBrowser)) ? "PASS" : "FAIL");

  cli("browser", "open", "--tab", "조작", "--url", `http://127.0.0.1:${port}/`);
  // 브라우저가 붙고 main 에 등록될 때까지 기다린다 — read 가 될 때가 준비된 때다.
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    await page.waitForTimeout(1000);
    ready = !tryCli("browser", "read", "--tab", "조작").error;
  }
  console.log("RESULT (브라우저를 열면 에이전트가 쓸 수 있게 된다):", ready ? "PASS" : "FAIL");

  // ---------- read ----------
  const read = cli("browser", "read", "--tab", "조작");
  const kinds = (read.controls ?? []).reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] ?? 0) + 1 }), {});
  console.log("read:", JSON.stringify({ title: read.title, textHas: /주문서/.test(read.text ?? ""), kinds }));
  console.log("RESULT (페이지 글을 읽는다):", /주문서/.test(read.text ?? "") && /상태: 대기/.test(read.text ?? "") ? "PASS" : "FAIL");
  console.log("RESULT (누를 만한 것을 선택자와 함께 준다):", (read.controls ?? []).some((c) => c.selector === "#save" && c.label.includes("저장")) ? "PASS" : "FAIL");
  console.log("RESULT (링크·입력도 찾는다):", kinds.link >= 1 && kinds.input >= 2 ? "PASS" : "FAIL");

  // ---------- fill ----------
  cli("browser", "fill", "--tab", "조작", "--selector", "#email", "--value", "a@b.c");
  cli("browser", "fill", "--tab", "조작", "--selector", "#memo", "--value", '따옴표 " 와 \\ 역슬래시');
  // ---------- click ----------
  const clicked = cli("browser", "click", "--tab", "조작", "--text", "저장");
  await page.waitForTimeout(800);
  const after = cli("browser", "read", "--tab", "조작");
  console.log("click:", JSON.stringify(clicked.clicked ?? clicked).slice(0, 120));
  console.log("상태 줄:", (after.text ?? "").split("\n").find((l) => l.startsWith("상태:")));

  console.log("RESULT (글로 버튼을 찾아 누른다 — 취소가 아니라 저장):", clicked.clicked?.selector === "#save" ? "PASS" : "FAIL");
  console.log("RESULT (입력값이 실제로 들어갔다):", /a@b\.c/.test(after.text ?? "") ? "PASS" : "FAIL");
  console.log("RESULT (따옴표·역슬래시가 그대로 들어갔다):", /따옴표 " 와 \\ 역슬래시/.test(after.text ?? "") ? "PASS" : "FAIL");

  // 선택자로도 눌린다
  const bySel = cli("browser", "click", "--tab", "조작", "--selector", "#cancel");
  console.log("RESULT (선택자로도 누른다):", bySel.clicked?.selector === "#cancel" ? "PASS" : "FAIL");

  // 없는 선택자는 뚜렷한 오류
  const missing = tryCli("browser", "click", "--tab", "조작", "--selector", "#없는것");
  console.log("RESULT (없는 선택자는 뚜렷한 오류):", /맞는 요소가 없습니다/.test(JSON.stringify(missing)) ? "PASS" : "FAIL");

  await b.close();
  srv.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
