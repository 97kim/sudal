// 폴더 신뢰 검증. usage: node e2e/scenario-folder-trust.cjs (release/mac-arm64/Sudal.app 을 먼저 패키징)
// 저장소의 .claude/settings.json hooks 는 SDK 가 확인 없이 실행한다 — 신뢰한 폴더에서만 읽혀야 한다.
//  A) 신뢰한 저장소: 턴을 돌리면 SessionStart·UserPromptSubmit hook 이 돈다(기존 동작 유지)
//  B) 신뢰하지 않은 저장소: 탭을 열어도(예열·명령 목록 조회) hook 이 돌지 않는다
//  C) 신뢰하지 않은 저장소에 메시지를 보내면 신뢰 창에서 멈추고, 그동안 hook 이 돌지 않는다(창은 네이티브라 누르지 않는다)
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync, spawn } = require("child_process");
const E2E = __dirname;
const app = path.join(E2E, "..", "release/mac-arm64/Sudal.app");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sudal-e2e-trust-")));
const userData = path.join(tmp, "userdata");
const marks = path.join(tmp, "marks");
fs.mkdirSync(marks, { recursive: true });
const makeRepo = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const touch = (ev) => ({ hooks: [{ type: "command", command: `touch ${JSON.stringify(path.join(marks, `${name}-${ev}`))}` }] });
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [touch("start")], UserPromptSubmit: [touch("prompt")] } }));
  return dir;
};
const trusted = makeRepo("trusted");
const untrusted = makeRepo("untrusted");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "trusted-folders.json"), JSON.stringify([trusted]));
const marked = () => fs.readdirSync(marks).sort();

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
  const snap = (t) => page.evaluate((id) => window.sudal.chat.snapshot(id), t);

  // A
  const wsT = cli("ws", "add", "--path", trusted).workspaceId;
  const tabT = cli("tab", "new", "--ws", wsT, "--provider", "claude", "--title", "신뢰함", "--activate").tab.id;
  cli("tab", "send", "--tab", tabT, "--text", "'ok' 한 단어로만 답하세요.");
  let doneT = false;
  for (let i = 0; i < 90 && !doneT; i++) { await sleep(1000); doneT = (await snap(tabT)).status === "idle"; }
  res("A (신뢰한 저장소는 hook 이 돈다)", doneT && marked().includes("trusted-start") && marked().includes("trusted-prompt"), JSON.stringify({ doneT, marks: marked() }));

  // B
  const wsU = cli("ws", "add", "--path", untrusted).workspaceId;
  const tabU = cli("tab", "new", "--ws", wsU, "--provider", "claude", "--title", "신뢰 안 함", "--activate").tab.id;
  await sleep(10000);
  res("B (신뢰하지 않은 저장소는 탭을 열어도 hook 이 안 돈다)", !marked().some((m) => m.startsWith("untrusted")), JSON.stringify(marked()));

  // C
  cli("tab", "send", "--tab", tabU, "--text", "'ok' 한 단어로만 답하세요.");
  await sleep(8000);
  const s = await snap(tabU);
  // Claude 를 띄우지 않았으면 세션 id 가 생기지 않는다
  res("C (보내면 신뢰 창에서 멈추고 hook 이 안 돈다)", s.status === "running" && s.sessionId === null && !marked().some((m) => m.startsWith("untrusted")), JSON.stringify({ status: s.status, sessionId: s.sessionId, marks: marked() }));

  log(results.filter(([, ok]) => !ok).length === 0 ? "ALL PASS" : "FAILED: " + results.filter(([, ok]) => !ok).map(([n]) => n).join(", "));
  await b.close();
  proc.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; proc?.kill(); });
