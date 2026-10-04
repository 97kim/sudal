// 코덱스 턴 도중 권한을 "전부 자동"으로 바꾸면 떠 있는 승인 창이 풀리고 턴이 끝까지 가는지.
// app-server 는 턴 중에 정책을 못 바꾸므로 앱이 승인 요청에 대신 답한다.
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");
let fails = 0;
const result = (n, ok, note) => { if (!ok) fails += 1; console.log(`RESULT (${n}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, a) => page.evaluate(fn, a);
  const repo = E2E + "/repo";
  const target = path.join(repo, "codex-policy-live.txt");
  fs.rmSync(target, { force: true });
  const ws = cli("ws", "add", "--path", repo);
  const made = cli("tab", "new", "--ws", ws.workspaceId, "--cwd", repo, "--provider", "codex", "--policy", "ask", "--title", "코덱스 권한 즉시",
    "--prompt", "셸 명령으로 현재 폴더에 codex-policy-live.txt 파일을 만들고 안에 ok 라고 써. 다른 일은 하지 마.");
  const tabId = made.tab.id;

  // 승인 대기에 걸릴 때까지
  let waiting = false;
  for (let i = 0; i < 90 && !waiting; i++) {
    await page.waitForTimeout(2000);
    waiting = cli("tab", "status", "--tab", tabId).tab.status === "waiting_permission";
  }
  result("묻기 권한에서 승인 대기에 걸린다", waiting);

  // 턴 도중 "전부 자동"으로
  await ev(([id]) => window.workbench.chat.configure(id, { policy: "full" }), [tabId]);
  const w = cli("tab", "wait", "--tab", tabId, "--timeout-ms", "240000");
  result("권한을 바꾸면 승인 창이 풀리고 턴이 끝난다", w.wait.satisfied && w.tab.status !== "waiting_permission", JSON.stringify({ s: w.wait.satisfied, st: w.tab.status }));
  const read = cli("tab", "read", "--tab", tabId, "--last", "40");
  const asks = read.blocks.filter((x) => x.kind === "tool" && x.permission === "pending").length;
  result("남은 승인 대기 카드가 없다", asks === 0, `(${asks})`);
  // 파일은 샌드박스(읽기 전용, 다음 턴부터 풀림) 때문에 못 만들 수 있다 — 결과를 기록만 한다.
  console.log("NOTE 파일 생성:", fs.existsSync(target) ? "됨" : "안 됨(샌드박스는 다음 턴부터 풀린다)");

  const s = await ev(() => window.workbench.workspaces.state());
  for (const x of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === x.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), x.id); }
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
