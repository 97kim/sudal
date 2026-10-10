// 채팅 화면 어디에 놓아도 첨부, 이미지 말고 다른 파일은 파일 카드로. usage: node e2e/scenario-drop-attach.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
//  A) 파일을 끌고 들어오면 채팅 화면 전체에 "놓으면 입력창에 첨부해요" 덮개가 뜬다
//  B) 입력창 밖(헤더)에 이미지를 놓아도 입력창에 이미지로 붙는다
//  C) 첨부 파일은 카드로 보이고, 빼면 앱을 다시 열어도 남은 것만 있다
// 한계: 테스트에서 만든 File 에는 실제 경로가 없어(Electron 이 실제로 끌어다 놓은 파일에만 준다) 경로 첨부는 저장값으로 확인한다.
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-drop-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-drop-repo-"));
const cli = (...a) => {
  try {
    return JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: userData }, encoding: "utf8" }));
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { throw e; }
  }
};
const { chromium } = require("playwright-core");
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const results = [];
const res = (n, ok, x = "") => { results.push([n, ok]); log(`RESULT ${n}:`, ok ? "PASS" : "FAIL", x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1×1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const proc = spawn(app + "/Contents/MacOS/Sudal", ["--remote-debugging-port=9333", `--user-data-dir=${userData}`], { stdio: "ignore", env: { ...process.env, SUDAL_USERDATA: userData } });
  let b = null;
  for (let i = 0; i < 60 && !b; i++) { await sleep(500); try { b = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch {} }
  const findPage = async () => { for (let i = 0; i < 40; i++) { const p = b.contexts().flatMap((c) => c.pages()).find((x) => x.url().includes("/renderer/index.html")); if (p) return p; await sleep(250); } };
  let page = await findPage();
  await page.waitForFunction(() => !!document.querySelector("[data-composer]"), null, { timeout: 30000 }).catch(() => {});
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  const ws = cli("ws", "add", "--path", repo);
  const tab = cli("tab", "new", "--ws", ws.workspaceId, "--title", "드롭").tab.id;
  cli("tab", "activate", "--tab", tab);
  await page.waitForFunction(() => !!document.querySelector("[data-composer] textarea"), null, { timeout: 20000 });
  await sleep(800);
  const ev = (fn, a) => page.evaluate(fn, a);

  // A·B: 헤더(입력창 밖)에 이미지 파일을 끌어다 놓는다
  const overShown = await ev((png) => {
    const header = document.querySelector("header");
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    header.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return new Promise((r) => requestAnimationFrame(() => {
      const shown = !!document.querySelector('[data-chat-drop="over"]');
      header.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      r(shown);
    }));
  }, PNG);
  res("A (끌고 들어오면 화면 전체 덮개)", overShown);
  await sleep(800);
  const imgs = await ev(() => document.querySelectorAll("[data-composer] img").length);
  const overGone = await ev(() => !document.querySelector('[data-chat-drop="over"]'));
  res("B (입력창 밖에 놓은 이미지가 입력창에 붙음)", imgs === 1 && overGone, JSON.stringify({ imgs, overGone }));

  // C: 첨부 파일 두 개를 저장값으로 넣고 다시 연다 → 카드 두 개, 하나 빼고 다시 열면 하나
  await ev((id) => window.sudal.state.set(`composerFiles.${id}`, JSON.stringify([{ path: "/tmp/My Report.pdf", name: "My Report.pdf" }, { path: "/tmp/src", name: "src" }])), tab);
  await sleep(400);
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("[data-composer] textarea"), null, { timeout: 20000 });
  await sleep(800);
  const cards = await ev(() => [...document.querySelectorAll("[data-composer-file]")].map((x) => x.getAttribute("data-composer-file")));
  const folderIcon = await ev(() => !!document.querySelector('[data-composer-file="src"]'));
  await ev(() => document.querySelector('[data-composer-file="My Report.pdf"] button')?.click());
  await sleep(500);
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("[data-composer] textarea"), null, { timeout: 20000 });
  await sleep(800);
  const after = await ev(() => [...document.querySelectorAll("[data-composer-file]")].map((x) => x.getAttribute("data-composer-file")));
  res("C (파일 카드 · 빼면 다시 열어도 남은 것만)", JSON.stringify(cards) === '["My Report.pdf","src"]' && folderIcon && JSON.stringify(after) === '["src"]', JSON.stringify({ cards, after }));

  res("렌더러 오류 없음", errs.length === 0, errs.join(" | "));
  await b.close().catch(() => {});
  proc.kill("SIGKILL");
  for (const d of [userData, repo]) fs.rmSync(d, { recursive: true, force: true });
  log(`${results.filter((r) => r[1]).length}/${results.length} PASS`);
  process.exit(results.every((r) => r[1]) ? 0 : 1);
})().catch((e) => { console.error("ERR", e.stack || e.message); process.exit(1); });
