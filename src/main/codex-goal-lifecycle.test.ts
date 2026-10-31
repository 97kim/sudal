import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager } from "./session-manager";
import { contextUsage, replaySession } from "@shared/session-state";

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await wait(10);
  assert.ok(predicate(), "상태 변경을 제한 시간 안에 확인한다");
}

/** 실제 App Server의 자동 턴·알림 순서를 재현한다. 모델이나 사용자 계정을 호출하지 않는다. */
async function fixture(options: { warmReadMode?: "stale" | "exit" | "release" | "paused"; initializeDelay?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sudal-codex-goals-"));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const script = join(dir, "fake.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const fixtureOptions = ${JSON.stringify(options)};
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const record = value => fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
let goal = null, policy = {};
const started = id => { record({started:id,policy}); send({method:'turn/started',params:{threadId:'parent',turn:{id}}}); };
const completed = id => send({method:'turn/completed',params:{threadId:'parent',turn:{id,status:'completed'}}});
const finishGoal = () => { goal.status='complete'; send({method:'thread/goal/updated',params:{threadId:'parent',goal}}); };
require('node:readline').createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line',line=>{
  const m = JSON.parse(line); if(m.id === undefined || !m.method) return;
  record(m);
  const reply = result => send({id:m.id,result});
  if(m.method === 'initialize' && fixtureOptions.initializeDelay) return setTimeout(()=>reply({}),fixtureOptions.initializeDelay);
  if(m.method === 'thread/start' || m.method === 'thread/resume') { policy=m.params; return reply({thread:{id:'parent'},model:'fixture'}); }
  if(m.method === 'thread/settings/update') {
    if(goal?.objective === 'reject-policy' && m.params.approvalPolicy === 'untrusted') return send({id:m.id,error:{message:'fixture policy rejected'}});
    policy={...policy,...m.params}; return reply({});
  }
  if(m.method === 'thread/goal/set') {
    if(m.params.objective === 'FAIL') return send({id:m.id,error:{message:'fixture goal rejected'}});
    goal={...(goal || {objective:'',status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0}),...m.params};
    send({method:'thread/goal/updated',params:{threadId:'parent',goal}});
    if(m.params.objective === 'late-response') {
      const oldGoal={...goal}; started('goal-1'); finishGoal(); completed('goal-1');
      return setTimeout(()=>reply({goal:oldGoal}),80);
    }
    reply({goal});
    if(m.params.objective) {
      started('goal-1');
      if(m.params.objective === 'complete') setTimeout(()=>{finishGoal(); completed('goal-1');},150);
      if(m.params.objective === 'exit') setTimeout(()=>process.exit(0),150);
      if(m.params.objective === 'exit-between') setTimeout(()=>{completed('goal-1'); setTimeout(()=>process.exit(0),150);},100);
      if(m.params.objective === 'late-status') setTimeout(()=>{completed('goal-1'); setTimeout(finishGoal,100);},100);
      if(m.params.objective === 'policy') setTimeout(()=>{completed('goal-1'); started('goal-2');},250);
      if(m.params.objective === 'continue') setTimeout(()=>{
        completed('goal-1');
        setTimeout(()=>{started('goal-2'); setTimeout(()=>{finishGoal(); completed('goal-2');},100);},150);
      },100);
    }
    return;
  }
  if(m.method === 'thread/goal/get') {
    if(goal === null && fixtureOptions.warmReadMode) {
      goal={objective:'warm fixture',status:fixtureOptions.warmReadMode === 'paused' ? 'paused' : 'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0};
      if(fixtureOptions.warmReadMode === 'paused') return reply({goal});
      const oldGoal={...goal};
      send({method:'thread/goal/updated',params:{threadId:'parent',goal}}); started('warm-goal');
      record({warmReadWaiting:true});
      if(fixtureOptions.warmReadMode === 'exit') return setTimeout(()=>process.exit(0),80);
      if(fixtureOptions.warmReadMode === 'release') return setTimeout(()=>reply({goal:oldGoal}),250);
      finishGoal(); completed('warm-goal');
      return setTimeout(()=>reply({goal:oldGoal}),80);
    }
    return reply({goal});
  }
  if(m.method === 'turn/start') {
    reply({turn:{id:'user-turn'}}); started('user-turn');
    send({method:'thread/tokenUsage/updated',params:{threadId:'parent',tokenUsage:{last:{inputTokens:100,outputTokens:10,cachedInputTokens:0}}}});
    return setTimeout(()=>completed('user-turn'),20);
  }
  if(m.method === 'review/start' || m.method === 'thread/compact/start') {
    const review=m.method === 'review/start'; reply({turn:{id:'native-turn'}}); started('native-turn');
    const item=review ? {type:'exitedReviewMode',id:'review-result',review:'[P1] Fixture review finding'} : {type:'contextCompaction',id:'compact-result'};
    send({method:'item/completed',params:{threadId:'parent',turnId:'native-turn',item}});
    return setTimeout(()=>completed('native-turn'),20);
  }
  if(m.method === 'turn/interrupt') { reply({}); completed('goal-1'); return; }
  reply({});
});
`);
  let executable = script;
  if (process.platform === "win32") {
    executable = join(dir, "codex.cmd");
    writeFileSync(executable, '@echo off\r\nnode "%~dp0\\fake.cjs" %*\r\n');
  } else await chmod(script, 0o755);
  const snapshots: { tabId: string; status: string }[] = [];
  const manager = new SessionManager({ emit() {}, maxConcurrent: 1, onSnapshot(_tabId, snapshot) { snapshots.push(snapshot); },
    resolveConfig: () => ({ provider: "codex", cwd: dir, policy: "full" }),
    codexRuntime: async () => { await wait(30); return { codexPath: executable, env: { ...process.env } as Record<string, string> }; },
    claudeRuntime: async () => { throw new Error("Claude must not be called"); },
  });
  const logs = (): Record<string, any>[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const cleanup = async () => {
    manager.shutdown();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("sudal-codex-goals-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  const send = (tab: string) => manager.send(tab, "queued prompt", [], { type: "user_message", id: tab, ts: Date.now(), text: "queued prompt" });
  return { manager, logs, cleanup, send, snapshots };
}

test("자동 목표 완료 후 같은 탭의 메시지와 다른 탭의 실행 대기열을 모두 진행한다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await manager.codexControl("a", "goal", "complete");
    await until(() => manager.isBusy("a"));
    const result = await send("a");
    assert.equal(result.ok && result.pending, true);
    await send("b");
    assert.equal(manager.snapshot("b").status, "queued");
    await until(() => logs().filter(row => row.method === "turn/start").length === 2 && !manager.isBusy("a") && !manager.isBusy("b"));
    assert.equal(manager.snapshot("a").pendingPrompts.length, 0);
    assert.equal(manager.snapshot("b").status, "idle");
  } finally { await cleanup(); }
});

test("목표를 동시에 시작해도 실행 상한을 지키고 거절된 요청은 서버로 보내지 않는다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    const results = await Promise.allSettled([manager.codexControl("a", "goal", "hold A"), manager.codexControl("b", "goal", "hold B")]);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
    await until(() => manager.isBusy("a"));
    assert.equal(manager.snapshot("b").status, "idle");
    await send("b");
    assert.equal(manager.snapshot("b").status, "queued");
    await assert.rejects(manager.codexControl("b", "goal", "queued goal"));
    assert.equal(logs().filter(row => row.method === "thread/goal/set" && row.params.objective).length, 1);
  } finally { await cleanup(); }
});

test("자동 목표의 턴 사이에도 자리를 유지하고 완료하면 대기 탭을 실행한다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await manager.codexControl("a", "goal", "continue");
    await send("b");
    await until(() => manager.snapshot("a").status === "idle");
    assert.equal(manager.snapshot("a").codexGoal?.status, "active");
    assert.equal(manager.snapshot("b").status, "queued");
    await assert.rejects(manager.codexControl("c", "goal", "hold C"));
    await until(() => manager.snapshot("a").codexGoal?.status === "complete" && logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
  } finally { await cleanup(); }
});

test("목표 시작에 실패하면 예약한 실행 자리를 해제한다", async () => {
  const { manager, cleanup } = await fixture();
  try {
    await assert.rejects(manager.codexControl("a", "goal", "FAIL"), /fixture goal rejected/);
    await manager.codexControl("b", "goal", "hold B");
    await until(() => manager.isBusy("b"));
  } finally { await cleanup(); }
});

test("목표 완료 알림이 턴 종료 뒤에 와도 대기 탭을 진행한다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await manager.codexControl("a", "goal", "late-status");
    await send("b");
    await until(() => manager.snapshot("a").codexGoal?.status === "complete" && logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
  } finally { await cleanup(); }
});

test("늦은 목표 RPC 응답이 최신 완료 알림을 active로 되돌리지 않는다", async () => {
  const { manager, cleanup } = await fixture();
  try {
    const result = await manager.codexControl("a", "goal", "late-response");
    assert.equal(result.goal?.status, "complete");
    assert.equal(manager.snapshot("a").codexGoal?.status, "complete");
    await manager.codexControl("b", "goal", "hold B");
  } finally { await cleanup(); }
});

test("엄격하게 바꾼 권한이 다음 자동 목표 턴의 서버 설정에도 반영된다", async () => {
  const { manager, logs, cleanup } = await fixture();
  try {
    await manager.codexControl("a", "goal", "policy");
    manager.configure("a", { policy: "ask" });
    await until(() => logs().some(row => row.started === "goal-2"));
    const second = logs().find(row => row.started === "goal-2")!;
    assert.equal(second.policy.approvalPolicy, "untrusted");
    assert.equal(second.policy.sandboxPolicy.type, "readOnly");
    assert.equal(second.policy.approvalsReviewer, "user");
  } finally { await cleanup(); }
});

test("서버가 권한 변경을 거절하면 자동 목표를 이전 권한으로 계속 실행하지 않는다", async () => {
  const { manager, cleanup } = await fixture();
  try {
    await manager.codexControl("a", "goal", "reject-policy");
    manager.configure("a", { policy: "ask" });
    await until(() => manager.events("a").some(event => event.type === "error" && event.msg?.key === "session.msg.codexControl.policyUpdateFailed"));
    assert.equal(manager.snapshot("a").codexGoal, null);
    assert.equal(manager.snapshot("a").status, "error");
    await manager.codexControl("b", "goal", "hold B");
  } finally { await cleanup(); }
});

test("네이티브 리뷰의 최종 텍스트를 채팅 기록에 남긴다", async () => {
  const { manager, logs, cleanup } = await fixture();
  try {
    await manager.codexControl("a", "review", "");
    await until(() => logs().some(row => row.method === "review/start") && !manager.isBusy("a"));
    const replay = replaySession(manager.events("a"));
    assert.ok(replay.blocks.some(block => block.kind === "text" && block.text === "[P1] Fixture review finding"));
  } finally { await cleanup(); }
});

test("네이티브 압축 완료 후 경계를 남기고 이전 컨텍스트 게이지를 비운다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await send("a");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("a"));
    assert.equal(contextUsage(replaySession(manager.events("a")))?.used, 100);
    await manager.codexControl("a", "compact", "");
    await until(() => logs().some(row => row.method === "thread/compact/start") && !manager.isBusy("a"));
    const replay = replaySession(manager.events("a"));
    assert.equal(contextUsage(replay), null);
    const marker = replay.blocks.find(block => block.kind === "compacted");
    assert.equal(marker?.kind === "compacted" && marker.trigger, "manual");
    assert.equal(marker?.kind === "compacted" && marker.preTokens, undefined);
  } finally { await cleanup(); }
});

test("실행 중인 목표 탭을 닫으면 다른 탭의 대기열을 진행한다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await manager.codexControl("a", "goal", "hold A");
    await send("b");
    assert.equal(manager.snapshot("b").status, "queued");
    manager.release("a");
    await until(() => logs().filter(row => row.method === "turn/start").length === 1 && !manager.isBusy("b"));
    assert.equal(manager.snapshot("b").status, "idle");
  } finally { await cleanup(); }
});

test("자동 목표의 서버가 종료되면 실행 예약을 해제하고 같은 탭의 대기 지시는 보존한다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await manager.codexControl("a", "goal", "exit");
    await until(() => manager.isBusy("a"));
    const pending = await send("a");
    assert.equal(pending.ok && pending.pending, true);
    await send("b");
    assert.equal(manager.snapshot("b").status, "queued");
    await until(() => manager.snapshot("a").status === "error" && logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
    assert.equal(manager.snapshot("a").codexGoal, null);
    assert.equal(manager.snapshot("a").pendingPrompts.length, 1);
    assert.equal(logs().filter(row => row.method === "turn/start").length, 1);
  } finally { await cleanup(); }
});

test("자동 턴 사이에 서버가 종료돼도 오류를 알리고 다른 탭의 대기열을 진행한다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    await manager.codexControl("a", "goal", "exit-between");
    await send("b");
    await until(() => manager.snapshot("a").status === "idle");
    assert.equal(manager.snapshot("a").codexGoal?.status, "active");
    await until(() => manager.snapshot("a").status === "error" && logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
    assert.equal(manager.snapshot("a").codexGoal, null);
  } finally { await cleanup(); }
});

test("예열의 늦은 목표 조회가 최신 완료 알림을 active로 되돌리지 않는다", async () => {
  const { manager, logs, cleanup, send } = await fixture({ warmReadMode: "stale" });
  try {
    await manager.warm("a");
    assert.equal(manager.snapshot("a").codexGoal?.status, "complete");
    await send("b");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
  } finally { await cleanup(); }
});

test("예열 조회 중 서버가 종료돼도 목표를 되살리거나 실행 자리를 남기지 않는다", async () => {
  const { manager, logs, cleanup, send } = await fixture({ warmReadMode: "exit" });
  try {
    await manager.warm("a");
    assert.equal(manager.snapshot("a").status, "error");
    assert.equal(manager.snapshot("a").codexGoal, null);
    await send("b");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
  } finally { await cleanup(); }
});

test("예열 조회 중 닫은 탭에는 늦은 스냅샷을 보내지 않는다", async () => {
  const { manager, logs, cleanup, snapshots, send } = await fixture({ warmReadMode: "release" });
  try {
    const warming = manager.warm("a");
    await until(() => logs().some(row => row.warmReadWaiting));
    await send("b");
    manager.release("a");
    const before = snapshots.filter(snapshot => snapshot.tabId === "a").length;
    await warming;
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
    assert.equal(snapshots.filter(snapshot => snapshot.tabId === "a").length, before);
  } finally { await cleanup(); }
});

test("예열은 새 알림이 없으면 조회된 일시정지 목표를 정상 복원한다", async () => {
  const { manager, logs, cleanup, send } = await fixture({ warmReadMode: "paused" });
  try {
    await manager.warm("a");
    assert.equal(manager.snapshot("a").codexGoal?.status, "paused");
    await send("b");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
  } finally { await cleanup(); }
});

test("CLI 탐색 중 닫은 탭에서는 목표를 시작하지 않는다", async () => {
  const { manager, logs, cleanup, send } = await fixture();
  try {
    const pending = assert.rejects(manager.codexControl("a", "goal", "closed goal"));
    manager.release("a");
    await pending;
    await send("b");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
    assert.equal(logs().filter(row => row.method === "thread/goal/set").length, 0);
  } finally { await cleanup(); }
});

test("App Server 초기화 중 닫은 탭은 시작 후 정리하고 SDK 폴백을 오염시키지 않는다", async () => {
  const { manager, logs, cleanup, send } = await fixture({ initializeDelay: 150 });
  try {
    const pending = assert.rejects(manager.codexControl("a", "goal", "closed goal"));
    await until(() => logs().some(row => row.method === "initialize"));
    manager.release("a");
    await pending;
    await send("b");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
    assert.equal(logs().filter(row => row.method === "thread/goal/set").length, 0);
    await manager.codexControl("b", "goal", "hold B");
  } finally { await cleanup(); }
});

test("초기화 중 닫았다가 같은 탭을 다시 열어도 이전 연결의 정리가 새 목표를 닫지 않는다", async () => {
  const { manager, logs, cleanup } = await fixture({ initializeDelay: 150 });
  try {
    const old = assert.rejects(manager.codexControl("a", "goal", "old goal"));
    await until(() => logs().some(row => row.method === "initialize"));
    manager.release("a");
    const current = manager.codexControl("a", "goal", "new goal");
    await old;
    await current;
    await until(() => manager.isBusy("a"));
    assert.deepEqual(logs().filter(row => row.method === "thread/goal/set").map(row => row.params.objective), ["new goal"]);
    assert.equal(manager.snapshot("a").codexGoal?.objective, "new goal");
  } finally { await cleanup(); }
});

test("CLI 탐색 중 닫은 탭에서는 늦은 예열도 시작하지 않는다", async () => {
  const { manager, logs, cleanup, send } = await fixture({ warmReadMode: "stale" });
  try {
    const warming = manager.warm("a");
    manager.release("a");
    await warming;
    await send("b");
    await until(() => logs().some(row => row.method === "turn/start") && !manager.isBusy("b"));
    assert.equal(logs().filter(row => row.method === "initialize").length, 1);
    assert.equal(logs().filter(row => row.method === "thread/goal/get").length, 0);
  } finally { await cleanup(); }
});

test("앱 종료 시 아직 초기화 중인 App Server도 정리해 목표를 시작하지 않는다", async () => {
  const { manager, logs, cleanup } = await fixture({ initializeDelay: 150 });
  try {
    const pending = assert.rejects(manager.codexControl("a", "goal", "closed goal"));
    await until(() => logs().some(row => row.method === "initialize"));
    manager.shutdown();
    await pending;
    assert.equal(logs().filter(row => row.method === "thread/goal/set").length, 0);
  } finally { await cleanup(); }
});
