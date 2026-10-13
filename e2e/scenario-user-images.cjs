// 사용자 말풍선의 첨부 이미지가 말풍선 밖으로 넘치지 않는지. usage: node e2e/scenario-user-images.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
// 작은 이미지(16x16)·중간 이미지(600x200)·가로로 긴 캡처(2600x594) 두 장을(첨부는 최대 4장) 붙여 보내면 줄을 넘기고, 각 이미지는 말풍선 폭 안에 들어가며, 채팅 목록에 가로 스크롤이 생기지 않고, 작은 이미지는 늘어나지 않아야 한다.
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-img-")));
const userData = path.join(tmp, "userdata");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "trusted-folders.json"), JSON.stringify([repo]));
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: userData }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const results = [];
const res = (n, ok, x = "") => { results.push([n, ok]); log(`RESULT ${n}:`, ok ? "PASS" : "FAIL", x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc = null;
(async () => {
  proc = spawn(app + "/Contents/MacOS/Sudal", ["--remote-debugging-port=9333", `--user-data-dir=${userData}`], { stdio: "ignore", env: { ...process.env, SUDAL_E2E_MOCK_KEYCHAIN: "1", SUDAL_USERDATA: userData } });
  let b = null;
  for (let i = 0; i < 60 && !b; i++) { await sleep(500); try { b = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch {} }
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost")); if (!page) await sleep(250); }
  await page.waitForSelector("[data-sidebar]", { timeout: 20000 });
  const ws = cli("ws", "add", "--path", repo).workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "이미지", "--activate").tab.id;
  await sleep(1000);

  // 가로로 긴 PNG 세 장을 페이지에서 만들어 함께 보낸다
  const sent = await page.evaluate(async (t) => {
    const shot = (hue, w = 2600, h = 594) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = `hsl(${hue} 60% 70%)`;
      g.fillRect(0, 0, c.width, c.height);
      return { name: `wide-${hue}.png`, mime: "image/png", base64: c.toDataURL("image/png").split(",")[1] };
    };
    return await window.sudal.chat.send(t, { text: "'ok' 한 단어로만 답하세요.", images: [shot(0, 16, 16), shot(60, 600, 200), shot(20), shot(140)] });
  }, tab);
  if (!sent?.ok) log("전송 결과", JSON.stringify(sent).slice(0, 300));
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await page.evaluate(() => document.querySelectorAll("img[src^='data:image/png']").length >= 4)) break;
  }
  await sleep(800);

  const m = await page.evaluate(() => {
    // 작은 이미지는 중간 크기 이미지와 같은 줄에 놓인다 — 그래야 늘어나는지가 드러난다
    const all = [...document.querySelectorAll("img[src^='data:image/png']")].slice(-4);
    const imgs = all.slice(2);
    const small = all[0]?.getBoundingClientRect();
    const sameRow = !!small && Math.abs(small.top - all[1].getBoundingClientRect().top) < 2;
    const row = imgs[0]?.parentElement;
    const r = row?.getBoundingClientRect();
    const boxes = imgs.map((i) => i.getBoundingClientRect());
    // 가로로 넘치는 스크롤 상자가 있는지(채팅 목록 쪽)
    const overflowing = [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && el.contains(row);
    }).length;
    return {
      count: imgs.length,
      inside: boxes.every((x) => r && x.left >= r.left - 1 && x.right <= r.right + 1),
      heights: boxes.map((x) => Math.round(x.height)),
      rows: new Set(boxes.map((x) => Math.round(x.top))).size,
      overflowing,
      // 작은 이미지(16x16, 테두리 1px씩)는 원래 크기 그대로 — 큰 이미지 높이로 늘어나지 않는다
      small: small ? [Math.round(small.width), Math.round(small.height)] : null,
      sameRow,
    };
  });
  res("A (가로로 긴 이미지 두 장이 말풍선 안에, 높이 80px 이하)", m.count === 2 && m.inside && m.heights.every((h) => h <= 81), JSON.stringify(m));
  res("B (넘치면 줄을 넘기고 가로 스크롤이 없다)", m.rows >= 2 && m.overflowing === 0, JSON.stringify({ rows: m.rows, overflowing: m.overflowing }));
  res("C (같은 줄의 작은 이미지는 늘어나지 않는다)", m.sameRow && !!m.small && m.small[0] === 18 && m.small[1] === 18, JSON.stringify({ small: m.small, sameRow: m.sameRow }));

  await page.evaluate(() => [...document.querySelectorAll("img[src^='data:image/png']")].at(-1)?.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: path.join(E2E, "shot-user-images.png") }).catch((e) => log("캡처 실패", e.message));
  log(results.filter(([, ok]) => !ok).length === 0 ? "ALL PASS" : "FAILED: " + results.filter(([, ok]) => !ok).map(([n]) => n).join(", "));
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
  await b.close();
  proc.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; proc?.kill(); });
