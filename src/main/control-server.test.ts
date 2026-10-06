import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, type ControlDeps } from "./control-server";
import type { ChatEvent } from "@shared/chat-events";
import type { WorkspaceStateDto } from "@shared/ipc";

function fakeDeps() {
  const model: WorkspaceStateDto["model"] = {
    workspaces: [{ id: "w1", name: "dev", path: "/tmp/dev" }],
    tabs: [
      { id: "t1", workspaceId: "w1", title: "auth 버그", provider: "claude", policy: "ask", sessionId: "s1", createdAt: 1, updatedAt: 1, open: true },
      { id: "t2", workspaceId: "w1", title: "auth 리팩터", provider: "codex", policy: "ask", sessionId: null, createdAt: 2, updatedAt: 2, open: true },
      { id: "t3", workspaceId: "w1", title: "닫힌 탭", provider: "claude", policy: "ask", sessionId: null, createdAt: 3, updatedAt: 3, open: false },
    ],
    openTabIds: ["t1", "t2"],
    activeTabId: "t1",
  } as unknown as WorkspaceStateDto["model"];
  const statuses: Record<string, string> = { t1: "idle", t2: "running" };
  const pending: Record<string, number> = {};
  const events: Record<string, ChatEvent[]> = {
    t1: [
      { type: "user_message", ts: 1, id: "u1", text: "왜 500?" },
      { type: "tool_use", ts: 2, toolUseId: "x", name: "Bash", input: { command: "grep -rn 500 src" } },
      { type: "tool_result", ts: 3, toolUseId: "x", output: "…", isError: false },
      { type: "assistant_text", ts: 4, blockId: "a1", text: "원인은 " },
      { type: "assistant_text", ts: 5, blockId: "a2", text: "널 참조." },
    ],
  };
  const calls: string[] = [];
  const deps: ControlDeps = {
    version: "0.1.0",
    state: () => ({ model, statuses: {}, attention: {} }) as unknown as WorkspaceStateDto,
    addWorkspace: (path) => {
      calls.push(`addWorkspace ${path}`);
      return { workspaceId: "w2", tabId: "t9" };
    },
    createTab: (ws) => {
      calls.push(`createTab ${ws}`);
      model.tabs.push({ id: "t4", workspaceId: ws ?? "w1", title: null, provider: "claude", policy: "ask", sessionId: null, createdAt: 4, updatedAt: 4, open: true } as never);
      model.openTabIds.push("t4");
      model.activeTabId = "t4"; // 실제 WorkspaceService.createTab 은 새 탭을 활성화한다
      statuses.t4 = "idle";
      return "t4";
    },
    configure: (tabId, patch) => calls.push(`configure ${tabId} ${JSON.stringify(patch)}`),
    renameTab: (tabId, title) => {
      calls.push(`rename ${tabId} ${title}`);
      const t = model.tabs.find((x) => x.id === tabId)!;
      t.title = title;
    },
    activateTab: (tabId) => {
      calls.push(`activate ${tabId}`);
      model.activeTabId = tabId;
    },
    closeTab: (tabId) => calls.push(`close ${tabId}`),
    snapshot: (tabId) => ({ status: statuses[tabId] as never, provider: "claude", cwd: "/tmp/dev", sessionId: null, controller: "app", pending: pending[tabId] ?? 0, limitWait: false }),
    events: (tabId) => events[tabId] ?? [],
    send: async (tabId, text) => {
      calls.push(`send ${tabId} ${text}`);
      // 보내면 잠깐 running 이었다가 idle 로 — wait 가 이를 본다
      statuses[tabId] = "running";
      setTimeout(() => {
        statuses[tabId] = "idle";
        events[tabId] = [...(events[tabId] ?? []), { type: "user_message", ts: 10, id: "u2", text }, { type: "assistant_text", ts: 11, blockId: "b", text: "네, 했습니다." }, { type: "turn_result", ts: 12, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 5, numTurns: 1, modelUsage: {}, isError: false }];
      }, 400);
      return { ok: true, queued: false };
    },
    abort: (tabId) => calls.push(`abort ${tabId}`),
    verify: async (tabId, commands) => {
      calls.push(`verify ${tabId} ${JSON.stringify(commands ?? null)}`);
      const cmds = commands ?? ["yarn test"];
      const base = { type: "verify" as const, runId: "r1", cwd: "/tmp/dev", head: { sha: "abc123", branch: "main", dirty: true } };
      events[tabId] = [...(events[tabId] ?? []), { ...base, ts: 20, status: "running", commands: cmds.map((cmd) => ({ cmd, status: "pending" as const })) }];
      setTimeout(() => {
        events[tabId] = [...(events[tabId] ?? []), { ...base, ts: 21, status: "passed", commands: cmds.map((cmd) => ({ cmd, status: "passed" as const, exitCode: 0, durationMs: 3 })) }];
      }, 300);
      return { ok: true, runId: "r1" };
    },
    verifyAbort: (tabId) => {
      calls.push(`verifyAbort ${tabId}`);
      return true;
    },
    fanout: async (tabId, req) => {
      calls.push(`fanout ${tabId} ${req.variants.map((v) => v.provider).join(",")} ${req.policy ?? "-"}`);
      const variants = req.variants.map((v, i) => ({ tabId: `f${i}`, label: String.fromCharCode(65 + i), provider: v.provider, status: "running" as const }));
      events[tabId] = [...(events[tabId] ?? []), { type: "fanout", ts: 30, fanoutId: "fo1", status: "running", prompt: req.prompt, policy: req.policy ?? "auto_edit", variants }];
      setTimeout(() => {
        events[tabId] = [...(events[tabId] ?? []), { type: "fanout", ts: 31, fanoutId: "fo1", status: "done", prompt: req.prompt, policy: req.policy ?? "auto_edit", variants: variants.map((v) => ({ ...v, status: "done" as const, files: 1, added: 2, deleted: 0, summary: "했습니다" })) }];
      }, 300);
      return { ok: true, fanoutId: "fo1", tabIds: variants.map((v) => v.tabId) };
    },
    approveRoot: (p) => calls.push(`approve ${p}`),
    openFile: (tabId, path, line) => calls.push(`openFile ${tabId} ${path} ${line ?? ""}`),
    openBrowser: (tabId, url) => calls.push(`openBrowser ${tabId} ${url}`),
    runInBrowser: async (tabId, script) => {
      calls.push(`runInBrowser ${tabId} ${script.slice(0, 20)}`);
      return { ok: true };
    },
    guide: (name) => (name === "sudal-cli" ? "# 가이드" : null),
  };
  return { deps, calls, statuses, pending, model };
}

test("ControlServer: 선택자·목록·읽기·보내고 기다리기·화면 열기", async () => {
  const { deps, calls, pending, model } = fakeDeps();
  const srv = new ControlServer(deps, join(mkdtempSync(join(tmpdir(), "wb-ctl-")), "c.sock"));
  const d = (m: string, p: Record<string, unknown> = {}) => srv.dispatch(m, p) as Promise<Record<string, unknown>>;
  assert.equal((await d("status")).openTabs, 2);
  assert.deepEqual((await d("ws.list")).workspaces, [{ id: "w1", name: "dev", path: "/tmp/dev", openTabs: 2 }]);
  const list = (await d("tab.list")).tabs as { id: string; title: string; status: string; active: boolean }[];
  assert.deepEqual(list.map((t) => [t.id, t.title, t.status, t.active]), [["t1", "auth 버그", "idle", true], ["t2", "auth 리팩터", "running", false]]);
  assert.equal(((await d("tab.list", { all: true })).tabs as unknown[]).length, 3);
  // 선택자: active · id · 정확한 제목 · 접두(유일) · 접두(중복) · 없음
  assert.equal(((await d("tab.status", { tab: "active" })).tab as { id: string }).id, "t1");
  assert.equal(((await d("tab.status", { tab: "t2" })).tab as { id: string }).id, "t2");
  assert.equal(((await d("tab.status", { tab: "AUTH 리팩터" })).tab as { id: string }).id, "t2");
  assert.equal(((await d("tab.status", { tab: "auth 리" })).tab as { id: string }).id, "t2");
  await assert.rejects(d("tab.status", { tab: "auth" }), /여러 개/);
  await assert.rejects(d("tab.status", { tab: "없는 탭" }), /찾지 못했습니다/);
  await assert.rejects(d("tab.status", { tab: "닫힌 탭" }), /찾지 못했습니다/, "닫힌 탭은 선택 안 됨");
  // 읽기: 마지막 N 블록을 압축해서
  const read = await d("tab.read", { tab: "t1", last: 2 });
  assert.equal(read.total, 4);
  assert.deepEqual(read.blocks, [
    { kind: "assistant", text: "원인은 ", streaming: false },
    { kind: "assistant", text: "널 참조.", streaming: false },
  ]);
  assert.deepEqual(((await d("tab.read", { tab: "t1", last: 3 })).blocks as unknown[])[0], { kind: "tool", name: "Bash", summary: "grep -rn 500 src", done: true, isError: false });
  // 새 탭: cwd 승인 → configure → 제목 → 프롬프트
  const created = await d("tab.new", { workspace: "dev", cwd: "/tmp/dev/sub", provider: "codex", policy: "auto_edit", title: "새 일", prompt: "시작" });
  assert.equal((created.tab as { id: string; title: string }).title, "새 일");
  assert.equal(model.activeTabId, "t1", "--activate 가 없으면 보고 있던 탭으로 되돌린다");
  assert.ok(calls.includes("approve /tmp/dev/sub"));
  assert.ok(calls.includes('configure t4 {"cwd":"/tmp/dev/sub","provider":"codex","policy":"auto_edit"}'));
  assert.ok(calls.includes("send t4 시작"));
  const before = calls.filter((c) => c.startsWith("createTab")).length;
  await assert.rejects(d("tab.new", { provider: "gemini" }), /claude 또는 codex/);
  assert.equal(calls.filter((c) => c.startsWith("createTab")).length, before, "잘못된 인자로는 탭을 만들지 않는다");
  // 보내고 기다리기 → 답
  const sent = await d("tab.send", { tab: "auth 버그", text: "테스트 추가", wait: true, timeoutMs: 5000 });
  assert.equal((sent.wait as { satisfied: boolean }).satisfied, true);
  assert.equal(sent.reply, "네, 했습니다.");
  // 시간 초과는 오류가 아니라 satisfied:false
  deps.snapshot = () => ({ status: "running", provider: "claude", cwd: null, sessionId: null, controller: "app", pending: 0, limitWait: false });
  const w = await d("tab.wait", { tab: "t1", timeoutMs: 300 });
  assert.equal((w.wait as { satisfied: boolean }).satisfied, false);
  // 화면 열기
  await d("file.open", { path: "/tmp/dev/a.ts", line: 12 });
  assert.ok(calls.includes("openFile t1 /tmp/dev/a.ts 12"));
  await assert.rejects(d("file.open", { path: "rel.ts" }), /절대 경로/);
  await d("browser.open", { tab: "t2", url: "http://localhost:3000" });
  assert.ok(calls.includes("openBrowser t2 http://localhost:3000"));
  await assert.rejects(d("browser.open", { url: "file:///x" }), /http/);
  assert.equal((await d("skills.get")).text, "# 가이드");
  await assert.rejects(d("nope"), /모르는 명령/);
});

test("ControlServer: 소켓으로 줄 단위 JSON 요청·응답, 잘못된 줄은 error 로", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-ctl-"));
  const sock = join(dir, "c.sock");
  const { deps } = fakeDeps();
  const srv = new ControlServer(deps, sock);
  await srv.start();
  try {
    const roundtrip = (line: string) =>
      new Promise<string>((res, rej) => {
        const c = createConnection(sock);
        let buf = "";
        c.setEncoding("utf8");
        c.on("connect", () => c.write(line + "\n"));
        c.on("data", (d) => {
          buf += d;
          if (buf.includes("\n")) {
            c.end();
            res(buf.trim());
          }
        });
        c.on("error", rej);
      });
    const ok = JSON.parse(await roundtrip(JSON.stringify({ id: 7, method: "status" })));
    assert.equal(ok.id, 7);
    assert.equal(ok.result.version, "0.1.0");
    const bad = JSON.parse(await roundtrip("{not json"));
    assert.equal(bad.error.code, "error");
    const unknown = JSON.parse(await roundtrip(JSON.stringify({ id: 8, method: "tab.status", params: { tab: "zzz" } })));
    assert.equal(unknown.error.code, "not_found");
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlServer: 값 없는 --tab 거절, 중복 워크스페이스 이름은 ambiguous, 새 탭 프롬프트 실패는 send_failed, --activate 는 활성화", async () => {
  const { deps, calls, model } = fakeDeps();
  const srv = new ControlServer(deps, join(mkdtempSync(join(tmpdir(), "wb-ctl-")), "c.sock"));
  const d = (m: string, p: Record<string, unknown> = {}) => srv.dispatch(m, p) as Promise<Record<string, unknown>>;
  await assert.rejects(d("tab.close", { tab: true }), /--tab 값이 필요합니다/, "플래그만 있는 --tab 은 active 로 보지 않는다");
  await assert.rejects(d("tab.send", { tab: "t1", text: true }), /--text 값이 필요합니다/);
  assert.equal((await d("tab.close", {})).closed, "t1", "생략은 active");
  (model.workspaces as { id: string; name: string; path: string }[]).push({ id: "w2", name: "dev", path: "/tmp/dev2" });
  await assert.rejects(d("tab.list", { workspace: "dev" }), /여러 개/);
  assert.equal(((await d("tab.list", { workspace: "/tmp/dev2" })).tabs as unknown[]).length, 0, "경로로는 고를 수 있다");
  (model.workspaces as { id: string; name: string; path: string }[]).push({ id: "w3", name: "nopath", path: "" });
  await assert.rejects(d("tab.new", { workspace: "w3", prompt: "x" }), /작업 경로가 필요/, "cwd 없이 프롬프트를 보내려 하면 만들기 전에 거절");
  const before = calls.filter((c) => c.startsWith("createTab")).length;
  assert.equal(calls.filter((c) => c.startsWith("createTab")).length, before);
  deps.send = async () => ({ ok: false, error: "작업 경로를 먼저 정하세요." });
  await assert.rejects(d("tab.new", { workspace: "w1", prompt: "x" }), (e: Error & { code: string; data?: { tabId: string } }) => e.code === "send_failed" && e.data?.tabId === "t4");
  await d("tab.new", { workspace: "w1", activate: true });
  assert.equal(model.activeTabId, "t4");
  // --ws 가 없으면 화면의 탭이 아니라 부른 탭의 워크스페이스에 만든다
  (model.tabs as unknown[]).push({ id: "t5", workspaceId: "w2", title: null, provider: "codex", policy: "ask", sessionId: null, createdAt: 5, updatedAt: 5, open: true });
  await d("tab.new", { caller: "t5" });
  assert.equal(calls.filter((c) => c.startsWith("createTab")).at(-1), "createTab w2");
  await d("tab.new", { caller: "없는-탭" });
  assert.equal(calls.filter((c) => c.startsWith("createTab")).at(-1), "createTab w1", "부른 탭을 못 찾으면 화면의 탭 기준");
});

test("ControlServer: wait 는 남은 일(pending·limitWait)까지 보고, send --wait 는 그 메시지의 turn_result 를 기다린다", async () => {
  const { deps, pending, statuses } = fakeDeps();
  const srv = new ControlServer(deps, join(mkdtempSync(join(tmpdir(), "wb-ctl-")), "c.sock"));
  const d = (m: string, p: Record<string, unknown> = {}) => srv.dispatch(m, p) as Promise<Record<string, unknown>>;
  // 이미 끝난 탭은 즉시 satisfied
  const w0 = await d("tab.wait", { tab: "t1", timeoutMs: 100 });
  assert.equal((w0.wait as { satisfied: boolean; waitedMs: number }).satisfied, true);
  // 큐에 프롬프트가 남아 있으면 idle 이어도 아직
  pending.t1 = 1;
  const w1 = await d("tab.wait", { tab: "t1", timeoutMs: 300 });
  assert.equal((w1.wait as { satisfied: boolean }).satisfied, false);
  pending.t1 = 0;
  // send --wait: 상태가 idle 로 돌아와도 turn_result 가 없으면 아직 — pending 으로 보관된 프롬프트를 완료로 오판하지 않는다
  deps.send = async () => ({ ok: true, queued: false, pending: true });
  statuses.t1 = "idle";
  const s1 = await d("tab.send", { tab: "t1", text: "나중에", wait: true, timeoutMs: 400 });
  assert.equal((s1.wait as { satisfied: boolean }).satisfied, false);
  assert.equal(s1.reply, undefined);
});

test("tab.verify: 실행을 시작하고 --wait 면 끝난 결과(명령별 상태)를 돌려준다; read 에도 verify 블록", async () => {
  const { deps, calls } = fakeDeps();
  const server = new ControlServer(deps, join(mkdtempSync(join(tmpdir(), "wb-ctl-")), "c.sock"));
  const r = (await server.dispatch("tab.verify", { tab: "t1", commands: ["yarn typecheck", "yarn test"], wait: true, timeoutMs: 5000 })) as { runId: string; wait: { satisfied: boolean }; result: { status: string; commands: { cmd: string; status: string }[] } };
  assert.equal(r.runId, "r1");
  assert.equal(r.wait.satisfied, true);
  assert.equal(r.result.status, "passed");
  assert.deepEqual(r.result.commands.map((c) => [c.cmd, c.status]), [["yarn typecheck", "passed"], ["yarn test", "passed"]]);
  assert.ok(calls.some((c) => c === 'verify t1 ["yarn typecheck","yarn test"]'));
  const read = (await server.dispatch("tab.read", { tab: "t1", last: 1 })) as { blocks: { kind: string; head?: { sha: string } }[] };
  assert.equal(read.blocks[0].kind, "verify");
  assert.equal(read.blocks[0].head?.sha, "abc123");
  const a = (await server.dispatch("tab.verify.abort", { tab: "t1" })) as { aborted: boolean };
  assert.equal(a.aborted, true);
  await assert.rejects(server.dispatch("tab.verify", { tab: "t1", commands: "echo x" }), /commands/);
  await assert.rejects(server.dispatch("tab.verify", { tab: "t1", commands: [42] }), /commands/);
});

test("tab.fanout: providers 로 시작하고 --wait 면 변형별 결과를 돌려준다", async () => {
  const { deps, calls } = fakeDeps();
  const server = new ControlServer(deps, join(mkdtempSync(join(tmpdir(), "wb-ctl-")), "c.sock"));
  const r = (await server.dispatch("tab.fanout", { tab: "t1", prompt: "고쳐줘", providers: ["claude", "codex"], policy: "full", wait: true, timeoutMs: 5000 })) as { fanoutId: string; tabIds: string[]; wait: { satisfied: boolean }; result: { status: string; variants: { label: string; status: string; files: number }[] } };
  assert.equal(r.fanoutId, "fo1");
  assert.deepEqual(r.tabIds, ["f0", "f1"]);
  assert.equal(r.wait.satisfied, true);
  assert.equal(r.result.status, "done");
  assert.deepEqual(r.result.variants.map((v) => [v.label, v.status, v.files]), [["A", "done", 1], ["B", "done", 1]]);
  assert.ok(calls.includes("fanout t1 claude,codex full"));
  await assert.rejects(server.dispatch("tab.fanout", { tab: "t1", prompt: "x" }), /providers/);
});

test("자기 탭은 기다릴 수 없다: 부른 탭(caller)과 대상이 같으면 self_wait, 보내기만 하는 것은 된다", async () => {
  const { deps, calls } = fakeDeps();
  const srv = new ControlServer(deps, join(mkdtempSync(join(tmpdir(), "wb-ctl-")), "c.sock"));
  const d = (m: string, p: Record<string, unknown> = {}) => srv.dispatch(m, p) as Promise<Record<string, unknown>>;
  await assert.rejects(d("tab.wait", { tab: "t1", caller: "t1" }), (e: { code?: string }) => e.code === "self_wait");
  await assert.rejects(d("tab.send", { tab: "t1", text: "x", wait: true, caller: "t1" }), (e: { code?: string }) => e.code === "self_wait");
  assert.equal(calls.some((c) => c.startsWith("send t1")), false, "막힌 요청은 보내지 않는다");
  // 다른 탭을 기다리는 것, 자기 탭에 기다리지 않고 보내는 것은 그대로 된다
  assert.equal(((await d("tab.wait", { tab: "t1", caller: "t2" })).wait as { satisfied: boolean }).satisfied, true);
  assert.equal(((await d("tab.send", { tab: "t1", text: "y", caller: "t1" })).send as { ok: boolean }).ok, true);
});
