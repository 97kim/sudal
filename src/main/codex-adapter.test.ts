import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCodexSession, runCodexTurn, currentCodexBackgroundJobs, onCodexBackgroundJobsChanged, setCodexSessionIdleMs, CODEX_SESSION_IDLE_MS } from "./codex-adapter";
import type { BackgroundJobDto } from "@shared/background-jobs";
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
    const other = {type:'collabAgentToolCall',id:'spawn-other',tool:'spawnAgent',status:'completed',senderThreadId:'parent',receiverThreadIds:['other'],agentsStates:{other:{status:'running'}}};
    notify('item/completed',{threadId:'parent',turnId,item:other});
    notify('item/completed',{threadId:'parent',turnId,item:other});
    notify('thread/started',{thread:{id:'child',parentThreadId:'parent',source:{subAgent:{thread_spawn:{parent_thread_id:'parent',depth:1}}}}});
  }
  if (n > 1) {
    const item = {type:'collabAgentToolCall',id:'spawn-'+n,tool:'spawnAgent',status:'completed',senderThreadId:'parent',receiverThreadIds:['child-'+n],agentsStates:{['child-'+n]:{status:'pendingInit'}}};
    notify('item/completed',{threadId:'parent',turnId,item});
    if (n < 5) notify('item/completed',{threadId:'parent',turnId,item:{...item,id:'wait-'+n,tool:'wait',agentsStates:{['child-'+n]:{status:['interrupted','errored','shutdown'][n-2]}}}});
  }
  notify('turn/completed',{threadId:'parent',turn:{id:turnId,status:'completed'}});
  if (n === 1) setTimeout(() => {
    notify('item/started',{threadId:'child',turnId:'child-turn',item:{type:'commandExecution',id:'cmd',command:'echo fixture'}});
    notify('item/completed',{threadId:'child',turnId:'child-turn',item:{type:'agentMessage',id:'reply',text:'검토 완료'}});
    notify('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed'}});
    notify('item/completed',{threadId:'parent',turnId,item:{type:'subAgentActivity',id:'other-finished',agentThreadId:'other',agentPath:'/other',kind:'completed'}});
  }, 200);
});
`, { mode: 0o755 });
  let codexPath = script;
  if (process.platform === "win32") {
    codexPath = join(dir, "codex.cmd");
    writeFileSync(codexPath, '@echo off\r\nnode "%~dp0\\fake-codex.cjs" %*\r\n');
  }
  const events: ChatEvent[] = [];
  const ambient: ChatEvent[] = [];
  const jobSnapshots: BackgroundJobDto[][] = [];
  const offJobs = onCodexBackgroundJobsChanged(() => {
    const jobs = currentCodexBackgroundJobs();
    jobSnapshots.push(jobs);
    if (jobs.length === 0 && jobSnapshots.some((snapshot) => snapshot.length === 2)) finish();
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const request = {
    sessionKey: dir, cwd: dir, sessionId: null, policy: "ask" as const, prompt: "fixture", images: [],
    abort: new AbortController(), onEvent: (event: ChatEvent) => events.push(event),
    onAmbientEvent: (event: ChatEvent) => {
      ambient.push(event);
    },
  };
  setCodexSessionIdleMs(50);
  try {
    const runtime = { codexPath, env: { ...process.env } as Record<string, string> };
    await runCodexTurn(runtime, request);
    await finished;
    const runningJobs = jobSnapshots.find((jobs) => jobs.length === 2);
    assert.equal(runningJobs?.length, 2, "여러 에이전트를 합치고 중복 알림은 중복 작업으로 표시하지 않는다");
    assert.equal(runningJobs?.[0].sessionId, "parent", "부모 대화 입력창 위에 표시한다");
    assert.equal(runningJobs?.[0].label, "Codex");
    assert.equal(runningJobs?.[0].status, "running", "생성 호출이 끝나도 하위 작업은 유지한다");
    assert.deepEqual(currentCodexBackgroundJobs(), [], "자식 완료 뒤에는 표시를 지운다");
    assert.ok(ambient.some((e) => e.type === "subagent_activity" && e.parentToolUseId === "spawn" && e.tool === "Bash"));
    assert.ok(ambient.some((e) => e.type === "subagent_activity" && e.text === "검토 완료"));
    assert.equal(ambient.filter((e) => e.type === "turn_result").length, 0);
    for (let n = 2; n <= 4; n++) {
      await runCodexTurn(runtime, { ...request, sessionId: "parent" });
      assert.deepEqual(currentCodexBackgroundJobs(), [], "중단·오류·종료도 작업 줄을 지운다");
      assert.ok(jobSnapshots.some((jobs) => jobs.some((job) => job.toolUseId === `spawn-${n}` && job.status === "queued")));
    }
    await runCodexTurn(runtime, { ...request, sessionId: "parent" });
    const pending = currentCodexBackgroundJobs();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolUseId, "spawn-5");
    assert.equal(currentCodexBackgroundJobs()[0].startedAt, pending[0].startedAt, "경과 시간 시작점을 유지한다");
    assert.equal(events.filter((e) => e.type === "turn_result").length, 5);
    closeCodexSession(dir);
    assert.deepEqual(currentCodexBackgroundJobs(), [], "세션을 닫으면 실행 중 표시도 정리한다");
    assert.ok(ambient.some((event) => event.type === "tool_result" && event.toolUseId === "spawn-5" && event.isError), "closing the process also closes the running card");
    assert.deepEqual(jobSnapshots.at(-1), [], "정리된 목록을 구독자에게 알린다");
  } finally {
    closeCodexSession(dir);
    offJobs();
    setCodexSessionIdleMs(CODEX_SESSION_IDLE_MS);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
