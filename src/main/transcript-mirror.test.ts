import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptWatcher,
  claudeHookSettings,
  findClaudeTranscript,
  findCodexRollout,
  mapClaudeHookLine,
  mapClaudeTranscriptLine,
  mapCodexRolloutLine,
  newMirrorState,
  readCodexRolloutMeta,
  shellQuote,
  shownCommand,
  HOOK_APPEND_SCRIPT,
  claudeHookCmdFile,
} from "./transcript-mirror";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("shownCommand: 셸 래퍼를 벗기고 안쪽 명령만", () => {
  assert.equal(shownCommand(["/bin/zsh", "-lc", "ls -la"]), "ls -la");
  assert.equal(shownCommand(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"]), "Get-ChildItem");
  assert.equal(shownCommand(["pwsh", "-Command", "dir"]), "dir");
  assert.equal(shownCommand(["cmd.exe", "/c", "dir /b"]), "dir /b");
  assert.equal(shownCommand(["git", "status"]), "git status");
  assert.equal(shownCommand(["powershell.exe"]), "powershell.exe");
});

test("HOOK_APPEND_SCRIPT: stdin 을 그대로 파일 끝에 붙인다(cat >> 와 같게)", () => {
  const d = mkdtempSync(join(tmpdir(), "hook-append-"));
  const script = join(d, "hook-append.cjs");
  writeFileSync(script, HOOK_APPEND_SCRIPT);
  const log = join(d, "s.jsonl");
  writeFileSync(log, "");
  execFileSync(process.execPath, [script, log], { input: '{"a":1}\n' });
  execFileSync(process.execPath, [script, log], { input: '{"b":"한글"}\n' });
  assert.equal(readFileSync(log, "utf8"), '{"a":1}\n{"b":"한글"}\n');
  assert.equal(claudeHookCmdFile("C:\\x\\hooks\\abc.jsonl"), "C:\\x\\hooks\\abc.cmd");
  assert.equal(claudeHookCmdFile("C:\\x\\hooks\\abc.log"), null);
});

test("mapClaudeTranscriptLine: user 텍스트·tool_result, assistant 블록별 text/tool_use, end_turn 은 message 당 한 번", () => {
  const st = newMirrorState();
  const user = JSON.stringify({
    type: "user",
    isSidechain: false,
    uuid: "u1",
    timestamp: "2026-09-05T01:00:00Z",
    message: { role: "user", content: [{ type: "text", text: "안녕" }] },
  });
  const ev1 = mapClaudeTranscriptLine(user, st);
  assert.deepEqual(ev1, [
    {
      type: "user_message",
      ts: Date.parse("2026-09-05T01:00:00Z"),
      id: "u1",
      text: "안녕",
    },
  ]);
  const a1 = JSON.stringify({
    type: "assistant",
    apiBlockIndex: 0,
    timestamp: "2026-09-05T01:00:01Z",
    message: {
      id: "m1",
      role: "assistant",
      content: [{ type: "thinking", thinking: "" }],
      stop_reason: "tool_use",
      usage: {},
    },
  });
  assert.deepEqual(mapClaudeTranscriptLine(a1, st), []);
  const a2 = JSON.stringify({
    type: "assistant",
    apiBlockIndex: 1,
    timestamp: "2026-09-05T01:00:01Z",
    message: {
      id: "m1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: {},
    },
  });
  assert.equal(mapClaudeTranscriptLine(a2, st)[0].type, "tool_use");
  const tr = JSON.stringify({
    type: "user",
    uuid: "u2",
    timestamp: "2026-09-05T01:00:02Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "a.txt",
          is_error: false,
        },
      ],
    },
  });
  assert.deepEqual(mapClaudeTranscriptLine(tr, st), [
    {
      type: "tool_result",
      ts: Date.parse("2026-09-05T01:00:02Z"),
      toolUseId: "t1",
      output: "a.txt",
      isError: false,
    },
  ]);
  const a3 = JSON.stringify({
    type: "assistant",
    apiBlockIndex: 0,
    timestamp: "2026-09-05T01:00:03Z",
    message: {
      id: "m2",
      role: "assistant",
      content: [{ type: "text", text: "끝" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 3,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 0,
      },
    },
  });
  const ev3 = mapClaudeTranscriptLine(a3, st);
  assert.equal(ev3.length, 2);
  assert.equal(ev3[1].type, "turn_result");
  assert.deepEqual((ev3[1] as { usage: unknown }).usage, {
    input: 3,
    output: 5,
    cacheRead: 7,
    cacheWrite: 0,
  });
  assert.equal((ev3[1] as { contextTokens?: number }).contextTokens, 10);
  assert.equal(
    mapClaudeTranscriptLine(a3, st).filter((e) => e.type === "turn_result")
      .length,
    0,
  ); // 같은 message 중복 방지
  // 사이드체인·메타·로컬 커맨드 출력은 무시
  assert.deepEqual(
    mapClaudeTranscriptLine(
      JSON.stringify({
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "x" },
      }),
      st,
    ),
    [],
  );
  assert.deepEqual(
    mapClaudeTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>hi</local-command-stdout>",
        },
      }),
      st,
    ),
    [],
  );
  assert.deepEqual(mapClaudeTranscriptLine("not json", st), []);
});

test("mapCodexRolloutLine: item_completed 항목과 token_count/task_complete 로 turn_result", () => {
  const st = newMirrorState();
  const line = (payload: unknown, ts = "2026-09-05T01:00:00Z") =>
    JSON.stringify({ timestamp: ts, type: "event_msg", payload });
  assert.deepEqual(
    mapCodexRolloutLine(line({ type: "task_started", turn_id: "t" }), st),
    [],
  );
  const u = mapCodexRolloutLine(
    line({
      type: "item_completed",
      item: {
        type: "UserMessage",
        id: "u1",
        content: [{ type: "text", text: "해줘" }],
      },
    }),
    st,
  );
  assert.deepEqual(u, [
    {
      type: "user_message",
      ts: Date.parse("2026-09-05T01:00:00Z"),
      id: "u1",
      text: "해줘",
    },
  ]);
  const c = mapCodexRolloutLine(
    line({
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id: "e1",
        command: ["/bin/zsh", "-lc", "ls -la"],
        stdout: "a\nb",
        status: "completed",
        exit_code: 0,
      },
    }),
    st,
  );
  assert.equal(c[0].type, "tool_use");
  assert.deepEqual((c[0] as { input: unknown }).input, { command: "ls -la" });
  assert.equal((c[1] as { output: string }).output, "a\nb");
  const f = mapCodexRolloutLine(
    line({
      type: "item_completed",
      item: {
        type: "FileChange",
        id: "f1",
        changes: { "/a/b.ts": { type: "add", content: "x" } },
        status: "completed",
      },
    }),
    st,
  );
  assert.deepEqual((f[0] as { input: unknown }).input, {
    changes: [{ kind: "add", path: "/a/b.ts" }],
  });
  const a = mapCodexRolloutLine(
    line({
      type: "item_completed",
      item: {
        type: "AgentMessage",
        id: "m1",
        content: [{ type: "Text", text: "done" }],
      },
    }),
    st,
  );
  assert.deepEqual(a, [
    {
      type: "assistant_text",
      ts: Date.parse("2026-09-05T01:00:00Z"),
      blockId: "m1",
      text: "done",
    },
  ]);
  assert.deepEqual(
    mapCodexRolloutLine(
      line({
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 9,
          },
        },
      }),
      st,
    ),
    [],
  );
  const t = mapCodexRolloutLine(
    line({ type: "task_complete", duration_ms: 1234 }, "2026-09-05T01:00:05Z"),
    st,
  );
  assert.equal(t[0].type, "turn_result");
  assert.deepEqual((t[0] as { usage: unknown; durationMs: number }).usage, {
    input: 60,
    output: 9,
    cacheRead: 40,
    cacheWrite: 0,
  });
  assert.equal((t[0] as { durationMs: number }).durationMs, 1234);
  assert.deepEqual(
    mapCodexRolloutLine(
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
      st,
    ),
    [],
  );
});

test("findClaudeTranscript/findCodexRollout: 파일명과 session_meta 로 찾는다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-mirror-"));
  mkdirSync(join(root, "claude", "-Users-x-proj"), { recursive: true });
  writeFileSync(join(root, "claude", "-Users-x-proj", "abc.jsonl"), "");
  assert.equal(
    findClaudeTranscript(join(root, "claude"), "abc"),
    join(root, "claude", "-Users-x-proj", "abc.jsonl"),
  );
  assert.equal(findClaudeTranscript(join(root, "claude"), "nope"), null);
  const day = join(root, "codex", "2026", "09", "05");
  mkdirSync(day, { recursive: true });
  const f1 = join(day, "rollout-2026-09-05T01-00-00-id-one.jsonl");
  writeFileSync(
    f1,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "id-one", cwd: "/work/a/" },
    }) + "\n",
  );
  const f2 = join(day, "rollout-2026-09-05T02-00-00-id-two.jsonl");
  writeFileSync(
    f2,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "id-two", cwd: "/work/b" },
    }) + "\n",
  );
  assert.equal(
    findCodexRollout(join(root, "codex"), { sessionId: "id-two" }),
    f2,
  );
  assert.equal(findCodexRollout(join(root, "codex"), { cwd: "/work/a" }), f1);
  assert.equal(
    findCodexRollout(join(root, "codex"), { cwd: "/work/zzz" }),
    null,
  );
  // 실제 session_meta 는 base_instructions 때문에 첫 줄이 8KB 를 훌쩍 넘는다(0.149: ~18KB).
  const f3 = join(day, "rollout-2026-09-05T03-00-00-id-three.jsonl");
  writeFileSync(
    f3,
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "id-three",
        cwd: "/work/c",
        base_instructions: { text: "x".repeat(40_000) },
      },
    }) + "\n",
  );
  assert.deepEqual(readCodexRolloutMeta(f3), { sessionId: "id-three", cwd: "/work/c", originator: null });
  assert.equal(findCodexRollout(join(root, "codex"), { cwd: "/work/c" }), f3);
  // 아직 줄바꿈이 없는(쓰는 중인) 파일은 null
  const f4 = join(day, "rollout-2026-09-05T04-00-00-id-four.jsonl");
  writeFileSync(f4, '{"type":"session_meta","payload":{"id":"id-four"');
  assert.equal(readCodexRolloutMeta(f4), null);
  rmSync(root, { recursive: true, force: true });
});

test("TranscriptWatcher: 기존 내용은 건너뛰고 새로 붙는 줄만 이벤트로, 잘린 줄은 다음 폴링에", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-watch-"));
  const file = join(dir, "s.jsonl");
  const mk = (text: string, id: string) =>
    JSON.stringify({
      type: "user",
      uuid: id,
      timestamp: "2026-09-05T01:00:00Z",
      message: { role: "user", content: text },
    });
  writeFileSync(file, mk("old", "u0") + "\n");
  const got: string[] = [];
  const w = new TranscriptWatcher({
    resolveFile: () => file,
    map: mapClaudeTranscriptLine,
    onEvents: (evs) =>
      got.push(...evs.map((e) => (e as { text?: string }).text ?? e.type)),
    skipExisting: true,
    intervalMs: 50,
  });
  w.start();
  await wait(80);
  const l1 = mk("new1", "u1") + "\n";
  appendFileSync(file, l1.slice(0, 20)); // 잘린 조각
  await wait(120);
  assert.deepEqual(got, []);
  appendFileSync(file, l1.slice(20) + mk("new2", "u2") + "\n");
  await wait(150);
  w.stop();
  assert.deepEqual(got, ["new1", "new2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("mapClaudeHookLine/claudeHookSettings: 훅 stdin JSON → 권한 요청·툴 종료·턴 종료", () => {
  const perm = JSON.stringify({
    session_id: "s",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "git push", description: "푸시" },
  });
  assert.deepEqual(mapClaudeHookLine(perm, 5), [
    {
      type: "permission_request",
      ts: 5,
      tool: "Bash",
      input: { command: "git push", description: "푸시" },
    },
    // session_id 가 있으면 지금 세션도 알린다(TUI 안 /resume 추적용)
    { type: "session", ts: 5, sessionId: "s", transcriptPath: null },
  ]);
  assert.deepEqual(
    mapClaudeHookLine(JSON.stringify({ hook_event_name: "Stop", session_id: "s2", transcript_path: "/p/s2.jsonl" }), 6),
    [
      { type: "stop", ts: 6 },
      { type: "session", ts: 6, sessionId: "s2", transcriptPath: "/p/s2.jsonl" },
    ],
  );
  assert.deepEqual(
    mapClaudeHookLine(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "t1",
      }),
      5,
    ),
    [{ type: "tool_done", ts: 5, tool: "Bash", toolUseId: "t1" }],
  );
  assert.deepEqual(
    mapClaudeHookLine(JSON.stringify({ hook_event_name: "Stop" }), 5),
    [{ type: "stop", ts: 5 }],
  );
  assert.deepEqual(
    mapClaudeHookLine(JSON.stringify({ hook_event_name: "SessionStart" })),
    [],
  );
  assert.deepEqual(mapClaudeHookLine("{broken"), []);
  const settings = JSON.parse(claudeHookSettings('cat >> "$LOG"')) as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
  };
  // PostToolUse 는 걸지 않는다 (tool_response 가 로그를 무한히 키운다)
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PermissionRequest", "Stop", "UserPromptSubmit"]);
  assert.equal(shellQuote("/a b/it's.jsonl"), `'/a b/it'\\''s.jsonl'`);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command, 'cat >> "$LOG"');
});
