import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, type AcpClientHandlers, type AcpLaunchOptions } from "./acp-client";

const fixture = fileURLToPath(new URL("./test-fixtures/acp-agent.cjs", import.meta.url));
async function setup(mode = "normal", handlers: AcpClientHandlers = {}, overrides: Partial<AcpLaunchOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "sudal-acp-"));
  const client = await AcpClient.start({ command: process.execPath, args: [fixture, mode], cwd, ...overrides }, handlers);
  return { client, cwd, async close() { await client.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}
const prompt = (sessionId: string, text: string) => ({ sessionId, prompt: [{ type: "text" as const, text }] });

test("ACP: 초기화 중 취소도 제한 시간까지 기다리지 않고 연결을 종료한다", { timeout: 15000 }, async () => {
  const abort = new AbortController();
  const started = Date.now();
  const opening = AcpClient.start({ command: process.execPath, args: [fixture, "slow-init"], cwd: tmpdir(), requestTimeoutMs: 10000 }, {}, abort.signal);
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(opening, /cancelled/);
  assert.ok(Date.now() - started < 5000);
});

test("ACP: 실제 stdio 연결로 세션·슬래시 갱신·여러 세션 응답을 라우팅한다", { timeout: 15000 }, async () => {
  const updates: SessionNotification[] = [];
  const commands: [string, string[]][] = [];
  const s = await setup("normal", { onUpdate: e => updates.push(e), onCommands: (id, rows) => commands.push([id, rows.map(row => row.name)]) });
  try {
    assert.equal(s.client.info.protocolVersion, 1);
    const a = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    const b = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    assert.deepEqual(commands, [[a.sessionId, ["review"]], [b.sessionId, ["review"]]]);
    const results = await Promise.all([s.client.prompt(prompt(a.sessionId, "a")), s.client.prompt(prompt(b.sessionId, "b"))]);
    assert.ok(results.every(r => r.stopReason === "end_turn"));
    assert.ok(updates.some(e => e.sessionId === a.sessionId && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" && e.update.content.text === "a"));
    assert.equal((await s.client.listSessions()).sessions.length, 2);
    assert.equal(a.configOptions?.[0].id, "model");
    await s.client.authenticate("fixture");
    await assert.rejects(s.client.authenticate("unknown"), /Unsupported ACP authentication/);
  } finally { await s.close(); }
});

test("ACP: load는 기록을 재생하고 resume은 재생 없이 같은 ID를 연결한다", { timeout: 15000 }, async () => {
  const events: SessionNotification[] = [];
  const s = await setup("normal", { onUpdate: e => events.push(e) });
  try {
    await s.client.loadSession({ sessionId: "saved", cwd: s.cwd, mcpServers: [] });
    assert.equal(events.length, 1);
    await s.client.resumeSession({ sessionId: "saved", cwd: s.cwd, mcpServers: [] });
    assert.equal(events.length, 1);
    assert.equal((await s.client.prompt(prompt("saved", "ok"))).stopReason, "end_turn");
    await assert.rejects(s.client.prompt(prompt("unattached", "no")), /not attached/);
  } finally { await s.close(); }
});

test("ACP: 승인 콜백은 서버가 제시한 선택지만 허용하고 기본은 취소한다", { timeout: 15000 }, async () => {
  for (const answer of ["yes", "no", "invented", "throw", null]) {
    const s = await setup("normal", answer === null ? {} : { requestPermission: async () => {
      if (answer === "throw") throw new Error("UI failed");
      return answer;
    } });
    try {
      const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
      const result = await s.client.prompt(prompt(sessionId, "permission"));
      assert.equal(result.stopReason, answer === "yes" || answer === "no" ? "end_turn" : "cancelled");
    } finally { await s.close(); }
  }
});

test("ACP: 승인 대기 중 취소가 콜백을 해제하고 다음 턴을 실행한다", { timeout: 15000 }, async () => {
  let requested!: () => void;
  const arrived = new Promise<void>(resolve => { requested = resolve; });
  let permissionSignal: AbortSignal | undefined;
  const s = await setup("normal", { requestPermission: (_req, signal) => { permissionSignal = signal; requested(); return new Promise(() => {}); } });
  try {
    const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    const abort = new AbortController();
    const turn = s.client.prompt(prompt(sessionId, "permission"), abort.signal);
    await arrived;
    abort.abort();
    assert.equal((await turn).stopReason, "cancelled");
    assert.equal(permissionSignal?.aborted, true);
    assert.equal((await s.client.prompt(prompt(sessionId, "next"))).stopReason, "end_turn");
  } finally { await s.close(); }
});

test("ACP: 취소 이후 도착한 승인은 콜백 없이 취소하고 다음 턴의 승인은 허용한다", { timeout: 15000 }, async () => {
  for (const viaSignal of [false, true]) {
    let permissionCalls = 0;
    const responses: string[] = [];
    const s = await setup("normal", {
      requestPermission: async () => { permissionCalls++; return "yes"; },
      onUpdate: e => {
        if (e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text") responses.push(e.update.content.text);
      },
    });
    try {
      const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
      const abort = new AbortController();
      const turn = s.client.prompt(prompt(sessionId, "late-permission"), viaSignal ? abort.signal : undefined);
      if (viaSignal) abort.abort();
      else await s.client.cancel(sessionId);
      assert.equal((await turn).stopReason, "cancelled");
      assert.equal(permissionCalls, 0, "취소된 턴의 지연 요청은 승인 UI나 자동 승인 콜백으로 전달하지 않는다");
      assert.deepEqual(responses, ["cancelled"], "서버에는 허용 선택지 대신 cancelled를 반환한다");
      assert.equal((await s.client.prompt(prompt(sessionId, "permission"))).stopReason, "end_turn");
      assert.equal(permissionCalls, 1, "다음 턴에는 새 승인 상태를 사용한다");
      assert.deepEqual(responses, ["cancelled", "yes"]);
    } finally { await s.close(); }
  }
});

test("ACP: 지원하지 않는 기록·이미지 기능은 전송 전에 거절한다", { timeout: 15000 }, async () => {
  const s = await setup("minimal");
  try {
    await assert.rejects(s.client.loadSession({ sessionId: "saved", cwd: s.cwd, mcpServers: [] }), /not supported/);
    await assert.rejects(s.client.resumeSession({ sessionId: "saved", cwd: s.cwd, mcpServers: [] }), /not supported/);
    await assert.rejects(s.client.listSessions(), /not supported/);
    const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    await assert.rejects(s.client.prompt({ sessionId, prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }), /content is not supported/);
    assert.equal((await s.client.prompt(prompt(sessionId, "still works"))).stopReason, "end_turn");
  } finally { await s.close(); }
});

test("ACP: 한 세션의 승인 취소가 다른 세션의 승인을 취소하지 않는다", { timeout: 15000 }, async () => {
  const answers = new Map<string, (answer: string) => void>();
  let arrived!: () => void;
  const bothRequested = new Promise<void>(resolve => { arrived = resolve; });
  const s = await setup("normal", { requestPermission: req => new Promise(resolve => {
    answers.set(req.sessionId, resolve);
    if (answers.size === 2) arrived();
  }) });
  try {
    const a = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    const b = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    const first = s.client.prompt(prompt(a.sessionId, "permission"));
    const second = s.client.prompt(prompt(b.sessionId, "permission"));
    await bothRequested;
    await s.client.cancel(a.sessionId);
    assert.equal((await first).stopReason, "cancelled");
    answers.get(b.sessionId)!("yes");
    assert.equal((await second).stopReason, "end_turn");
    assert.equal(s.client.alive, true);
  } finally { await s.close(); }
});

test("ACP: 협상 버전 불일치와 초기화 타임아웃에서 프로세스를 닫는다", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sudal-acp-init-"));
  try {
    await assert.rejects(AcpClient.start({ command: process.execPath, args: [fixture, "bad-version"], cwd }), /Unsupported ACP protocol version/);
    await assert.rejects(AcpClient.start({ command: process.execPath, args: [fixture, "slow-init"], cwd, requestTimeoutMs: 100 }), /timed out/);
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("ACP: 같은 세션 중복 실행을 막고 종료 시 미결 턴을 해제한다", { timeout: 15000 }, async () => {
  const s = await setup();
  try {
    const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    const turn = s.client.prompt(prompt(sessionId, "hang"));
    const rejected = assert.rejects(turn, /closed/);
    await assert.rejects(s.client.prompt(prompt(sessionId, "duplicate")), /active prompt/);
    await s.client.close();
    await rejected;
    assert.equal(s.client.alive, false);
  } finally { await s.close(); }
});

test("ACP: 직접 보낸 취소도 에이전트가 무시하면 유예 후 종료한다", { timeout: 15000 }, async () => {
  const s = await setup("ignore-cancel", {}, { cancelGraceMs: 100 });
  try {
    const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    const turn = s.client.prompt(prompt(sessionId, "hang"));
    const rejected = assert.rejects(turn, /did not finish cancellation/);
    await s.client.cancel(sessionId);
    await rejected;
    assert.equal(s.client.alive, false);
  } finally { await s.close(); }
});

test("ACP: 비정상 종료와 초과 크기 메시지에서도 미결 요청이 남지 않는다", { timeout: 15000 }, async () => {
  for (const text of ["exit", "oversized"]) {
    const s = await setup("normal", {}, { maxMessageBytes: 2048 });
    try {
      const { sessionId } = await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
      await assert.rejects(s.client.prompt(prompt(sessionId, text)));
      assert.equal(s.client.alive, false);
    } finally { await s.close(); }
  }
});

test("ACP: 종료 시 어댑터가 띄운 자식 프로세스도 정리한다", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sudal-acp-child-"));
  const marker = join(dir, "pid");
  const s = await setup("normal", {}, { env: { ...process.env, ACP_CHILD_PID_FILE: marker } });
  let childPid: number | undefined;
  try {
    await s.client.newSession({ cwd: s.cwd, mcpServers: [] });
    childPid = Number(await readFile(marker, "utf8"));
    assert.doesNotThrow(() => process.kill(childPid!, 0));
    await s.client.close();
    // Unix 그룹 종료는 비동기 reaping이 필요할 수 있다.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(childPid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(childPid!, 0));
  } finally {
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* 이미 정리됨 */ } }
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACP: 초기화에서 실제 앱 이름과 구현한 클라이언트 기능만 선언한다", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sudal-acp-capabilities-"));
  const marker = join(dir, "initialize.json");
  const s = await setup("normal", {}, { env: { ...process.env, ACP_INIT_MARKER: marker } });
  try {
    const initialization = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(initialization.clientInfo.name, "sudal");
    assert.deepEqual(initialization.clientCapabilities, {});
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }); }
});
