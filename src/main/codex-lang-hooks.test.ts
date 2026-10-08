import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN_SCRIPT, shellQuote } from "./codex-lang-hooks";

test("shellQuote: 공백·작은따옴표·$ 가 든 경로도 셸에서 그대로 한 인자다", () => {
  for (const p of ["/Users/a/Library/Application Support/Sudal/codex-hooks/x.sh", "/tmp/it's here/x.sh", "/tmp/$(touch pwned)/`id`/x.sh"]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(p)}`], { encoding: "utf8" }), p);
  }
});

test("WIN_SCRIPT: sh 스크립트와 같게 — 프롬프트면 user-prompt.json, 아니면 세션의 pending 을 한 번 내보내고 지운다", () => {
  const d = mkdtempSync(join(tmpdir(), "lang-hook-"));
  mkdirSync(join(d, "pending"));
  const script = join(d, "lang-reminder.cjs");
  writeFileSync(script, WIN_SCRIPT);
  writeFileSync(join(d, "user-prompt.json"), "UP");
  writeFileSync(join(d, "pending", "abc-1.json"), "PT");
  const run = (input: unknown) => execFileSync(process.execPath, [script], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run({ hook_event_name: "UserPromptSubmit", session_id: "abc-1" }), "UP");
  assert.equal(run({ hook_event_name: "PostToolUse", session_id: "abc-1", tool_response: '"session_id":"zzz"' }), "PT");
  assert.equal(existsSync(join(d, "pending", "abc-1.json")), false);
  assert.equal(run({ hook_event_name: "PostToolUse", session_id: "abc-1" }), "");
  assert.equal(run({ hook_event_name: "PostToolUse", session_id: "../x" }), "");
});
