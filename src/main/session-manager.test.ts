import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  claudeProjectDirName,
  claudeProjectDirs,
  summarizeToolInput,
  type SessionSnapshot,
} from "./session-manager";
import { ZERO_USAGE, type ChatEvent } from "@shared/chat-events";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeManager(root: string) {
  const snapshots: SessionSnapshot[] = [];
  let spawned: { hookLog: string | null; args: unknown[] } | null = null;
  const manager = new SessionManager({
    emit: () => {},
    claudeRuntime: () => Promise.reject(new Error("unused")),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({
      provider: "claude",
      cwd: root,
      policy: "ask",
      sessionId: "11111111-2222-3333-4444-555555555555",
    }),
    terminalCli: {
      async spawn(...args) {
        spawned = { hookLog: args[5], args };
      },
      kill() {},
    },
    transcriptRoots: { claude: join(root, "claude"), codex: join(root, "codex") },
    hookLogDir: join(root, "hooks"),
    onSnapshot: (_tabId, snap) => snapshots.push(snap),
  });
  return { manager, snapshots, spawned: () => spawned };
}

test("터미널 모드 권한 대기: 훅 로그의 PermissionRequest 로 켜지고, 키 입력·툴 종료·CLI 종료로 꺼진다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const { manager, snapshots, spawned } = makeManager(root);
  const r = await manager.attachTerminal("tab1");
  assert.equal(r.ok, true);
  const hookLog = spawned()?.hookLog;
  assert.ok(hookLog && existsSync(hookLog), "훅 로그 파일이 미리 만들어진다");
  assert.equal(manager.snapshot("tab1").terminalAttention, null);

  const perm = (cmd: string) =>
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: cmd },
    }) + "\n";
  appendFileSync(hookLog!, perm("git push"));
  await wait(600);
  assert.deepEqual(
    manager.snapshot("tab1").terminalAttention && {
      tool: manager.snapshot("tab1").terminalAttention!.tool,
      summary: manager.snapshot("tab1").terminalAttention!.summary,
    },
    { tool: "Bash", summary: "git push" },
  );
  assert.ok(snapshots.some((s) => s.terminalAttention?.summary === "git push"));

  // 다른 pty 입력(글자·방향키 ESC 시퀀스)은 무시, Enter 는 답한 것으로 본다.
  manager.terminalInput("tab1", "a");
  manager.terminalInput("tab1", "\x1b[B");
  assert.ok(manager.snapshot("tab1").terminalAttention);
  manager.terminalInput("tab1", "\r");
  assert.equal(manager.snapshot("tab1").terminalAttention, null);

  appendFileSync(hookLog!, perm("rm -rf build"));
  await wait(600);
  assert.equal(manager.snapshot("tab1").terminalAttention?.summary, "rm -rf build");
  // 다른 툴의 종료는 무시, 같은 툴의 종료는 해제
  appendFileSync(hookLog!, JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }) + "\n");
  await wait(600);
  assert.ok(manager.snapshot("tab1").terminalAttention);
  appendFileSync(hookLog!, JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }) + "\n");
  await wait(600);
  assert.equal(manager.snapshot("tab1").terminalAttention, null);

  appendFileSync(hookLog!, perm("yarn test"));
  await wait(600);
  assert.ok(manager.snapshot("tab1").terminalAttention);
  manager.terminalExited("tab1");
  const after = manager.snapshot("tab1");
  assert.equal(after.controller, "app");
  assert.equal(after.terminalAttention, null);
  assert.equal(existsSync(hookLog!), false, "CLI 종료 후 훅 로그는 지운다");
  rmSync(root, { recursive: true, force: true });
});

test("터미널 모드: 훅이 다른 세션 id 를 알리면(TUI 안 /resume) 그 세션의 기록을 불러오고 미러가 그 파일을 따라간다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-switch-"));
  const { manager, spawned } = makeManager(root);
  const r = await manager.attachTerminal("tab1");
  assert.equal(r.ok, true);
  const hookLog = spawned()!.hookLog!;
  assert.equal(manager.snapshot("tab1").sessionId, "11111111-2222-3333-4444-555555555555");
  // 갈아탈 세션 "other" 의 기록: 한 턴(user + assistant end_turn)
  const dir = join(root, "claude", "-Users-x-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "other.jsonl");
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  writeFileSync(
    file,
    line({ type: "user", uuid: "u1", timestamp: "2026-09-09T00:00:00Z", message: { role: "user", content: "예전 질문" } }) +
      line({ type: "assistant", timestamp: "2026-09-09T00:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "예전 답" }], stop_reason: "end_turn", usage: {} } }),
  );
  // 훅: 프롬프트 제출 시 session_id 가 바뀌어 있다
  appendFileSync(hookLog, line({ hook_event_name: "UserPromptSubmit", session_id: "other", transcript_path: file, prompt: "새 질문" }));
  await wait(700);
  assert.equal(manager.snapshot("tab1").sessionId, "other");
  const types = manager.events("tab1").map((e) => e.type);
  assert.ok(types.includes("error"), "갈아탐 안내 한 줄");
  assert.ok(manager.events("tab1").some((e) => e.type === "user_message" && e.text === "예전 질문"), "그 세션의 이전 대화를 불러온다");
  assert.ok(manager.events("tab1").some((e) => e.type === "assistant_text" && e.text === "예전 답"));
  const before = manager.events("tab1").length;
  // 이어지는 대화는 미러가 그 파일에서 읽는다(중복 없이)
  appendFileSync(file, line({ type: "user", uuid: "u2", timestamp: "2026-09-09T00:00:02Z", message: { role: "user", content: "새 질문" } }));
  await wait(1200);
  const after = manager.events("tab1");
  assert.equal(after.filter((e) => e.type === "user_message" && e.text === "새 질문").length, 1);
  assert.equal(after.filter((e) => e.type === "user_message" && e.text === "예전 질문").length, 1, "이전 대화가 두 번 들어가지 않는다");
  assert.equal(after.length, before + 1);
  manager.release("tab1");
  rmSync(root, { recursive: true, force: true });
});

test("summarizeToolInput: Bash 는 설명 또는 명령 첫 줄, 파일 툴은 경로", () => {
  assert.equal(summarizeToolInput("Bash", { command: "ls\npwd" }), "ls");
  assert.equal(
    summarizeToolInput("Bash", { command: "ls", description: "목록" }),
    "목록",
  );
  assert.equal(summarizeToolInput("Edit", { file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(summarizeToolInput("WebFetch", { url: "https://x" }), "https://x");
  assert.equal(summarizeToolInput("Foo", {}), "");
});

test("프롬프트 큐 영속화: 세션 생성 시 복원, 편집·제거는 저장, 닫기/종료는 남기고 사용자 중단은 버린다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sessq-"));
  const saved = new Map<string, unknown[]>();
  const ev = { type: "user_message" as const, ts: 1, text: "다음 지시" };
  saved.set("tab1", [{ id: "q1", text: "다음 지시", images: [], userEvent: ev }, { id: "q2", text: "그 다음", images: [], userEvent: ev }]);
  const mk = () =>
    new SessionManager({
      emit: () => {},
      claudeRuntime: () => Promise.reject(new Error("unused")),
      codexRuntime: () => Promise.reject(new Error("unused")),
      resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
      store: {
        appendEvent() {},
        readEvents: () => [],
        resetThread() {},
        savePromptQueue: (tabId, items) => saved.set(tabId, items.map((i) => ({ ...i }))),
        loadPromptQueue: (tabId) => (saved.get(tabId) ?? []) as never,
      },
    });
  const m = mk();
  assert.deepEqual(
    m.snapshot("tab1").pendingPrompts.map((p) => p.id),
    ["q1", "q2"],
    "저장돼 있던 큐가 복원된다",
  );
  m.queueUpdate("tab1", "q2", "고친 지시");
  assert.equal((saved.get("tab1") as { text: string }[])[1].text, "고친 지시");
  m.queueRemove("tab1", "q1");
  assert.deepEqual((saved.get("tab1") as { id: string }[]).map((p) => p.id), ["q2"]);
  // 탭 닫기(release)·앱 종료(shutdown)는 큐를 남긴다
  m.release("tab1");
  assert.equal(saved.get("tab1")!.length, 1);
  const m2 = mk();
  assert.deepEqual(m2.snapshot("tab1").pendingPrompts.map((p) => p.id), ["q2"]);
  m2.shutdown();
  assert.equal(saved.get("tab1")!.length, 1);
  // 사용자의 중단은 버린다
  const m3 = mk();
  assert.equal(m3.snapshot("tab1").pendingPrompts.length, 1);
  m3.abort("tab1");
  assert.equal(saved.get("tab1")!.length, 0);
  assert.equal(m3.snapshot("tab1").pendingPrompts.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("Codex 터미널 모드 승인 힌트: pty 출력의 프롬프트로 켜지고, 키 입력·'Approved action'·CLI 종료로 꺼진다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-codexattn-"));
  const { manager, snapshots } = makeManager(root);
  manager.configure("cx", { provider: "codex" });
  const r = await manager.attachTerminal("cx");
  assert.equal(r.ok, true);
  manager.terminalOutput("cx", "\x1b[33mAllow Codex to ru");
  assert.equal(manager.snapshot("cx").terminalAttention, null, "잘린 문장으로는 아직");
  manager.terminalOutput("cx", "n `curl -sI https://example.com`\x1b[0m?");
  assert.deepEqual(
    manager.snapshot("cx").terminalAttention && { tool: manager.snapshot("cx").terminalAttention!.tool, summary: manager.snapshot("cx").terminalAttention!.summary },
    { tool: "명령 실행", summary: "curl -sI https://example.com" },
  );
  assert.ok(snapshots.some((s) => s.terminalAttention?.summary === "curl -sI https://example.com"));
  manager.terminalInput("cx", "\x1b[B"); // 방향키는 답이 아님
  assert.ok(manager.snapshot("cx").terminalAttention);
  manager.terminalInput("cx", "\r");
  assert.equal(manager.snapshot("cx").terminalAttention, null);
  manager.terminalOutput("cx", "Codex wants to edit src/a.ts");
  assert.equal(manager.snapshot("cx").terminalAttention?.tool, "파일 수정");
  manager.terminalOutput("cx", "Approved action: edit");
  assert.equal(manager.snapshot("cx").terminalAttention, null);
  manager.terminalOutput("cx", "Yes, grant these permissions for this turn");
  assert.equal(manager.snapshot("cx").terminalAttention?.tool, "권한 요청");
  manager.terminalExited("cx");
  assert.equal(manager.snapshot("cx").terminalAttention, null);
  // Claude 탭의 출력은 무시한다(훅이 담당)
  await manager.attachTerminal("cl");
  manager.terminalOutput("cl", "Allow Codex to run `ls`");
  assert.equal(manager.snapshot("cl").terminalAttention, null);
  manager.shutdown(); // 미러·훅 워처를 내려야 테스트 프로세스가 끝난다
  rmSync(root, { recursive: true, force: true });
});

test("프롬프트 큐: 실행 중 탭 닫기(release)는 큐를 보내지 않고 남기고, 오류로 멈춘 뒤 '지금 보내기' 는 보낸다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sessq2-"));
  const saved = new Map<string, unknown[]>();
  const recorded: string[] = [];
  const mk = (runtimeDelayMs: number) =>
    new SessionManager({
      emit: () => {},
      // 런타임 준비가 실패하는 것으로 턴을 끝낸다(지연을 주면 그 사이 큐에 넣고 닫을 수 있다)
      claudeRuntime: () => new Promise((_, rej) => setTimeout(() => rej(new Error("runtime unavailable")), runtimeDelayMs)),
      codexRuntime: () => Promise.reject(new Error("unused")),
      resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
      store: {
        appendEvent: (_t, e) => {
          if (e.type === "user_message") recorded.push(e.text);
        },
        readEvents: () => [],
        resetThread() {},
        savePromptQueue: (tabId, items) => saved.set(tabId, items.map((i) => ({ ...i }))),
        loadPromptQueue: (tabId) => (saved.get(tabId) ?? []) as never,
      },
    });
  const ev = (text: string) => ({ type: "user_message" as const, id: `u-${text}`, ts: 1, text }) as never;

  // 1) 실행 중 release → 큐는 디스크에 남고, 닫힌 탭에서 새 턴이 시작되지 않는다
  const m = mk(150);
  assert.equal((await m.send("t1", "첫 지시", [], ev("첫 지시"))).ok, true);
  const q = await m.send("t1", "대기 지시", [], ev("대기 지시"));
  assert.equal(q.ok && q.pending, true);
  assert.equal(saved.get("t1")!.length, 1);
  m.release("t1");
  await wait(400);
  assert.equal(saved.get("t1")!.length, 1, "닫기가 큐를 소비하면 안 된다");
  assert.deepEqual(recorded, ["첫 지시"], "대기 지시가 전송되면 안 된다");

  // 2) 오류로 끝난 뒤: 자동으로는 안 보내고, '지금 보내기' 로는 보낸다
  recorded.length = 0;
  saved.clear();
  const m2 = mk(0);
  assert.equal((await m2.send("t2", "A", [], ev("A"))).ok, true);
  assert.equal((await m2.send("t2", "B", [], ev("B"))).ok, true);
  await wait(200);
  assert.equal(m2.snapshot("t2").status, "error");
  assert.equal(m2.snapshot("t2").pendingPrompts.length, 1, "오류 뒤 자동 전송 안 함");
  m2.queueSendNext("t2");
  await wait(200);
  assert.deepEqual(recorded, ["A", "B"]);
  assert.equal(m2.snapshot("t2").pendingPrompts.length, 0);
  m.shutdown();
  m2.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("닫은 탭: 늦게 끝난 턴의 정리가 세션을 되살리거나 스냅샷을 보내지 않는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sessrel-"));
  const snaps: string[] = [];
  const m = new SessionManager({
    emit: () => {},
    // 런타임 준비가 늦게 실패한다 — 그 사이에 탭을 닫으면 턴은 release 뒤에 끝난다
    claudeRuntime: () => new Promise((_, rej) => setTimeout(() => rej(new Error("runtime unavailable")), 150)),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
    onSnapshot: (tabId) => snaps.push(tabId),
  });
  assert.equal((await m.send("t1", "지시", [], { type: "user_message", id: "u1", ts: 1, text: "지시" } as never)).ok, true);
  m.release("t1");
  snaps.length = 0;
  await wait(400);
  assert.deepEqual(snaps, [], "닫힌 탭에 스냅샷을 보내면 안 된다 (snapshot() 의 ensure 가 세션을 되살린다)");
  m.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("동시 실행 상한: 넘치면 queued + 순번/진행 중 수, 자리가 나거나 상한을 올리면 시작, 기다리는 탭에 스냅샷을 밀어 준다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-conc-"));
  const snapshots: SessionSnapshot[] = [];
  const m = new SessionManager({
    emit: () => {},
    // 런타임 준비를 300ms 끌어서 그동안 "running" 으로 둔다
    claudeRuntime: () => new Promise((_, rej) => setTimeout(() => rej(new Error("runtime unavailable")), 300)),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
    maxConcurrent: 1,
    onSnapshot: (_t, s) => snapshots.push(s),
  });
  const ev = (text: string) => ({ type: "user_message" as const, id: `u-${text}`, ts: 1, text }) as never;
  assert.deepEqual(await m.send("a", "A", [], ev("A")), { ok: true, queued: false });
  assert.deepEqual(await m.send("b", "B", [], ev("B")), { ok: true, queued: true });
  assert.deepEqual(await m.send("c", "C", [], ev("C")), { ok: true, queued: true });
  assert.equal(m.snapshot("a").queueInfo, null);
  assert.deepEqual(m.snapshot("b").queueInfo, { position: 1, running: 1, max: 1, waitingPermission: 0 });
  assert.deepEqual(m.snapshot("c").queueInfo, { position: 2, running: 1, max: 1, waitingPermission: 0 });
  // 상한을 올리면 b 가 바로 시작하고 c 는 1번째로 당겨진다(스냅샷 푸시)
  snapshots.length = 0;
  m.setMaxConcurrent(2);
  assert.equal(m.snapshot("b").status, "running");
  assert.deepEqual(m.snapshot("c").queueInfo, { position: 1, running: 2, max: 2, waitingPermission: 0 });
  assert.ok(snapshots.some((s) => s.tabId === "c" && s.queueInfo?.position === 1 && s.queueInfo.running === 2));
  // 내려도 진행 중인 둘은 그대로, c 는 계속 기다린다
  m.setMaxConcurrent(1);
  assert.equal(m.snapshot("a").status, "running");
  assert.equal(m.snapshot("b").status, "running");
  assert.equal(m.snapshot("c").status, "queued");
  // a·b 가 끝나면(오류) 자리가 나서 c 가 시작한다
  await wait(500);
  assert.equal(m.snapshot("c").queueInfo, null);
  assert.notEqual(m.snapshot("c").status, "queued");
  await wait(500);
  m.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("한도 재시도(실제 턴 경로): 한도 오류 → limitWait 예약, 재시도 3회 넘기면 멈춤, 대기 중 큐는 멈춰 있음", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-limit-"));
  const resetSec = Math.floor(Date.now() / 1000) + 120;
  let runtimeCalls = 0;
  const m = new SessionManager({
    emit: () => {},
    claudeRuntime: () => {
      runtimeCalls++;
      return Promise.reject(new Error(`Claude AI usage limit reached|${resetSec}`));
    },
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
  });
  const ev = (text: string) => ({ type: "user_message" as const, id: `u-${text}`, ts: 1, text }) as never;
  assert.equal((await m.send("t", "A", [], ev("A"))).ok, true);
  await wait(100);
  let snap = m.snapshot("t");
  assert.equal(runtimeCalls, 1);
  assert.ok(snap.limitWait, "한도 오류면 재시도가 예약된다");
  assert.equal(snap.limitWait!.attempts, 1);
  assert.equal(snap.limitWait!.until, resetSec * 1000, "리셋 시각은 오류 텍스트의 |epoch");
  // 대기 중 보낸 지시는 큐에 남고 자동으로 나가지 않는다
  const q = await m.send("t", "B", [], ev("B"));
  assert.equal(q.ok && q.pending, true);
  assert.equal(m.snapshot("t").pendingPrompts.length, 1);
  // "지금 재시도" 를 반복 → 같은 한도에 계속 걸리면 3회 뒤 멈춘다
  m.limitRetryNow("t");
  await wait(100);
  assert.equal(runtimeCalls, 2);
  assert.equal(m.snapshot("t").limitWait?.attempts, 2);
  m.limitRetryNow("t");
  await wait(100);
  m.limitRetryNow("t");
  await wait(100);
  snap = m.snapshot("t");
  assert.equal(runtimeCalls, 4);
  assert.equal(snap.limitWait?.attempts, 4);
  assert.equal(snap.limitWait?.until, null, "상한을 넘기면 예약 없이 멈춘다");
  assert.equal(snap.pendingPrompts.length, 1, "큐는 그대로");
  // 취소하면 예약이 지워진다
  m.limitCancel("t");
  assert.equal(m.snapshot("t").limitWait, null);
  m.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("inheritCwd: 워크스페이스 기본 경로가 바뀌면 물려받는 탭의 세션 cwd 를 맞추고 세션 id 를 비운다(탭에 경로는 박지 않음)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const metas: unknown[] = [];
  const snapshots: SessionSnapshot[] = [];
  const manager = new SessionManager({
    emit: () => {},
    claudeRuntime: () => Promise.reject(new Error("unused")),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: join(root, "old"), policy: "ask", sessionId: "s-old" }),
    transcriptRoots: { claude: join(root, "claude"), codex: join(root, "codex") },
    hookLogDir: join(root, "hooks"),
    onMeta: (_tabId, meta) => metas.push(meta),
    onSnapshot: (_tabId, snap) => snapshots.push(snap),
  });
  // 아직 세션이 없는 탭은 손대지 않는다 (다음 ensure 가 새 경로로 만든다)
  manager.inheritCwd("t0", join(root, "new"));
  assert.deepEqual(metas, []);

  assert.equal(manager.snapshot("t1").cwd, join(root, "old"));
  assert.equal(manager.snapshot("t1").sessionId, "s-old");
  manager.inheritCwd("t1", join(root, "new"));
  assert.equal(manager.snapshot("t1").cwd, join(root, "new"));
  assert.equal(manager.snapshot("t1").sessionId, null);
  assert.deepEqual(metas, [{ sessionId: null }]);
  assert.equal(snapshots.at(-1)?.cwd, join(root, "new"));

  // 같은 경로면 아무 일도 없다
  const n = metas.length;
  manager.inheritCwd("t1", join(root, "new"));
  assert.equal(metas.length, n);
  rmSync(root, { recursive: true, force: true });
});

test("우리가 시작하지 않은 턴도 중단된다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const { manager } = makeManager(root);
  const inner = manager as unknown as { ambientEvent(tabId: string, e: ChatEvent): void };
  const text = (t: string): ChatEvent => ({ type: "assistant_text", ts: Date.now(), blockId: t, text: t });
  manager.snapshot("tab1");

  // 백그라운드가 끝나 CLI 가 스스로 이어간 턴. 화면은 "도는 중" 이 된다.
  inner.ambientEvent("tab1", text("스스로 이어간다"));
  assert.equal(manager.snapshot("tab1").status, "running");

  // 이 턴에는 끊을 abort 가 없다 — 예전엔 그래서 중단이 아무 일도 하지 않았다.
  assert.equal(manager.abort("tab1"), true);
  assert.equal(manager.snapshot("tab1").status, "idle");

  // 끊기 직전에 출발한 이벤트가 상태를 다시 올리지 않는다
  inner.ambientEvent("tab1", text("늦게 도착"));
  assert.equal(manager.snapshot("tab1").status, "idle");

  // 턴이 끝났다는 신호가 오면 빗장이 풀려 다음 턴은 정상으로 보인다
  inner.ambientEvent("tab1", { type: "turn_result", ts: Date.now(), usage: ZERO_USAGE, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: false });
  inner.ambientEvent("tab1", text("다음 턴"));
  assert.equal(manager.snapshot("tab1").status, "running");
  rmSync(root, { recursive: true, force: true });
});

test("이어받은 턴은 백그라운드 결과일 때만 그렇게 표시한다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const { manager } = makeManager(root);
  const inner = manager as unknown as { ambientEvent(tabId: string, e: ChatEvent): void; ensure(tabId: string): { bgTaskFinished: boolean } };
  const text = (t: string): ChatEvent => ({ type: "assistant_text", ts: Date.now(), blockId: t, text: t });
  const done = (): ChatEvent => ({ type: "turn_result", ts: Date.now(), usage: ZERO_USAGE, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: false });
  manager.snapshot("tab1");

  // 왜 이어받았는지 모르는 턴. 짐작해서 "백그라운드 결과" 라고 적지 않는다.
  inner.ambientEvent("tab1", text("이유를 모르는 턴"));
  assert.equal(manager.snapshot("tab1").status, "running");
  assert.equal(manager.snapshot("tab1").ambientFromBg, false);
  inner.ambientEvent("tab1", done());

  // 백그라운드가 끝났다는 알림을 받은 뒤의 턴이면 그 결과를 처리하는 중이다.
  inner.ensure("tab1").bgTaskFinished = true;
  inner.ambientEvent("tab1", text("결과를 들고 이어간다"));
  assert.equal(manager.snapshot("tab1").ambientFromBg, true);

  // 턴이 끝나면 표시도 내린다 — 다음 턴까지 물려주지 않는다.
  inner.ambientEvent("tab1", done());
  assert.equal(manager.snapshot("tab1").ambientFromBg, false);
  inner.ambientEvent("tab1", text("그 다음 턴"));
  assert.equal(manager.snapshot("tab1").ambientFromBg, false);
  rmSync(root, { recursive: true, force: true });
});

test("사용자가 끊은 턴은 오류로 끝난 것처럼 와도 오류가 아니다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const { manager } = makeManager(root);
  const inner = manager as unknown as { ambientEvent(tabId: string, e: ChatEvent): void };
  manager.snapshot("tab1");
  inner.ambientEvent("tab1", { type: "assistant_text", ts: Date.now(), blockId: "b", text: "스스로 이어간다" });
  assert.equal(manager.abort("tab1"), true);
  // interrupt 로 끝난 턴은 isError 로 온다 — 시킨 대로 된 것이지 사고가 아니다
  inner.ambientEvent("tab1", { type: "turn_result", ts: Date.now(), usage: ZERO_USAGE, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: true });
  assert.equal(manager.snapshot("tab1").status, "idle");
  rmSync(root, { recursive: true, force: true });
});

/** Codex rollout 한 줄(개행 없이) — 테스트에서 "쓰다 만 줄" 을 만들려고 개행은 호출자가 붙인다. */
function codexUserLine(id: string, text: string): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "item_completed", item: { id, type: "UserMessage", content: text } },
  });
}

function codexRollout(root: string, sessionId: string): string {
  const day = join(root, "codex", "2026", "09", "20");
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-09-20T01-00-00-${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: root } }) + "\n");
  return file;
}

test("터미널 resume(Codex): 다른 세션을 붙이면 미러가 읽다 만 자리부터 잇는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-codex-off-"));
  const { manager } = makeManager(root);
  const file = codexRollout(root, "codex-one");
  // 마지막 줄에 개행이 없다 = CLI 가 쓰는 도중. 불러오기는 개행까지만 읽고, 나머지는 미러가 마저 읽어야 한다.
  appendFileSync(file, codexUserLine("i1", "먼저 한 말") + "\n" + codexUserLine("i2", "쓰다 만 줄"));
  manager.ensure("tab1", { provider: "codex", cwd: root, sessionId: "codex-old" });
  manager.externalCliStarted("tab1", "codex", root, 1234, "codex-one");

  const texts = () => manager.events("tab1").flatMap((e) => (e.type === "user_message" ? [e.text] : []));
  assert.deepEqual(texts(), ["먼저 한 말"], "개행까지의 줄만 불러온다");

  appendFileSync(file, "\n" + codexUserLine("i3", "그 뒤에 온 말") + "\n");
  await wait(1200);
  assert.deepEqual(texts(), ["먼저 한 말", "쓰다 만 줄", "그 뒤에 온 말"], "쓰다 만 줄을 건너뛰지 않는다");

  manager.release("tab1");
  rmSync(root, { recursive: true, force: true });
});

test("터미널 resume(Codex): 같은 세션을 그대로 이어받아도 미러가 돈다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-codex-same-"));
  const { manager } = makeManager(root);
  const file = codexRollout(root, "codex-one");
  appendFileSync(file, codexUserLine("i1", "앱에서 한 말") + "\n");
  manager.ensure("tab1", { provider: "codex", cwd: root, sessionId: "codex-one" });
  manager.externalCliStarted("tab1", "codex", root, 1234, "codex-one");

  const texts = () => manager.events("tab1").flatMap((e) => (e.type === "user_message" ? [e.text] : []));
  // 같은 세션이니 화면에 이미 있는 대화를 다시 불러오지 않는다 — 갈아탐 안내도 없다.
  assert.deepEqual(texts(), []);
  assert.ok(!manager.events("tab1").some((e) => e.type === "error"), "갈아탔다는 안내를 붙이지 않는다");

  appendFileSync(file, codexUserLine("i2", "터미널에서 한 말") + "\n");
  await wait(1200);
  assert.deepEqual(texts(), ["터미널에서 한 말"], "이어지는 줄은 미러가 채팅에 옮긴다");

  manager.release("tab1");
  rmSync(root, { recursive: true, force: true });
});

// 같은 세션을 그대로 이어받는 길은 provider 를 가리지 않는다 — Codex 만 고치고 끝낼 수 없어 Claude 로도 한 번 본다.
test("터미널 resume(Claude): 같은 세션을 그대로 이어받아도 미러가 돈다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-claude-same-"));
  const { manager } = makeManager(root);
  const dir = join(root, "claude", "-Users-x-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude-one.jsonl");
  const line = (uuid: string, text: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-09-20T00:00:00Z", message: { role: "user", content: text } }) + "\n";
  writeFileSync(file, line("u1", "앱에서 한 말"));
  manager.ensure("tab1", { provider: "claude", cwd: root, sessionId: "claude-one" });
  manager.externalCliStarted("tab1", "claude", root, 1234, "claude-one");

  const texts = () => manager.events("tab1").flatMap((e) => (e.type === "user_message" ? [e.text] : []));
  assert.deepEqual(texts(), []);
  assert.ok(!manager.events("tab1").some((e) => e.type === "error"), "갈아탔다는 안내를 붙이지 않는다");

  appendFileSync(file, line("u2", "터미널에서 한 말"));
  await wait(1200);
  assert.deepEqual(texts(), ["터미널에서 한 말"], "이어지는 줄은 미러가 채팅에 옮긴다");

  manager.release("tab1");
  rmSync(root, { recursive: true, force: true });
});

test("configure: provider 가 바뀌면 이전 provider 의 모델은 버리고, 같은 patch 의 model 은 그대로 쓴다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-model-"));
  const { manager } = makeManager(root);
  manager.configure("m1", { model: "claude-fable-5-1" });
  assert.equal(manager.snapshot("m1").model, "claude-fable-5-1");
  manager.configure("m1", { provider: "codex" });
  assert.equal(manager.snapshot("m1").model, undefined, "Claude 모델이 Codex 탭에 남으면 Codex 가 400 으로 거절한다");
  manager.configure("m1", { provider: "claude", model: "claude-opus-5-5" });
  assert.equal(manager.snapshot("m1").model, "claude-opus-5-5", "함께 준 model 은 살아남는다");
  manager.configure("m1", { policy: "auto_edit" });
  assert.equal(manager.snapshot("m1").model, "claude-opus-5-5", "provider 가 그대로면 모델도 그대로");
  rmSync(root, { recursive: true, force: true });
});

test("분기: 지금 세션의 정상 턴에서만, 그 턴까지의 기록(작업 카드 제외)을 새 탭으로 옮기고 새 세션 id 를 쓴다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-fork-"));
  const { manager } = makeManager(root);
  const SID = "11111111-2222-3333-4444-555555555555";
  const turn = (ts: number, pointId: string, sessionId = SID): ChatEvent => ({
    type: "turn_result", ts, usage: ZERO_USAGE, costUsd: 0, durationMs: 1, numTurns: 1, modelUsage: {}, isError: false,
    forkPoint: { provider: "claude", sessionId, pointId },
  });
  manager.note("t1", { type: "user_message", ts: 1, id: "m1", text: "첫 지시" });
  manager.note("t1", turn(2, "old", "99999999-0000-0000-0000-000000000000")); // provider 전환 전 세션
  manager.note("t1", { type: "user_message", ts: 3, id: "m2", text: "둘째 지시" });
  manager.note("t1", { type: "review", ts: 4, reviewer: "codex", reviewTabId: "r", status: "done", text: "리뷰" });
  manager.note("t1", turn(5, "p2"));
  manager.note("t1", { type: "user_message", ts: 6, id: "m3", text: "셋째 지시" });
  manager.note("t1", turn(7, "p3"));

  assert.equal(manager.forkSource("t1", "nope").ok, false);
  assert.equal(manager.forkSource("t1", "old").ok, false, "지금 세션이 아닌 턴");
  const src = manager.forkSource("t1", "p2");
  assert.ok(src.ok);
  if (!src.ok) return;
  assert.deepEqual(src.prefix.map((e) => e.type), ["user_message", "turn_result", "user_message", "turn_result"], "리뷰 카드는 옮기지 않고, 셋째 지시는 빠진다");

  const NEW = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const snap = manager.adoptFork("t2", { provider: "claude", cwd: root, policy: "ask", sessionId: NEW }, src.prefix);
  assert.equal(snap.sessionId, NEW);
  assert.equal(snap.status, "idle");
  const events = manager.events("t2");
  assert.equal(events.filter((e) => e.type === "user_message").length, 2);
  assert.equal(events.at(-1)?.type, "notice");
  // 옮겨 온 턴은 옛 세션 것이라 새 탭에서 다시 분기할 수 없다
  assert.equal(manager.forkSource("t2", "p2").ok, false);
});

test("지금 반영: 응답을 기다리는 동안 그 항목은 고치거나 지울 수 없고, 보낸 문장이 기록된다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-steer-"));
  let release!: () => void;
  const sent: string[] = [];
  const manager = new SessionManager({
    emit: () => {},
    claudeRuntime: () => Promise.reject(new Error("unused")),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "codex", cwd: root, policy: "ask", sessionId: "th-1" }),
    steerCodex: async (_key, text) => {
      sent.push(text);
      await new Promise<void>((r) => (release = r));
    },
  });
  const s = manager.ensure("t1");
  s.status = "running";
  s.promptQueue.push({ id: "q1", text: "A", images: [], userEvent: { type: "user_message", ts: 1, id: "u1", text: "A" } });
  const pending = manager.queueSteer("t1", "q1");
  await wait(10);
  manager.queueUpdate("t1", "q1", "B");
  manager.queueRemove("t1", "q1");
  assert.equal(s.promptQueue[0]?.text, "A", "반영 중에는 고치지도 지우지도 않는다");
  release();
  const r = await pending;
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ["A"]);
  assert.equal(s.promptQueue.length, 0);
  const last = manager.events("t1").filter((e) => e.type === "user_message").at(-1);
  assert.equal(last?.type === "user_message" ? last.text : null, "A");
});

test("claudeProjectDirName: Claude Code 규칙 — 영숫자 외는 모두 -, 200자 넘으면 해시를 붙인다", () => {
  assert.equal(claudeProjectDirName("/Users/a/ax/sudal"), "-Users-a-ax-sudal");
  assert.equal(claudeProjectDirName("/Users/a/my app_v1.2"), "-Users-a-my-app-v1-2");
  assert.equal(claudeProjectDirName("C:\\Users\\a\\proj"), "C--Users-a-proj");
  assert.equal(claudeProjectDirName("/Users/a/수달"), "-Users-a---");
  const long = `/${"a".repeat(250)}`;
  const name = claudeProjectDirName(long);
  assert.ok(name.startsWith(`-${"a".repeat(199)}-`));
  assert.ok(name.length > 201);
  assert.equal(name, claudeProjectDirName(long), "같은 경로는 같은 이름");
});

test("claudeProjectDirs: macOS 는 예전 규칙을 먼저 두고 다를 때만 실제 규칙을 더한다, Windows 는 실제 규칙만", () => {
  const same = (p: string) => p;
  assert.deepEqual(claudeProjectDirs("/h/.claude/projects", "/Users/a/ax/sudal", "darwin", same), ["/h/.claude/projects/-Users-a-ax-sudal"]);
  assert.deepEqual(claudeProjectDirs("/h/.claude/projects", "/Users/a/my app", "darwin", same), [
    "/h/.claude/projects/-Users-a-my app",
    "/h/.claude/projects/-Users-a-my-app",
  ]);
  assert.deepEqual(claudeProjectDirs("/h/.claude/projects", "/tmp/x", "darwin", () => "/private/tmp/x"), [
    "/h/.claude/projects/-tmp-x",
    "/h/.claude/projects/-private-tmp-x",
  ]);
  assert.deepEqual(claudeProjectDirs("C:\\Users\\a\\.claude\\projects", "C:\\Users\\a\\proj", "win32", same), ["C:\\Users\\a\\.claude\\projects\\C--Users-a-proj"]);
});
