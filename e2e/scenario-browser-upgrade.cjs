// 인앱 브라우저 고도화 검증. usage: node e2e/scenario-browser-upgrade.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
//  A) target=_blank 링크가 지금 페이지를 덮지 않고 새 브라우저 탭으로 열린다
//  B) 느린 페이지를 여는 동안 로딩 막대가 보인다
//  C) 꺼진 포트는 오류 화면(refused)과 다시 시도 버튼을 보여 주고, 서버가 뜨면 다시 시도로 열린다
//  D) 확대 배율은 호스트별로 기억된다(localhost 확대 → 127.0.0.1 은 100% → localhost 로 돌아오면 다시 확대)
//  E) 받은 파일이 다운로드 줄에 "받았어요" 로 뜬다(실제 다운로드 폴더에 받으므로 끝에 지운다)
//  F) 빈 브라우저 탭에 자주 간 곳이 보인다
//  H) 리뷰 반영: 첫 페이지의 window.open 도 새 탭으로, 같은 이름 동시 다운로드는 다른 파일로, screenshot --out 은 있는 파일을 덮지 않는다
//  I) 요소 선택이 React 디버그 정보로 소스 위치를 찾아 첨부·알림에 싣고, 알림에서 에디터로 연다
//  G) 에이전트 명령: wait·console·network·press·scroll·screenshot 이 실제 웹뷰에서 동작한다
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http"), net = require("net"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-br-"));
// 탭 cwd 와 파일 찾기가 돌려주는 실제 경로(/private/var…)가 같아야 상대 경로로 보인다.
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-br-repo-")));
fs.mkdirSync(path.join(repo, "src/pages"), { recursive: true });
fs.writeFileSync(path.join(repo, "src/pages/Dashboard.tsx"), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join("\n"));
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
const fileName = `sudal-e2e-${Date.now().toString(36)}.txt`;
const slowName = `sudal-e2e-slow-${Date.now().toString(36)}.txt`;

const srv = http.createServer((req, res) => {
  if (req.url === "/slow") return setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>slow</title>slow"); }, 2500);
  if (req.url === "/file") {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename="${fileName}"` });
    return res.end("hello");
  }
  if (req.url === "/agent") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><title>agent</title><body style="height:4000px">
      <input id="q"><div id="out"></div><img src="/missing.png">
      <script>
        console.error("boom-e2e");
        q.addEventListener("keydown", (e) => { if (e.key === "Enter") out.textContent = "entered:" + q.value; });
        setTimeout(() => { const d = document.createElement("div"); d.id = "late"; d.textContent = "늦게 뜸"; d.style.cssText = "width:120px;height:40px;background:#c33"; document.body.prepend(d); }, 1000);
      </script></body>`);
  }
  if (req.url === "/popup") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<title>popup</title><script>window.open("/other2")</script>`); }
  if (req.url === "/other2") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>other2</title>other2"); }
  if (req.url === "/fileslow") {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename="${slowName}"` });
    res.write("he");
    return setTimeout(() => res.end("llo"), 1500);
  }
  if (req.url === "/two") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(`<title>two</title><a href="/fileslow">하나</a> <a href="/fileslow">둘</a>`); }
  if (req.url === "/react") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // React 18 개발 빌드가 DOM 요소에 다는 fiber 를 흉내 낸다(Vite 처럼 /src/… URL 경로).
    return res.end(`<title>react</title><button id="b" style="margin:40px;padding:10px">자세히 보기</button>
      <script>b["__reactFiber$e2e"] = { type: "button", _debugSource: { fileName: "/src/pages/Dashboard.tsx", lineNumber: 42, columnNumber: 7 }, _debugOwner: { type: { name: "DetailButton" } } };</script>`);
  }
  if (req.url === "/outside") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(`<title>outside</title><button id="o" data-insp-path="/etc/hosts:1" style="margin:40px">밖</button>`); }
  if (req.url === "/missing.png") { res.writeHead(404); return res.end(); }
  if (req.url === "/other") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>other</title>other page"); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>home</title><a href="/other" target="_blank">새 탭 링크</a> <a href="/file">파일 받기</a>`);
});
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const base = `http://localhost:${port}`;
  const proc = spawn(app + "/Contents/MacOS/Sudal", ["--remote-debugging-port=9333", `--user-data-dir=${userData}`], { stdio: "ignore", env: { ...process.env, SUDAL_USERDATA: userData } });
  let b = null;
  for (let i = 0; i < 60 && !b; i++) { await sleep(500); try { b = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch {} }
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost:5")); if (!page) await sleep(250); }
  await page.waitForSelector("[data-sidebar]", { timeout: 20000 });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  const waitFor = async (fn, arg, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(fn, arg)) return true; await sleep(200); } return false; };
  const tabs = () => ev(() => [...document.querySelectorAll("[data-editor-tab]")].map((t) => t.getAttribute("data-editor-tab")));

  const ws = cli("ws", "add", "--path", repo);
  const tab = cli("tab", "new", "--ws", ws.workspaceId, "--title", "브라우저").tab.id;
  await sleep(800);
  cli("browser", "open", "--tab", tab, "--url", base + "/");
  await waitFor(() => [...document.querySelectorAll("[data-browser-pane]")].some((p) => p.getAttribute("data-browser-pane").endsWith("/") && p.offsetParent));
  await sleep(1500);

  // A
  const before = await tabs();
  const clicked = cli("browser", "click", "--tab", tab, "--text", "새 탭 링크");
  const opened = await waitFor((u) => [...document.querySelectorAll("[data-editor-tab]")].some((t) => t.getAttribute("data-editor-tab") === u), base + "/other");
  const after = await tabs();
  res("A (_blank → 새 탭)", opened && after.length === before.length + 1 && after.includes(base + "/"), JSON.stringify({ clicked: clicked.ok ?? clicked.error, before, after }));

  // B
  cli("browser", "open", "--tab", tab, "--url", base + "/slow");
  const sawBar = await waitFor(() => !!document.querySelector("[data-browser-progress]"), null, 2000);
  const barGone = await waitFor(() => !document.querySelector("[data-browser-progress]"), null, 6000);
  res("B (로딩 막대)", sawBar && barGone, JSON.stringify({ sawBar, barGone }));

  // C
  const deadPort = await freePort();
  const deadUrl = `http://localhost:${deadPort}/`;
  cli("browser", "open", "--tab", tab, "--url", deadUrl);
  const refused = await waitFor(() => document.querySelector("[data-browser-error]")?.getAttribute("data-browser-error") === "refused", null, 8000);
  const late = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<title>late</title>late"); });
  await new Promise((r) => late.listen(deadPort, "127.0.0.1", r));
  await ev(() => document.querySelector("[data-browser-retry]")?.click());
  const recovered = await waitFor(() => !document.querySelector("[data-browser-error]"), null, 6000);
  late.close();
  res("C (오류 화면 · 다시 시도)", refused && recovered, JSON.stringify({ refused, recovered }));

  // D
  // 숨은 탭에도 칩이 있으므로 보이는 것만 본다.
  const zoomChip = () => ev(() => [...document.querySelectorAll("[data-browser-zoom-chip]")].find((x) => x.offsetParent)?.textContent ?? null);
  cli("browser", "open", "--tab", tab, "--url", base + "/");
  await sleep(1500);
  await page.click("[data-browser-more] >> visible=true");
  await page.click("[data-browser-zoom] button:last-child >> visible=true");
  await page.keyboard.press("Escape");
  const zoomedLocal = await zoomChip();
  cli("browser", "open", "--tab", tab, "--url", `http://127.0.0.1:${port}/`);
  await sleep(1800);
  const otherHost = await zoomChip();
  cli("browser", "open", "--tab", tab, "--url", base + "/other");
  await sleep(1800);
  const backLocal = await zoomChip();
  res("D (호스트별 배율)", zoomedLocal === "120%" && otherHost === null && backLocal === "120%", JSON.stringify({ zoomedLocal, otherHost, backLocal }));
  await ev(() => [...document.querySelectorAll("[data-browser-zoom-chip]")].find((x) => x.offsetParent)?.click());

  // E
  cli("browser", "open", "--tab", tab, "--url", base + "/");
  await sleep(1500);
  cli("browser", "click", "--tab", tab, "--text", "파일 받기");
  const done = await waitFor(() => [...document.querySelectorAll("[data-browser-download]")].some((x) => x.offsetParent && x.getAttribute("data-browser-download") === "completed"), null, 8000);
  const dlText = await ev(() => document.querySelector("[data-browser-downloads]")?.textContent ?? "");
  const saved = path.join(os.homedir(), "Downloads", fileName);
  const exists = fs.existsSync(saved);
  try { fs.rmSync(saved); } catch {}
  res("E (다운로드 줄)", done && dlText.includes(fileName) && exists, JSON.stringify({ done, exists, dlText: dlText.slice(0, 80) }));

  // F
  await ev(() => document.querySelector("[data-editor-new-browser]")?.click());
  const freq = await waitFor((o) => [...document.querySelectorAll("[data-browser-frequent] button")].some((x) => x.textContent.includes(o)), `localhost:${port}`, 4000);
  res("F (자주 간 곳)", freq);

  // G
  cli("browser", "open", "--tab", tab, "--url", base + "/agent");
  await sleep(500);
  const w = cli("browser", "wait", "--tab", tab, "--selector", "#late", "--timeout", "8000");
  const con = cli("browser", "console", "--tab", tab, "--level", "error");
  const netr = cli("browser", "network", "--tab", tab);
  cli("browser", "fill", "--tab", tab, "--selector", "#q", "--value", "hi");
  const pr = cli("browser", "press", "--tab", tab, "--key", "Enter", "--selector", "#q");
  const w2 = cli("browser", "wait", "--tab", tab, "--text", "entered:hi", "--timeout", "5000");
  const sc = cli("browser", "scroll", "--tab", tab, "--to", "bottom");
  const shotPath = path.join(os.tmpdir(), `sudal-e2e-shot-${Date.now()}.png`);
  const shot = cli("browser", "screenshot", "--tab", tab, "--out", shotPath);
  const shotEl = cli("browser", "screenshot", "--tab", tab, "--selector", "#late");
  const isPng = (f) => { try { return fs.readFileSync(f).subarray(1, 4).toString() === "PNG"; } catch { return false; } };
  const g = {
    wait: !w.error, console: JSON.stringify(con).includes("boom-e2e"), network: JSON.stringify(netr).includes("missing.png"),
    press: !pr.error && !w2.error, scroll: !sc.error, shot: isPng(shot.path ?? shotPath), shotEl: isPng(shotEl.path ?? ""),
  };
  for (const f of [shot.path, shotEl.path]) { try { if (f) fs.rmSync(f); } catch {} }
  res("G (에이전트 명령)", Object.values(g).every(Boolean), JSON.stringify({ g, w: w.error, pr: pr.error, w2: w2.error, sc: sc.error ?? sc, shot: shot.error ?? shot.path, shotEl: shotEl.error ?? shotEl.path, con: JSON.stringify(con).slice(0, 160), netr: JSON.stringify(netr).slice(0, 160) }));

  // H
  cli("browser", "open", "--tab", tab, "--url", base + "/popup");
  const popupTab = await waitFor((u) => [...document.querySelectorAll("[data-editor-tab]")].some((t) => t.getAttribute("data-editor-tab") === u), base + "/other2", 8000);
  cli("browser", "open", "--tab", tab, "--url", base + "/two");
  await sleep(1500);
  const c1 = cli("browser", "click", "--tab", tab, "--text", "하나");
  const c2 = cli("browser", "click", "--tab", tab, "--text", "둘");
  const pane = await ev(() => [...document.querySelectorAll("[data-browser-pane]")].filter((p) => p.offsetParent).map((p) => p.getAttribute("data-browser-pane")));
  await sleep(3500);
  const dl = path.join(os.homedir(), "Downloads");
  const ext = path.extname(slowName), stem = slowName.slice(0, -ext.length);
  const both = [slowName, `${stem} (1)${ext}`].map((f) => path.join(dl, f));
  const twoFiles = both.every((f) => fs.existsSync(f) && fs.readFileSync(f, "utf8") === "hello");
  const seen = fs.readdirSync(dl).filter((f) => f.startsWith(stem));
  const rows = await ev(() => [...document.querySelectorAll("[data-browser-download]")].filter((x) => x.offsetParent).map((x) => x.textContent));
  if (!twoFiles) log("동시 다운로드:", JSON.stringify({ seen, rows, c1, c2, pane }));
  for (const f of seen) { try { fs.rmSync(path.join(dl, f)); } catch {} }
  for (const f of both) { try { fs.rmSync(f); } catch {} }
  const existing = path.join(os.tmpdir(), `sudal-e2e-keep-${Date.now()}.txt`);
  fs.writeFileSync(existing, "keep");
  const over = cli("browser", "screenshot", "--tab", tab, "--out", existing);
  const kept = fs.readFileSync(existing, "utf8") === "keep";
  fs.rmSync(existing);
  res("H (첫 페이지 window.open · 동시 다운로드 · --out 덮어쓰기 거절)", popupTab && twoFiles && kept && over.error?.code === "bad_request" && String(over.error?.message).includes(existing), JSON.stringify({ popupTab, twoFiles, kept, over: over.error ?? over }));

  // I
  cli("browser", "open", "--tab", tab, "--url", base + "/react");
  await sleep(1500);
  await page.click("[data-browser-pick] >> visible=true");
  await sleep(400);
  // 웹뷰 안은 호스트에서 마우스로 누를 수 없다 — 페이지 안에서 click 을 일으키면 선택 스크립트가 받는다.
  await ev(() => [...document.querySelectorAll("webview")].find((w) => w.offsetParent)?.executeJavaScript('document.getElementById("b").click()'));
  const toastOk = await waitFor(() => [...document.querySelectorAll("[data-browser-pick-msg]")].some((x) => x.offsetParent && x.textContent.includes("src/pages/Dashboard.tsx:42")), null, 6000);
  const toastText = await ev(() => [...document.querySelectorAll("[data-browser-pick-msg]")].find((x) => x.offsetParent)?.textContent ?? "");
  const composer = await ev(() => [...document.querySelectorAll("[data-composer] textarea")].find((x) => x.offsetParent)?.value ?? "");
  await ev(() => [...document.querySelectorAll("[data-browser-open-source]")].find((x) => x.offsetParent)?.click());
  const srcOpened = await waitFor((f) => [...document.querySelectorAll("[data-editor-tab]")].some((t) => (t.getAttribute("data-editor-tab") || "").endsWith(f)), "src/pages/Dashboard.tsx", 5000);
  res("I (요소 선택 소스 위치)", toastOk && /소스: src\/pages\/Dashboard\.tsx:42 \(<DetailButton>\)/.test(composer) && srcOpened, JSON.stringify({ toastOk, toastText: toastText.slice(0, 100), composer: composer.slice(0, 120), srcOpened }));

  // I-2: 페이지가 저장소 밖 경로를 주면 에디터에서 열 수 없어야 한다
  cli("browser", "open", "--tab", tab, "--url", base + "/outside");
  await sleep(1500);
  await page.click("[data-browser-pick] >> visible=true");
  await sleep(400);
  await ev(() => [...document.querySelectorAll("webview")].find((w) => w.offsetParent)?.executeJavaScript('document.getElementById("o").click()'));
  await waitFor(() => [...document.querySelectorAll("[data-browser-pick-msg]")].some((x) => x.offsetParent && x.textContent.includes("hosts")), null, 6000);
  const outsideBtn = await ev(() => [...document.querySelectorAll("[data-browser-open-source]")].some((x) => x.offsetParent));
  res("I-2 (저장소 밖 경로는 열기 버튼 없음)", !outsideBtn, JSON.stringify({ outsideBtn }));

  res("렌더러 오류 없음", errs.length === 0, errs.join(" | "));
  await b.close().catch(() => {});
  proc.kill();
  srv.close();
  log(`${results.filter((r) => r[1]).length}/${results.length} PASS`);
  process.exit(results.every((r) => r[1]) ? 0 : 1);
})().catch((e) => { console.error("ERR", e.stack || e.message); srv.close(); process.exit(1); });
