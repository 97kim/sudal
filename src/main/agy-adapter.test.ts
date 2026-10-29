import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "@shared/chat-events";
import { closeAgySession, runAgyTurn, warmAgySession } from "./agy-adapter";

// 모델을 호출하지 않고 실제 stdin/stdout 수명주기를 검사하는 CLI fixture.
test("프로세스 재사용·예열·재개에서 대화 ID와 턴별 사용량을 보존한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sudal-agy-"));
  const script = join(dir, "fake-agy.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.AGY_TEST_START_FILE, 'start\\n');
const resumed = process.argv.includes('--conversation');
let n = resumed ? 10 : 0;
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
emit({event:'init',conversation_id:'fixture-session'});
readline.createInterface({input:process.stdin}).on('line', line => {
  JSON.parse(line);
  n++;
  emit({event:'step_update',step_update:{step_index:n,state:'DONE',step_type:'agent_response',text_delta:'ok',usage:{input_tokens:1000,cache_read_tokens:400,output_tokens:30,thinking_tokens:20}}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'fixture-session',usage:{input_tokens:n*1000,cache_read_tokens:n*400,output_tokens:n*30,thinking_tokens:n*20},duration_seconds:n,num_turns:n}});
});
`, { mode: 0o755 });
  let agyPath = script;
  if (process.platform === "win32") {
    agyPath = join(dir, "agy.cmd");
    writeFileSync(agyPath, '@echo off\r\nnode "%~dp0\\fake-agy.cjs" %*\r\n');
  }
  const marker = join(dir, "started");
  const runtime = { agyPath, env: { ...process.env, AGY_TEST_START_FILE: marker } };
  const key = dir;
  const events: ChatEvent[] = [];
  const request = { sessionKey: key, cwd: dir, sessionId: null, policy: "ask" as const, prompt: "fixture", abort: new AbortController(), onEvent: (e: ChatEvent) => events.push(e) };
  try {
    await assert.rejects(runAgyTurn(runtime, { ...request, images: [{ name: "test.png", mime: "image/png", base64: "AAAA" }] }), /Antigravity/);
    assert.equal(existsSync(marker), false, "잘못된 이미지는 CLI를 시작하지 않는다");
    await warmAgySession(runtime, request);
    await runAgyTurn(runtime, request);
    await runAgyTurn(runtime, { ...request, sessionId: "fixture-session" });
    closeAgySession(key);
    await runAgyTurn(runtime, { ...request, sessionId: "fixture-session" });
    const results = events.filter(e => e.type === "turn_result");
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.deepEqual(result.usage, { input: 600, output: 30, cacheRead: 400, cacheWrite: 0 });
      assert.equal(result.numTurns, 1);
    }
    assert.ok(events.some(e => e.type === "session" && e.sessionId === "fixture-session"));
    assert.ok(events.some(e => e.type === "notice" && e.msg?.key === "session.msg.agyHeadlessPermissions"));
  } finally {
    closeAgySession(key);
    // Windows에서 자식 프로세스가 아직 파일을 열고 있을 수 있다.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
