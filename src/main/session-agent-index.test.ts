import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionAgentIndex } from './session-agent-index';
import type { ChatEvent } from '@shared/chat-events';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './persistence';
const start: ChatEvent = {type:'tool_use',ts:1,toolUseId:'agent',name:'Agent',input:{description:'리뷰'}};
const done: ChatEvent = {type:'tool_result',ts:2,toolUseId:'agent',output:'done',isError:false};
test('복원은 완료 상태를 보존하고 과거 실행 중 상태를 미확인으로 표시한다', async () => {
  const index = new SessionAgentIndex(()=>{});
  await index.restore('a',()=>[start,done],'claude');
  await index.restore('b',()=>[start],'claude');
  assert.equal(index.snapshot().a[0].status,'done');
  assert.equal(index.snapshot().b[0].status,'unknown');
});
test('기록 복원 도중 도착한 결과와 대화 비우기가 오래된 기록보다 우선한다', async () => {
  const index = new SessionAgentIndex(()=>{});
  const history = [start,...Array.from({length:130},():ChatEvent=>({type:'text_delta',ts:1,blockId:'text',text:'x'}))];
  const restoring = index.restore('a',()=>history,'claude');
  index.observe('a',done,'claude');
  await restoring;
  assert.equal(index.snapshot().a[0].status,'done');
  const reset = index.restore('b',()=>history,'claude');
  index.reset('b');
  await reset;
  assert.equal(index.snapshot().b,undefined);
});

test('프로세스 오류·사용자 중단 후에도 작업 중 표시를 남기지 않는다', async () => {
  for (const event of [
    {type:'error',ts:2,message:'provider exited',fatal:true},
    {type:'error',ts:2,message:'interrupted',fatal:false,msg:{key:'session.msg.interrupted'}},
  ] as ChatEvent[]) {
    const index = new SessionAgentIndex(()=>{});
    index.observe('a',start,'agy');
    index.observe('a',event,'agy');
    assert.equal(index.snapshot().a[0].status,'unknown');
    const replay = new SessionAgentIndex(()=>{});
    await replay.restore('a',()=>[start,event],'agy');
    assert.equal(replay.snapshot().a[0].status,'unknown');
  }
});

test('변경 없는 기록은 캐시만 읽고, 실시간 추가분은 재파싱 없이 캐시를 갱신한다', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sudal-agent-cache-'));
  const store=new Store(dir);
  const make=()=>new SessionAgentIndex(()=>{}, {load:id=>store.loadAgentCache(id),save:(id,data)=>store.saveAgentCache(id,data)});
  try {
    store.appendEvent('a',start);store.flush();
    const first=make();first.prepare(['a']);
    let reads=0;
    await first.restore('a',()=>{reads++;return store.iterateEvents('a');},'claude');
    assert.equal(reads,1);
    store.onAgentEvent=(id,e)=>first.observe(id,e,'claude');
    store.onAgentFlush=id=>first.persist(id);
    store.appendEvent('a',done);store.flush();
    const warm=make();
    await warm.restore('a',()=>{throw Error('unchanged history was read');},'claude');
    assert.equal(warm.snapshot().a[0].status,'done');
    appendFileSync(store.threadPath('a'), JSON.stringify({...start,toolUseId:'other'})+'\n');
    const modified=make();
    await modified.restore('a',()=>{reads++;return store.iterateEvents('a');},'claude');
    assert.equal(reads,2);
    assert.equal(modified.snapshot().a.length,2);
    writeFileSync(join(dir,'threads','a.agents.json'),'{broken');
    const corrupt=make();
    await corrupt.restore('a',()=>{reads++;return store.iterateEvents('a');},'claude');
    assert.equal(reads,3);
    store.resetThread('a');
    assert.equal(existsSync(join(dir,'threads','a.agents.json')),false);
  } finally {store.flush();rmSync(dir,{recursive:true,force:true});}
});

test('아직 복원하지 않은 기록에 실시간 갱신이 와도 불완전한 캐시를 쓰지 않는다', async () => {
  let saves=0;
  const index=new SessionAgentIndex(()=>{}, {load:()=>null,save:()=>{saves++;}});
  index.prepare(['a']);
  index.observe('a',start,'claude');index.persist('a');
  assert.equal(saves,0);
  await index.restore('a',()=>[start],'claude');
  assert.equal(saves,1);
});
