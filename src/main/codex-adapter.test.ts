import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCodexSession, runCodexTurn } from "./codex-adapter";
import { readCodexAgentInput } from "@shared/codex-agents";
import type { ChatEvent } from "@shared/chat-events";

test("Codex 자식 알림은 부모 세션·턴을 바꾸지 않고 부모 턴이 끝난 뒤에도 카드에 전달된다", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sudal-codex-agents-"));
  const script = join(dir, "fake-codex.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const notify = (method, params) => send({method,params});
let n = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'thread/start') return send({id:msg.id,result:{thread:{id:'parent'},model:'fixture'}});
  if (msg.method !== 'turn/start') return send({id:msg.id,result:{}});
  if (msg.params.threadId !== 'parent') return send({id:msg.id,error:{message:'child replaced parent'}});
  const turnId = 'turn-' + (++n);
  send({id:msg.id,result:{turn:{id:turnId}}});
  if (n === 1) {
    notify('item/completed',{threadId:'parent',turnId,item:{type:'collabAgentToolCall',id:'spawn',tool:'spawnAgent',status:'completed',senderThreadId:'parent',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}}}});
    notify('thread/started',{thread:{id:'child',parentThreadId:'parent',source:{subAgent:{thread_spawn:{parent_thread_id:'parent',depth:1}}}}});
  }
  notify('turn/completed',{threadId:'parent',turn:{id:turnId,status:'completed'}});
  if (n === 1) setTimeout(() => {
    notify('item/started',{threadId:'child',turnId:'child-turn',item:{type:'commandExecution',id:'cmd',command:'echo fixture'}});
    notify('item/completed',{threadId:'child',turnId:'child-turn',item:{type:'agentMessage',id:'reply',text:'검토 완료'}});
    notify('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed'}});
  }, 30);
});
`, { mode: 0o755 });
  let codexPath = script;
  if (process.platform === "win32") {
    codexPath = join(dir, "codex.cmd");
    writeFileSync(codexPath, '@echo off\r\nnode "%~dp0\\fake-codex.cjs" %*\r\n');
  }
  const events: ChatEvent[] = [];
  const ambient: ChatEvent[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const request = {
    sessionKey: dir, cwd: dir, sessionId: null, policy: "ask" as const, prompt: "fixture", images: [],
    abort: new AbortController(), onEvent: (event: ChatEvent) => events.push(event),
    onAmbientEvent: (event: ChatEvent) => {
      ambient.push(event);
      if (event.type === "tool_use" && readCodexAgentInput(event.input)?.agents[0].status === "completed") finish();
    },
  };
  try {
    const runtime = { codexPath, env: { ...process.env } as Record<string, string> };
    await runCodexTurn(runtime, request);
    await finished;
    assert.ok(ambient.some((e) => e.type === "subagent_activity" && e.parentToolUseId === "spawn" && e.tool === "Bash"));
    assert.ok(ambient.some((e) => e.type === "subagent_activity" && e.text === "검토 완료"));
    assert.equal(ambient.filter((e) => e.type === "turn_result").length, 0);
    await runCodexTurn(runtime, { ...request, sessionId: "parent" });
    assert.equal(events.filter((e) => e.type === "turn_result").length, 2);
  } finally {
    closeCodexSession(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
