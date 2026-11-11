import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentParents, reduceSessionAgents, type SessionAgent } from './session-agents';
import type { TabMeta } from './workspace-model';

test('내부 호출은 상태 갱신에도 한 행이며 Codex 호출 완료와 작업 완료를 구분한다', () => {
  let rows: SessionAgent[] = [];
  for (const status of ['running', 'completed']) {
    rows = reduceSessionAgents(rows, {type:'tool_use', ts:1, toolUseId:'spawn', name:'Agent', input:{codexAgent:true, description:'리뷰', operation:'spawnAgent', agents:[{id:'child',status}]}}, 'codex');
    rows = reduceSessionAgents(rows, {type:'tool_result',ts:2,toolUseId:'spawn',output:'',isError:false}, 'codex');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, status === 'running' ? 'running' : 'done');
    assert.equal(rows[0].blockId, 'spawn');
  }
});
test('Claude와 Antigravity 호출의 제목·제공자·실패를 보존한다', () => {
  for (const provider of ['claude','agy'] as const) {
    let rows = reduceSessionAgents([], {type:'tool_use',ts:1,toolUseId:'a',name:'Agent',input:{description:'검토'}}, provider);
    rows = reduceSessionAgents(rows, {type:'tool_result',ts:2,toolUseId:'a',output:'failure',isError:true}, provider);
    assert.equal(rows[0].provider,provider);
    assert.equal(rows[0].status,'failed');
    assert.equal(rows[0].title,'검토');
  }
});
test('리뷰 상태 갱신이 작업자 탭을 중복 생성하지 않는다', () => {
  let rows = reduceSessionAgents([], {type:'review',ts:1,reviewer:'agy',reviewTabId:'b',status:'requested',text:''},'codex');
  rows = reduceSessionAgents(rows, {type:'review',ts:2,reviewer:'agy',reviewTabId:'b',status:'done',text:'large response'},'codex');
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'done');
  assert.equal(JSON.stringify(rows).includes('large response'),false);
});
test('부모가 없거나 다른 워크스페이스면 숨기지 않고 순환 관계도 차단한다', () => {
  const tabs = ['a','b','c'].map(id => ({id,workspaceId:id==='c'?'other':'ws'} as TabMeta));
  const row = (tabId:string):SessionAgent => ({id:tabId,tabId,provider:'codex',title:'',status:'done',kind:'worker',blockId:''});
  assert.deepEqual([...agentParents(tabs,{a:[row('b'),row('c'),row('missing')],b:[row('a')]})], [['b','a']]);
  assert.equal(agentParents(tabs.slice(1),{a:[row('b')]}).size,0);
});
test('백그라운드 호출 반환은 완료가 아니며 실제 종료 신호가 우선한다', () => {
  let rows = reduceSessionAgents([], {type:'tool_use',ts:1,toolUseId:'a',name:'Agent',input:{run_in_background:true}},'claude');
  rows = reduceSessionAgents(rows,{type:'tool_result',ts:2,toolUseId:'a',output:'launched',isError:false},'claude');
  assert.equal(rows[0].status,'unknown');
  rows = reduceSessionAgents(rows,{type:'agent_status',ts:3,agentId:'bg',toolUseId:'a',provider:'claude',title:'리뷰',status:'running'},'claude');
  rows = reduceSessionAgents(rows,{type:'tool_result',ts:4,toolUseId:'a',output:'launched',isError:false},'claude');
  assert.equal(rows[0].status,'running');
  rows = reduceSessionAgents(rows,{type:'agent_status',ts:5,agentId:'bg',toolUseId:'a',provider:'claude',title:'리뷰',status:'done'},'claude');
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'done');
});
test('작업자 종료 결과가 idle 실행 상태보다 우선한다', () => {
  const rows=reduceSessionAgents([], {type:'orchestration',ts:1,runId:'run',revision:1,objective:'test',status:'active',coordinator:'tab',tasks:[{id:'task',seq:1,spec:'review',status:'succeeded',tabId:'child',provider:'claude',execution:'idle',summary:null}],questions:0,escalations:0,notes:0},'codex');
  assert.equal(rows[0].status,'done');
});

test('도구 ID가 늦게 도착하면 작업 ID로 만든 임시 행과 병합한다', () => {
  const tool = {type:'tool_use' as const,ts:1,toolUseId:'tool',name:'Agent',input:{description:'review',run_in_background:true}};
  const snapshot = {type:'agent_status' as const,ts:2,agentId:'bg',provider:'claude' as const,title:'review',status:'running' as const};
  for (const events of [[tool,snapshot],[snapshot,tool]]) {
    let rows: SessionAgent[] = [];
    for (const event of events) rows=reduceSessionAgents(rows,event,'claude');
    rows=reduceSessionAgents(rows,{...snapshot,ts:3,toolUseId:'tool'},'claude');
    assert.equal(rows.length,1);
    assert.equal(rows[0].id,'tool:tool');
    assert.equal(rows[0].backgroundId,'bg');
    rows=reduceSessionAgents(rows,{...snapshot,ts:4,toolUseId:'tool',status:'done'},'claude');
    assert.equal(rows.length,1);
    assert.equal(rows[0].status,'done');
  }
});
