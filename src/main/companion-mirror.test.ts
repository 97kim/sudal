import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentActivityEvent } from "@shared/chat-events";
import { CompanionMirror, findCompanionRollout, rolloutToSubagentActivity } from "./companion-mirror";

const meta = (id: string, cwd: string, originator = "codex-companion") => JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, cwd, originator } }) + "\n";
const item = (it: Record<string, unknown>) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "item_completed", item: it } }) + "\n";
const mkRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "codex-root-"));
  const day = join(root, "2026", "09", "11");
  mkdirSync(day, { recursive: true });
  return { root, day };
};

test("findCompanionRollout: cwd 일치 + since 이후 + 앱 자신(originator sudal)·제외 id 는 건너뜀", () => {
  const { root, day } = mkRoot();
  const cwd = "/repo/x";
  const old = join(day, "rollout-old.jsonl");
  writeFileSync(old, meta("s-old", cwd));
  const past = (Date.now() - 60_000) / 1000;
  utimesSync(old, past, past);
  const since = Date.now() - 5000;
  writeFileSync(join(day, "rollout-other-cwd.jsonl"), meta("s-other", "/repo/y"));
  writeFileSync(join(day, "rollout-own.jsonl"), meta("s-own", cwd, "sudal"));
  writeFileSync(join(day, "rollout-excluded.jsonl"), meta("s-ex", cwd));
  assert.equal(findCompanionRollout(root, { cwd, since, exclude: new Set(["s-ex"]) }), null, "후보가 전부 걸러지면 null");
  const good = join(day, "rollout-good.jsonl");
  writeFileSync(good, meta("s-good", cwd));
  assert.equal(findCompanionRollout(root, { cwd: cwd + "/", since, exclude: new Set(["s-ex"]) }), good);
});

test("rolloutToSubagentActivity: 명령·패치·말만, via codex", () => {
  const acts = rolloutToSubagentActivity(
    [
      { type: "user_message", ts: 1, id: "u", text: "해줘" },
      { type: "tool_use", ts: 2, toolUseId: "c1", name: "Bash", input: { command: "yarn test" } },
      { type: "tool_result", ts: 3, toolUseId: "c1", output: "ok", isError: false },
      { type: "tool_use", ts: 4, toolUseId: "p1", name: "ApplyPatch", input: { changes: [{ kind: "update", path: "src/a.ts" }, { kind: "add", path: "src/b.ts" }] } },
      { type: "assistant_text", ts: 5, blockId: "a", text: "첫 줄\n마지막 줄\n```\n" },
    ],
    "tool-1",
    99,
  );
  assert.deepEqual(acts, [
    { type: "subagent_activity", ts: 99, parentToolUseId: "tool-1", tool: "Bash", input: { command: "yarn test" }, via: "codex" },
    { type: "subagent_activity", ts: 99, parentToolUseId: "tool-1", tool: "ApplyPatch", input: { path: "src/a.ts, src/b.ts" }, via: "codex" },
    { type: "subagent_activity", ts: 99, parentToolUseId: "tool-1", text: "마지막 줄", via: "codex" },
  ]);
});

test("CompanionMirror: 나중에 생긴 rollout 을 잡아 새 줄을 활동으로 흘리고 stop 하면 멈춘다", async () => {
  const { root, day } = mkRoot();
  const cwd = "/repo/z";
  const got: SubagentActivityEvent[] = [];
  const m = new CompanionMirror({ codexRoot: root, cwd, since: Date.now() - 1000, parentToolUseId: "skill-1", excludeSessionIds: () => new Set(), onEvents: (e) => got.push(...e), pollMs: 60, rootPid: null });
  m.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(m.file(), null);
  const file = join(day, "rollout-live.jsonl");
  writeFileSync(file, meta("s-live", cwd) + item({ type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "ls -la"], status: "completed", exit_code: 0 }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(m.file(), file);
  assert.deepEqual(got.map((e) => e.tool ?? e.text), ["Bash"]);
  appendFileSync(file, item({ type: "AgentMessage", id: "a1", content: [{ type: "text", text: "고쳤습니다" }] }));
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(got.map((e) => e.tool ?? e.text), ["Bash", "고쳤습니다"]);
  m.stop();
  appendFileSync(file, item({ type: "AgentMessage", id: "a2", content: [{ type: "text", text: "더" }] }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got.length, 2);
});
