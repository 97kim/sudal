import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionConfig } from "./session-manager";
import { parseGoalAction } from "@shared/codex-controls";
import { codexControlError, executeCodexControl, redactCodexControlData } from "./codex-controls";

test("goal 상태·예산 변경은 목표를 덮어쓰지 않고, 잘못된 예산·긴 목표를 거부한다", () => {
  assert.deepEqual(parseGoalAction("pause"), { action: "set", status: "paused" });
  assert.deepEqual(parseGoalAction("resume"), { action: "set", status: "active" });
  assert.deepEqual(parseGoalAction("budget 40000"), { action: "set", tokenBudget: 40000 });
  for (const value of ["budget 0", "budget -1", "budget 1.5", "budget 9007199254740992"]) assert.throws(() => parseGoalAction(value));
  assert.throws(() => parseGoalAction("a".repeat(4001)));
});

test("MCP는 다음 페이지까지 Codex 연결에서 읽는다", async () => {
  const cursors: unknown[] = [];
  const client = { async request<T>(_method: string, params: Record<string, unknown>) {
    cursors.push(params.cursor);
    assert.equal(params.threadId, "parent");
    return { data: [params.cursor ? "second" : "first"], nextCursor: params.cursor ? null : "next" } as T;
  } };
  assert.deepEqual(await executeCodexControl(client, { threadId: "parent", cwd: tmpdir(), model: "fixture" }, "mcp", ""), { data: ["first", "second"] });
  assert.deepEqual(cursors, [null, "next"]);
});

test("백그라운드 터미널의 다음 페이지를 누락하지 않는다", async () => {
  const cursors: unknown[] = [];
  const client = { async request<T>(method: string, params: Record<string, unknown>) {
    assert.equal(method, "thread/backgroundTerminals/list");
    cursors.push(params.cursor);
    return { data: [params.cursor ? { processId: "second" } : { processId: "first" }], nextCursor: params.cursor ? null : "next" } as T;
  } };
  const result = await executeCodexControl(client, { threadId: "parent", cwd: tmpdir(), model: "fixture" }, "ps", "");
  assert.deepEqual(result.data, { data: [{ processId: "first" }, { processId: "second" }] });
  assert.deepEqual(cursors, [null, "next"]);
});

test("설정 변경·중단은 native 성공 응답 후 확인 가능한 상태를 반환한다", async () => {
  const methods: string[] = [];
  const client = { async request<T>(method: string) { methods.push(method); return {} as T; } };
  const ctx = { threadId: "parent", cwd: tmpdir(), model: "fixture" };
  assert.deepEqual(await executeCodexControl(client, ctx, "memories", "off"), { data: { mode: "disabled" } });
  assert.deepEqual(await executeCodexControl(client, ctx, "stop", ""), { data: { stopped: true } });
  assert.deepEqual(methods, ["thread/memoryMode/set", "thread/backgroundTerminals/clean"]);
  await assert.rejects(executeCodexControl({ async request() { throw new Error("rejected"); } }, ctx, "stop", ""));
});

test("설정 진단은 중첩 인증 값과 환경 변수를 숨긴다", () => {
  assert.deepEqual(redactCodexControlData({model:"fixture",providers:{key:{api_key:"secret",env:{CUSTOM:"secret"}}}}),{model:"fixture",providers:{key:{api_key:"••••",env:"••••"}}});
  assert.deepEqual(redactCodexControlData({shell_environment_policy:{inherit:"all",set:{CUSTOM_VALUE:"secret"}},http_headers:{"X-Key":"secret"}}),{shell_environment_policy:{inherit:"all",set:"••••"},http_headers:"••••"});
});

test("구형 CLI의 미지원 API만 업데이트 안내로 바꾸고 다른 오류는 보존한다", () => {
  assert.match((codexControlError(new Error('unknown variant thread/goal/set')) as Error).message,/업데이트/);
  const denied = new Error('permission denied');
  assert.equal(codexControlError(denied),denied);
});

test("Codex 제어는 모델 호출 없이 상태를 저장하고, 다음 턴·압축·리뷰에 실제 프로토콜을 쓴다", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sudal-codex-controls-"));
  const script = join(dir, "fake.cjs");
  const log = join(dir, "requests.jsonl");
  writeFileSync(script, `
const fs = require('node:fs');
const send = data => process.stdout.write(JSON.stringify(data)+'\\n');
let goal = null;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
  if (m.id === 'goal-question') {
    if (m.result?.answers?.q1?.answers?.[0] !== 'A') throw new Error('Question answer not mapped by id');
    goal = {...goal,status:'complete'};
    send({method:'thread/goal/updated',params:{threadId:'parent',goal}});
    send({method:'item/completed',params:{threadId:'parent',turnId:'goal-turn',item:{type:'agentMessage',id:'goal-answer',text:'fixture goal completed'}}});
    send({method:'turn/completed',params:{threadId:'parent',turn:{id:'goal-turn',status:'completed'}}});
    return;
  }
  if (!m.method) return;
  const reply = result => send({id:m.id,result});
  if (m.method === 'thread/start' || m.method === 'thread/resume') return reply({thread:{id:'parent'},model:'fixture'});
  if (m.method === 'thread/goal/set') {
    if (m.params.origin !== 'user') return send({id:m.id,error:{message:'missing user authorization'}});
    if (m.params.objective === 'FAIL') return send({id:m.id,error:{message:'fixture rejection'}});
    goal = {...(goal || {objective:'',status:'active',tokenBudget:null,tokensUsed:7,timeUsedSeconds:1}), ...m.params};
    send({method:'thread/goal/updated',params:{threadId:'parent',goal}});
    reply({goal});
    if (m.params.objective === 'Auto fixture' || m.params.objective === 'Auto wait') {
      send({method:'turn/started',params:{threadId:'parent',turn:{id:'goal-turn'}}});
      if (m.params.objective === 'Auto fixture') send({id:'goal-question',method:'item/tool/requestUserInput',params:{threadId:'parent',turnId:'goal-turn',itemId:'question',questions:[{id:'q1',header:'Path',question:'Which path?',isOther:true,isSecret:false,options:[{label:'A',description:'fixture option'}]}]}});
    }
    return;
  }
  if (m.method === 'turn/interrupt') { reply({}); send({method:'turn/completed',params:{threadId:'parent',turn:{id:'goal-turn',status:'interrupted'}}}); return; }
  if (m.method === 'thread/goal/get') return reply({goal});
  if (m.method === 'thread/goal/clear') { goal = null; return reply({}); }
  if (m.method === 'turn/start' || m.method === 'thread/compact/start' || m.method === 'review/start') {
    reply({turn:{id:'turn'}});
    send({method:'turn/started',params:{threadId:'parent',turn:{id:'turn'}}});
    return setTimeout(() => send({method:'turn/completed',params:{threadId:'parent',turn:{id:'turn',status:'completed'}}}),20);
  }
  reply({});
});
`);
  let executable = script;
  if (process.platform === "win32") {
    executable = join(dir, "codex.cmd");
    writeFileSync(executable, '@echo off\r\nnode "%~dp0\\fake.cjs" %*\r\n');
  } else { await (await import("node:fs/promises")).chmod(script, 0o755); writeFileSync(script, '#!/usr/bin/env node\n' + readFileSync(script, "utf8")); }
  let persisted: SessionConfig = { provider: "codex", cwd: dir, policy: "ask" };
  const manager = new SessionManager({ emit() {}, maxConcurrent: 1, resolveConfig: () => persisted,
    onMeta(_tab, patch) { persisted = { ...persisted, ...patch }; },
    codexRuntime: async () => ({ codexPath: executable, env: { ...process.env } as Record<string,string> }),
    claudeRuntime: async () => { throw new Error("Claude must not be called"); },
  });
  const idle = async () => { const until = Date.now() + 4000; while (manager.isBusy("tab") && Date.now() < until) await new Promise(r=>setTimeout(r,10)); assert.equal(manager.isBusy("tab"), false); };
  const requests = () => readFileSync(log, "utf8").trim().split("\n").map(line=>JSON.parse(line));
  try {
    await manager.codexControl("tab", "plan", "on");
    assert.equal(manager.snapshot("tab").codexMode, "plan");
    assert.equal(persisted.codexMode, "plan");
    await manager.codexControl("tab", "goal", "Finish tests");
    await manager.codexControl("tab", "goal", "pause");
    await manager.codexControl("tab", "goal", "budget 40000");
    assert.equal(manager.snapshot("tab").codexGoal?.objective, "Finish tests");
    assert.equal(manager.snapshot("tab").codexGoal?.tokensUsed, 7);
    await assert.rejects(manager.codexControl("tab", "goal", "FAIL"));
    assert.equal(manager.snapshot("tab").codexGoal?.objective, "Finish tests");
    assert.equal(requests().filter(r=>r.method==='turn/start').length,0);
    await manager.send("tab", "fixture prompt", [], {type:"user_message",ts:Date.now(),id:"u",text:"fixture prompt"});
    await idle();
    const turn = requests().find(r=>r.method==='turn/start');
    assert.equal(turn.params.collaborationMode.mode,"plan");
    assert.equal(turn.params.collaborationMode.settings.model,"fixture");
    assert.equal(turn.params.collaborationMode.settings.developer_instructions,null);
    await manager.codexControl("tab", "compact", ""); await idle();
    await manager.codexControl("tab", "review", ""); await idle();
    assert.equal(requests().filter(r=>r.method==='turn/start').length,1);
    assert.equal(requests().find(r=>r.method==='thread/compact/start').params.threadId,'parent');
    assert.deepEqual(requests().find(r=>r.method==='review/start').params.target,{type:'uncommittedChanges'});
    manager.configure('tab',{policy:'full'});
    const usersBeforeGoal = manager.events('tab').filter(e=>e.type==='user_message').length;
    await manager.codexControl('tab','goal','Auto fixture');
    const questionDeadline = Date.now()+3000;
    while (manager.snapshot('tab').status !== 'waiting_permission' && Date.now()<questionDeadline) await new Promise(r=>setTimeout(r,10));
    const question = [...manager.events('tab')].reverse().find(e=>e.type==='permission_request');
    assert.equal(question?.type,'permission_request','full 권한에서도 질문에 자동 응답하지 않는다');
    if (question?.type !== 'permission_request') throw new Error('missing question');
    assert.equal(question.tool,'AskUserQuestion');
    manager.answerPermission('tab',question.requestId,{behavior:'allow',answers:{q1:'A'}});
    await idle();
    assert.equal(manager.snapshot('tab').codexGoal?.status,'complete');
    assert.ok(manager.events('tab').some(e=>e.type==='assistant_text' && e.text==='fixture goal completed'));
    assert.equal(manager.events('tab').filter(e=>e.type==='user_message').length,usersBeforeGoal,'자동 goal에 중복 프롬프트를 보내지 않는다');
    await manager.codexControl('tab','goal','Auto wait');
    await new Promise(r=>setTimeout(r,20));
    assert.equal(manager.isBusy('tab'),true);
    await assert.rejects(manager.codexControl('other','goal','Another goal'),/끝난 뒤/,'새 목표도 동시 실행 상한을 우회하지 않는다');
    assert.equal(manager.abort('tab'),true);
    await new Promise(r=>setTimeout(r,60));
    assert.equal(manager.snapshot('tab').codexGoal?.status,'paused');
    assert.ok(requests().some(r=>r.method==='turn/interrupt'));
    await manager.codexControl("tab", "goal", "clear");
    assert.equal(manager.snapshot("tab").codexGoal,null);
    assert.equal(manager.snapshot("tab").sessionId,'parent','압축 후에도 같은 Codex 스레드를 쓴다');
    await manager.codexControl("tab", "plan", "off");
    assert.equal(manager.snapshot("tab").codexMode,'default');
    manager.release("tab");
    assert.equal(manager.snapshot("tab").codexMode,'default','저장된 설정을 복원한다');
  } finally { manager.shutdown(); await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50}); }
});
