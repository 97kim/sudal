// 백그라운드 작업 표시: 턴이 끝나 탭이 대기인데도 진행 줄([data-background-job])이 뜨고, 끝나면 사라지는지.
// 실제 Codex 를 돌리면 느리고 사용량을 쓰므로, 플러그인이 쓰는 것과 같은 형식의 state.json 을 직접 만들어 확인한다.
const os = require("os"), path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const CLAUDE_DIR = path.join(E2E, "claude-home");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const stateFile = path.join(CLAUDE_DIR, "codex-test", "state", "repo-1", "state.json");
const writeJobs = (jobs) => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, jobs }));
};

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ws = cli("ws", "add", "--path", E2E + "/repo");
  // 짧은 턴 하나로 세션 id 를 만든다 (작업 기록의 sessionId 와 이어야 하므로 실제 세션이 필요)
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "백그", "--activate", "--prompt", "'준비됨' 이라고만 답해.");
  let st;
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(500); st = cli("tab", "status", "--tab", "백그"); if (st.tab?.status === "idle" && st.tab?.sessionId) break; }
  const sessionId = st.tab?.sessionId;
  console.log("탭 상태:", st.tab?.status, "| sessionId:", sessionId);
  console.log("RESULT (턴이 끝나 대기 상태):", st.tab?.status === "idle" && sessionId ? "PASS" : "FAIL");

  const base = { id: "task-e2e", sessionId, kind: "task", kindLabel: "rescue", title: "Codex Task", summary: "브라우저 업그레이드를 검토해 줘", createdAt: new Date().toISOString() };
  writeJobs([{ ...base, status: "running" }]);
  let line = null;
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); line = await ev(() => { const e = document.querySelector("[data-background-job]"); return e ? e.innerText.replace(/\s+/g, " ").trim() : null; }); if (line) break; }
  console.log("진행 줄:", JSON.stringify(line));
  console.log("RESULT (대기 중에도 백그라운드 진행 줄이 뜬다):", line && /백그라운드/.test(line) && /rescue/.test(line) ? "PASS" : "FAIL");
  console.log("RESULT (경과 시간과 지시 요약 표시):", line && /경과/.test(line) && /브라우저 업그레이드/.test(line) ? "PASS" : "FAIL");
  await page.screenshot({ path: E2E + "/shot-bgjob.png" });

  // 다른 세션의 작업은 이 탭에 뜨면 안 된다
  writeJobs([{ ...base, status: "running" }, { ...base, id: "task-other", sessionId: "다른-세션", summary: "남의 작업" }]);
  await page.waitForTimeout(1500);
  const count = await ev(() => document.querySelectorAll("[data-background-job]").length);
  console.log("RESULT (다른 세션 작업은 안 보임):", count === 1 ? "PASS" : `FAIL (${count}개 보임)`);

  // 끝나면 사라진다
  writeJobs([{ ...base, status: "completed", completedAt: new Date().toISOString() }]);
  let gone = false;
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); gone = await ev(() => !document.querySelector("[data-background-job]")); if (gone) break; }
  console.log("RESULT (끝나면 진행 줄이 사라짐):", gone ? "PASS" : "FAIL");

  const s = await ev(() => window.workbench.workspaces.state());
  for (const w of s.model.workspaces) { for (const t of s.model.tabs.filter((t) => t.workspaceId === w.id)) await ev((id) => window.workbench.workspaces.deleteTab(id), t.id); await ev((id) => window.workbench.workspaces.remove(id), w.id); }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
