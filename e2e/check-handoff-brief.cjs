// 크로스 provider 전환. Claude 와 Codex 는 세션을 이어받을 수 없어 텍스트로 넘길 수밖에 없는데,
// 그 텍스트를 우리가 기록을 잘라 만드느냐, 떠나는 쪽이 직접 쓰느냐가 갈린다. 확인할 것 —
// (1) askSummary 를 켜면 모델이 쓴 인계서가 넘어가는가 (우리가 만든 기계 요약이 아니라)
// (2) 그 인계서가 디스크에 남아 앱을 껐다 켜도 살아남는가
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "인계", "--activate");
  await page.waitForTimeout(2500);

  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab") ?? null);
  if (!tabId) { console.log("RESULT: FAIL (탭을 못 찾음)"); process.exit(1); }
  const snap = () => ev((id) => window.sudal.chat.snapshot(id), tabId);
  // 정책은 ask 그대로 둔다 — full 로 열면 인계서 턴의 권한 게이트가 통째로 우회돼 검증이 무의미해진다.
  // 대신 준비 턴에서만 사용자처럼 승인해 준다.
  const settle = async (label, { approve = false } = {}) => {
    for (let i = 0; i < 240; i++) {
      const s = await snap();
      if (approve && s.status === "waiting_permission") {
        // 아직 답 안 한 권한 요청을 기록에서 찾는다.
        const ids = await ev(async (id) => {
          const evs = await window.sudal.chat.events(id);
          const done = new Set(evs.filter((e) => e.type === "permission_resolved").map((e) => e.requestId));
          return evs.filter((e) => e.type === "permission_request" && !done.has(e.requestId)).map((e) => e.requestId);
        }, tabId);
        for (const rid of ids) await ev(([id, r]) => window.sudal.chat.answerPermission(id, r, { behavior: "allow" }), [tabId, rid]);
      }
      if (s.sessionId && s.status !== "running" && s.status !== "queued" && s.status !== "waiting_permission") return s;
      await page.waitForTimeout(1000);
    }
    throw new Error(`${label}: 턴이 안 끝남`);
  };

  // 이미 쌓여 있는 CLAUDE.md — 인계서 턴이 이걸 날리면 안 된다.
  const noteFile = path.join(E2E, "repo", "CLAUDE.md");
  const SENTINEL = "# 기존 메모\n\n이 줄은 사용자가 쌓아 둔 것이다. 절대 사라지면 안 된다.\n";
  fs.writeFileSync(noteFile, SENTINEL, "utf8");

  // 넘길 맥락을 만든다 — 이 저장소에 오래 남을 규칙을 하나 정해 준다.
  cli("tab", "send", "--tab", "인계", "--text", "이 저장소의 규칙: 모든 텍스트 파일은 반드시 마지막 줄에 개행을 넣는다. 앞으로 계속 지킬 규칙이다. 그 규칙대로 a.txt 에 '사과' 라고 써라.");
  await settle("첫 턴", { approve: true });
  console.log("첫 턴 끝");

  // 본론: Codex 로 넘기면서 떠나는 Claude 에게 인계서를 쓰게 한다.
  const t0 = Date.now();
  const cfg = await ev((id) => window.sudal.chat.switchProvider(id, { provider: "codex", preserveContext: true, askSummary: true }), tabId);
  console.log(`전환 완료 (${Math.round((Date.now() - t0) / 1000)}s) provider=${cfg.provider} handoffPending=${cfg.handoffPending}`);

  // 인계서는 다음 메시지에 실릴 때까지 디스크에 있다.
  const file = path.join(E2E, "userdata", "threads", `${tabId}.handoff.txt`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  console.log("인계서 길이:", text.length);
  console.log("인계서 앞부분:", JSON.stringify(text.slice(0, 200)));

  // 우리가 만든 기계 요약은 이 머리말로 시작한다 — 그게 아니어야 모델이 쓴 것이다.
  const mechanical = /^## (이전 세션 요약|Previous session summary)/.test(text);
  console.log("RESULT (Codex 로 전환됨):", cfg.provider === "codex" ? "PASS" : "FAIL");
  console.log("RESULT (넘길 인계서가 대기 중):", cfg.handoffPending === true ? "PASS" : "FAIL");
  console.log("RESULT (디스크에 남았다 — 껐다 켜도 산다):", text.length > 50 ? "PASS" : "FAIL");
  console.log("RESULT (모델이 쓴 인계서다):", !mechanical && text.length > 50 ? "PASS" : "FAIL");
  console.log("RESULT (원래 요청이 담겼다):", /사과|a\.txt/.test(text) ? "PASS" : "FAIL");

  // 오래 남을 것은 대화가 아니라 저장소에 — 다만 쌓여 있던 내용은 건드리면 안 된다.
  const note = fs.existsSync(noteFile) ? fs.readFileSync(noteFile, "utf8") : "";
  const appended = note.length > SENTINEL.length;
  console.log("CLAUDE.md 길이:", SENTINEL.length, "→", note.length);
  if (appended) console.log("덧붙은 내용:", JSON.stringify(note.slice(SENTINEL.length).trim().slice(0, 200)));
  console.log("RESULT (쌓아 둔 내용이 그대로다):", note.startsWith(SENTINEL.trimEnd()) ? "PASS" : "FAIL");
  console.log("RESULT (오래 남을 규칙이 노트에 적혔다):", appended && /개행|newline|줄바꿈/.test(note) ? "PASS" : "FAIL(모델 판단에 달림)");

  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
