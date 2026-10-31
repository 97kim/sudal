import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ChatEvent } from "@shared/chat-events";
import { SessionManager } from "./session-manager";
import { AcpAdapter } from "./acp-adapter";

const fixture = fileURLToPath(new URL("./test-fixtures/acp-agent.cjs", import.meta.url));
const runtime = (mode = "chat") => ({ command: process.execPath, args: [fixture, mode], requestTimeoutMs: 2000 });
const waitFor = async (check: () => boolean) => {
  const end = Date.now() + 6000;
  while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
};

test("plan 전환은 대화·제목·턴 수·인계서를 소비하지 않고 실제 요청은 그대로 기록한다", { timeout: 15000 }, async () => {
  const events: ChatEvent[] = [];
  const titles: string[] = [];
  let handoff: string | null = "handoff context";
  const manager = new SessionManager({
    emit: (_id, event) => events.push(event), acpRuntime: async () => runtime(),
    claudeRuntime: async () => { throw new Error("unused"); }, codexRuntime: async () => { throw new Error("unused"); },
    resolveConfig: () => ({ provider: "codex", connection: "acp", cwd: tmpdir(), policy: "ask" }),
    onMeta: (_id, patch) => { if (patch.title) titles.push(patch.title); },
    store: { appendEvent() {}, readEvents: () => [], resetThread() {}, loadHandoffPrefix: () => handoff, saveHandoffPrefix: (_id, value) => { handoff = value; } },
  });
  const send = async (text: string) => {
    await manager.send("trial", text, [], { type: "user_message", ts: Date.now(), id: text, text });
    await waitFor(() => !manager.isBusy("trial"));
    assert.equal(manager.snapshot("trial").status, "idle");
  };
  try {
    await send("/plan");
    assert.equal(manager.snapshot("trial").acpConfig?.find(option => option.id === "collaboration_mode")?.value, "plan");
    assert.equal(handoff, "handoff context");
    assert.equal(manager.snapshot("trial").startedAt, null);
    assert.deepEqual(titles, []);
    assert.ok(!events.some(event => ["user_message", "notice", "text_delta"].includes(event.type)));
    assert.ok(events.some(event => event.type === "turn_result" && event.control === "plan"));
    await send("/plan 로그인 기능 설계");
    assert.deepEqual(titles, ["/plan 로그인 기능 설계"]);
    assert.equal(handoff, null);
    assert.ok(events.some(event => event.type === "user_message" && event.text === "/plan 로그인 기능 설계"));
    assert.ok(events.some(event => event.type === "text_delta" && event.text.includes("handoff context")));
    assert.equal(events.filter(event => event.type === "turn_result" && !event.control).length, 1);
  } finally { manager.shutdown(); }
});

test("plan 제어 명령의 실패는 채팅 오류로 남긴다", async () => {
  const events: ChatEvent[] = [];
  const manager = new SessionManager({
    emit: (_id, event) => events.push(event), acpRuntime: async () => { throw new Error("mode switch failed"); },
    claudeRuntime: async () => { throw new Error("unused"); }, codexRuntime: async () => { throw new Error("unused"); },
    resolveConfig: () => ({ provider: "codex", connection: "acp", cwd: tmpdir(), policy: "ask" }),
  });
  try {
    await manager.send("trial", "/plan", [], { type: "user_message", ts: 1, id: "control", text: "/plan" });
    await waitFor(() => manager.snapshot("trial").status === "error");
    assert.ok(events.some(event => event.type === "error" && event.message.includes("mode switch failed")));
    assert.ok(!events.some(event => event.type === "user_message"));
    assert.equal((await manager.history("trial")).state.blocks.some(block => block.kind === "error"), true);
  } finally { manager.shutdown(); }
});

test("ACP 실험 탭은 실제 stdio로 명령 조회·실행·갱신하고 native SDK를 호출하지 않는다", { timeout: 15000 }, async () => {
  const events: ChatEvent[] = [];
  let nativeCalls = 0;
  let commandChanges = 0;
  const manager = new SessionManager({
    emit: (_id, event) => events.push(event),
    claudeRuntime: async () => { nativeCalls++; throw new Error("native Claude must not run"); },
    codexRuntime: async () => { nativeCalls++; throw new Error("native Codex must not run"); },
    acpRuntime: async () => runtime(), onAcpCommands: () => { commandChanges++; },
    resolveConfig: () => ({ provider: "codex", connection: "acp", cwd: tmpdir(), policy: "ask" }),
  });
  const send = async (text: string) => {
    const result = await manager.send("trial", text, [], { type: "user_message", ts: Date.now(), id: crypto.randomUUID(), text });
    assert.equal(result.ok, true);
    await waitFor(() => !manager.isBusy("trial"));
    assert.equal(manager.snapshot("trial").status, "idle");
  };
  try {
    const rows = await manager.acpCommands("trial");
    assert.equal(rows[0]?.source, "acp");
    assert.equal(rows[0]?.name, "review");
    const id = manager.snapshot("trial").sessionId;
    await send("/review staged");
    assert.ok(events.some(event => event.type === "text_delta" && event.text === "/review staged"));
    assert.equal(manager.snapshot("trial").sessionId, id);
    await send("/plan");
    assert.equal(manager.snapshot("trial").acpConfig?.find(option => option.id === "collaboration_mode")?.value, "plan");
    const notices = events.filter(event => event.type === "notice");
    assert.equal(notices.length, 0);
    assert.ok(!events.some(event => event.type === "user_message" && event.text === "/plan"));
    assert.equal(events.filter(event => event.type === "text_delta" && event.text === "/plan").length, 0, "mode-only replies have no assistant text");
    await send("/plan");
    assert.equal(events.filter(event => event.type === "notice").length, 0);
    await send("/plan off");
    assert.equal(manager.snapshot("trial").acpConfig?.find(option => option.id === "collaboration_mode")?.value, "default");
    await send("/commands");
    assert.deepEqual((await manager.acpCommands("trial")).map(row => row.name), ["logout", "doctor"]);
    assert.ok(commandChanges >= 2);
    await send("/tool");
    assert.ok(events.some(event => event.type === "tool_use" && event.toolUseId === "tool-1"));
    assert.ok(events.some(event => event.type === "tool_result" && event.output === "fixture data"));
    assert.throws(() => manager.configure("trial", { policy: "full" }));
    assert.throws(() => manager.configure("trial", { model: "native-model" }));
    assert.throws(() => manager.switchProvider("trial", { provider: "claude", preserveContext: false }));
    assert.equal((await manager.attachTerminal("trial")).ok, false);
    manager.externalCliStarted("trial", "codex", tmpdir(), 12345);
    assert.equal(manager.snapshot("trial").controller, "app");
    assert.equal(nativeCalls, 0);
    manager.clear("trial");
    assert.deepEqual(manager.snapshot("trial").acpConfig, []);
    assert.equal(manager.snapshot("trial").connection, "acp");
    assert.equal(manager.snapshot("trial").sessionId, null);
    assert.deepEqual((await manager.acpCommands("trial")).map(row => row.name), ["review"]);
  } finally { manager.shutdown(); }
});

for (const provider of ["claude", "codex"] as const) {
  test(`ACP ${provider}: 승인 선택·취소 뒤 다음 명령을 같은 세션에서 실행한다`, { timeout: 15000 }, async () => {
    const events: ChatEvent[] = [];
    const manager = new SessionManager({
      emit: (_id, event) => events.push(event), acpRuntime: async () => runtime(),
      claudeRuntime: async () => { throw new Error("unused"); }, codexRuntime: async () => { throw new Error("unused"); },
      resolveConfig: () => ({ provider, connection: "acp", cwd: tmpdir(), policy: "ask" }),
    });
    try {
      await manager.acpCommands("trial");
      await manager.send("trial", "permission", [], { type: "user_message", ts: 1, id: "one", text: "permission" });
      await waitFor(() => events.some(event => event.type === "permission_request"));
      const request = events.find(event => event.type === "permission_request")!;
      if (request.type !== "permission_request") throw new Error("missing permission");
      assert.equal(request.canAlwaysAllow, false);
      manager.answerPermission("trial", request.requestId, { behavior: "allow" });
      await waitFor(() => !manager.isBusy("trial"));
      assert.ok(events.some(event => event.type === "text_delta" && event.text === "yes"));
      await manager.send("trial", "hang", [], { type: "user_message", ts: 2, id: "two", text: "hang" });
      manager.abort("trial");
      await waitFor(() => !manager.isBusy("trial"));
      await manager.send("trial", "/review", [], { type: "user_message", ts: 3, id: "three", text: "/review" });
      await waitFor(() => !manager.isBusy("trial"));
      assert.ok(events.some(event => event.type === "text_delta" && event.text === "/review"));
    } finally { manager.shutdown(); }
  });
}

test("ACP load 복원은 기록을 중복 재생하지 않고 저장된 세션 ID를 유지한다", { timeout: 15000 }, async () => {
  const adapter = new AcpAdapter(async () => runtime("chat-load"));
  const events: ChatEvent[] = [];
  let id = "saved";
  try {
    await adapter.run({ sessionKey: "trial", provider: "claude", cwd: tmpdir(), sessionId: id,
      onSession: value => { id = value; }, onCommands() {}, prompt: "/review", images: [],
      signal: new AbortController().signal, emit: event => events.push(event), permission: async () => ({ behavior: "deny" }),
    });
    assert.equal(id, "saved");
    assert.equal(events.filter(event => event.type === "text_delta").length, 1);
    assert.ok(!events.some(event => event.type === "text_delta" && event.text === "restored"));
  } finally { adapter.closeAll(); }
});

test("ACP가 ask mode를 제공하지 않으면 명령·모델 실행을 시작하지 않는다", { timeout: 15000 }, async () => {
  const adapter = new AcpAdapter(async () => runtime("normal"));
  try { await assert.rejects(adapter.open({ sessionKey: "trial", provider: "codex", cwd: tmpdir(), sessionId: null, onSession() { assert.fail("must not attach"); }, onCommands() {} }), /required ask mode/); }
  finally { adapter.closeAll(); }
});

test("폴더 신뢰 확인 중 탭이 닫히거나 경로가 바뀌면 ACP를 띄우지 않는다", async () => {
  for (const action of ["close", "cwd", "clear"] as const) {
    let trust!: (value: boolean) => void;
    let starts = 0;
    const manager = new SessionManager({
      emit() {}, claudeRuntime: async () => { throw new Error("unused"); }, codexRuntime: async () => { throw new Error("unused"); },
      acpRuntime: async () => { starts++; return runtime(); }, ensureFolderTrust: () => new Promise(resolve => { trust = resolve; }),
      resolveConfig: () => ({ provider: "codex", connection: "acp", cwd: tmpdir(), policy: "ask" }),
    });
    const listing = manager.acpCommands("trial");
    if (action === "close") manager.release("trial");
    else if (action === "clear") manager.clear("trial");
    else manager.configure("trial", { cwd: tmpdir() + "-changed" });
    trust(true);
    await assert.rejects(listing, /session changed/);
    assert.equal(starts, 0);
    manager.shutdown();
  }
});
