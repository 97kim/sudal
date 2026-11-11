import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionAgent } from '@shared/session-agents';
import { replaySession } from '@shared/session-state';
import { readSubagentHistory } from './subagent-history';

const row: SessionAgent = { id:'codex:child', provider:'codex', title:'Review', kind:'internal', status:'done', blockId:'spawn' };
const meta = {type:'session_meta',payload:{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}}};
const start = {type:'event_msg',payload:{type:'thread_settings_applied',thread_id:'child'}};
const message = (id: string, text: string, threadId = 'child') => ({type:'event_msg',timestamp:'2026-11-11T00:00:00Z',payload:{type:'item_completed',thread_id:threadId,item:{type:'AgentMessage',id,content:[{type:'Text',text}]}}});
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'sudal-subagent-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const roots = {codex:path.join(root,'codex'),claude:path.join(root,'claude')};
  const file = path.join(roots.codex,'2026','11','11','rollout-date-child.jsonl');
  await fs.mkdir(path.dirname(file),{recursive:true});
  return {roots,file,write:async (records: unknown[]) => fs.writeFile(file,records.map(record=>JSON.stringify(record)).join('\n')+'\n')};
}

test('Codex 원본의 부모 상속 대화를 제외하고 자식 지시·응답·도구 결과를 읽는다', async t => {
  const f = await fixture(t);
  await f.write([meta, message('inherited','parent private','parent'),
    {type:'response_item',payload:{type:'function_call',call_id:'spawn',arguments:JSON.stringify({prompt:'검토해 주세요'})}},start,
    {type:'response_item',payload:{type:'agent_message',id:'task',content:[{type:'input_text',text:'Message Type: NEW_TASK\nPayload:'},{type:'encrypted_content',encrypted_content:'opaque'}]}},
    message('answer','확인했어요'),
    {type:'event_msg',payload:{type:'item_completed',thread_id:'child',item:{type:'CommandExecution',id:'cmd',command:['pwsh','-Command','node --version'],aggregated_output:'v22',exit_code:0}}},
    message('foreign','different child','other'),
  ]);
  const result = await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  assert.equal(result.unavailable,undefined);
  assert.equal(result.limited,true);
  const state = replaySession(result.events);
  assert.deepEqual(state.blocks.filter(block=>block.kind==='user').map(block=>block.text),['검토해 주세요']);
  assert.deepEqual(state.blocks.filter(block=>block.kind==='text').map(block=>block.text),['확인했어요']);
  assert.ok(state.blocks.some(block=>block.kind==='tool' && block.name==='Bash' && block.result?.output==='v22'));
  assert.equal(JSON.stringify(result).includes('parent private'),false);
});

test('Codex 부모 관계·ID 검증 및 기록 미생성 상태',async t=>{
  const f=await fixture(t); await f.write([meta,start,message('a','child')]);
  for (const options of [{parentSessionId:'different',row},{parentSessionId:'parent',row:{...row,id:'codex:../child'}},{parentSessionId:null,row},{parentSessionId:'parent',row:{...row,id:'codex:missing'}}]) {
    assert.equal((await readSubagentHistory({roots:f.roots,...options})).unavailable,true);
  }
});

test('큰 Codex 기록은 최근 분량부터 읽고 이전 페이지에 빠짐·중복이 없다',async t=>{
  const f=await fixture(t);
  await f.write([meta,start,...Array.from({length:90},(_,i)=>message(`m${i}`,`${i}:${'가'.repeat(6000)}`))]);
  let page=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  assert.ok(page.before && page.before>0);
  assert.ok(page.events.length<90);
  let events=page.events;
  for(let i=0;page.before!=null && i<8;i++) {
    const old=page.before;
    page=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',before:old});
    assert.ok(page.before===null || page.before<old);
    events=[...page.events,...events];
  }
  assert.equal(page.before,null);
  assert.deepEqual(events.filter(e=>e.type==='assistant_text').map(e=>e.blockId),Array.from({length:90},(_,i)=>`m${i}`));
});

test('Claude 샘플: sidechain 지시·응답·도구 입출력을 읽고 전경 호출을 정확한 agentId로 연결한다',async t=>{
  const f=await fixture(t);
  const parent=path.join(f.roots.claude,'project','parent.jsonl');
  const child=path.join(f.roots.claude,'project','parent','subagents','agent-a1.jsonl');
  await fs.mkdir(path.dirname(child),{recursive:true});
  await fs.writeFile(parent,JSON.stringify({type:'user',toolUseResult:{agentId:'a1'},message:{content:[{type:'tool_result',tool_use_id:'launch',content:'done'}]}})+'\n');
  await fs.writeFile(child,[
    {type:'user',uuid:'u1',isSidechain:true,message:{content:'검토 요청'}},
    {type:'assistant',isSidechain:true,message:{id:'m1',content:[{type:'text',text:'파일을 확인할게요'},{type:'tool_use',id:'read',name:'Read',input:{file_path:'a.ts'}}]}},
    {type:'user',isSidechain:true,message:{content:[{type:'tool_result',tool_use_id:'read',content:'const a=1'}]}},
  ].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const claude:SessionAgent={...row,id:'tool:launch',provider:'claude',blockId:'launch'};
  const result=await readSubagentHistory({roots:f.roots,row:claude,parentSessionId:'parent'});
  assert.equal(result.unavailable,undefined);
  const state=replaySession(result.events);
  assert.ok(state.blocks.some(b=>b.kind==='user' && b.text==='검토 요청'));
  assert.ok(state.blocks.some(b=>b.kind==='text' && b.text==='파일을 확인할게요'));
  assert.ok(state.blocks.some(b=>b.kind==='tool' && b.name==='Read' && b.result?.output==='const a=1'));
  // Background task IDs can differ from agent IDs; fall back to the exact parent tool result.
  assert.equal((await readSubagentHistory({roots:f.roots,row:{...claude,backgroundId:'task-1'},parentSessionId:'parent'})).unavailable,undefined);
  assert.equal((await readSubagentHistory({roots:f.roots,row:{...claude,blockId:'unrelated'},parentSessionId:'parent'})).unavailable,true);
  // A recent foreground result can be beyond the bounded header in a long parent conversation.
  const parentResult=await fs.readFile(parent,'utf8');
  await fs.writeFile(parent,`${JSON.stringify({padding:'x'.repeat(5*1024*1024)})}\n${parentResult}`);
  assert.equal((await readSubagentHistory({roots:f.roots,row:claude,parentSessionId:'parent'})).unavailable,undefined);
});

test('Codex 자식 경계 이후 response_item 형식도 표시하며 developer·추론 내용은 제외한다',async t=>{
  const f=await fixture(t);
  await f.write([meta,start,
    {type:'response_item',payload:{type:'message',id:'dev',role:'developer',content:[{type:'input_text',text:'private instructions'}]}},
    {type:'response_item',payload:{type:'message',id:'u',role:'user',content:[{type:'input_text',text:'hello'}]}},
    {type:'response_item',payload:{type:'function_call',call_id:'cmd',name:'exec_command',arguments:JSON.stringify({command:'node --version'})}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'cmd',output:'v22'}},
    {type:'response_item',payload:{type:'message',id:'a',role:'assistant',content:[{type:'output_text',text:'done'}]}},
  ]);
  const result=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  const state=replaySession(result.events);
  assert.ok(state.blocks.some(b=>b.kind==='user' && b.text==='hello'));
  assert.ok(state.blocks.some(b=>b.kind==='text' && b.text==='done'));
  assert.ok(state.blocks.some(b=>b.kind==='tool' && b.result?.output==='v22'));
  assert.equal(JSON.stringify(result).includes('private instructions'),false);
});

test('증분 조회: 새 기록만 읽고 미완성 UTF-8 줄은 완성될 때까지 보존한다',async t=>{
  const f=await fixture(t); await f.write([meta,start,message('a','첫 응답')]);
  const initial=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  assert.ok(initial.cursor);
  const read=(after=initial.cursor)=>readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',after});
  const idle=await read(); assert.equal(idle.append,true); assert.deepEqual(idle.events,[]);
  const encoded=Buffer.from(JSON.stringify(message('b','새로운 한글 응답'))+'\n');
  const split=encoded.indexOf(Buffer.from('한글'))+1;
  await fs.appendFile(f.file,encoded.subarray(0,split));
  const partial=await read(); assert.deepEqual(partial.events,[]); assert.equal(partial.cursor?.offset,initial.cursor.offset);
  await fs.appendFile(f.file,encoded.subarray(split));
  const complete=await read(partial.cursor);
  assert.deepEqual(complete.events.filter(e=>e.type==='assistant_text').map(e=>e.text),['새로운 한글 응답']);
  assert.deepEqual((await read(complete.cursor)).events,[]);
  // A complete JSON record without a newline is consumed once, even when its newline arrives later.
  await fs.appendFile(f.file,JSON.stringify(message('c','끝줄')));
  const last=await read(complete.cursor); assert.equal(last.events.length,1);
  await fs.appendFile(f.file,'\n'); assert.deepEqual((await read(last.cursor)).events,[]);
});

test('증분 조회: 잘린 파일은 새 스냅샷으로 바꾸고 부모 관계를 다시 검증한다',async t=>{
  const f=await fixture(t); await f.write([meta,start,message('a','old'.repeat(1000))]);
  const old=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  await f.write([meta,start,message('b','new')]);
  const reset=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',after:old.cursor});
  assert.equal(reset.append,false); assert.deepEqual(reset.events.filter(e=>e.type==='assistant_text').map(e=>e.blockId),['b']);
  await f.write([{...meta,payload:{...meta.payload,source:{subagent:{thread_spawn:{parent_thread_id:'foreign'}}}}},start]);
  assert.equal((await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',after:reset.cursor})).unavailable,true);
});

test('증분 조회: 큰 백로그와 지나치게 긴 줄을 제한된 크기로 건너뛰며 진행한다',async t=>{
  const f=await fixture(t); await f.write([meta,start,message('a','initial')]);
  let page=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  const records=Array.from({length:110},(_,i)=>message(`new-${i}`,'가'.repeat(6000)));
  await fs.appendFile(f.file,records.map(record=>JSON.stringify(record)).join('\n')+'\n'+JSON.stringify({ignored:'x'.repeat(2*1024*1024)})+'\n'+JSON.stringify(message('last','마지막'))+'\n');
  const events=[]; let limited=false;
  for(let i=0;i<15;i++) {
    const old=page.cursor!.offset;
    page=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',after:page.cursor});
    events.push(...page.events); limited ||= page.limited;
    assert.ok(page.cursor!.offset>=old);
    if(page.cursor!.offset===page.cursor!.size) break;
    assert.ok(page.hasNewer,'remaining backlog must request another bounded read');
  }
  assert.equal(page.cursor!.offset,page.cursor!.size); assert.equal(limited,true);
  assert.deepEqual(events.filter(e=>e.type==='assistant_text').map(e=>e.blockId),[...records.map((_,i)=>`new-${i}`),'last']);
});

test('Codex 증분 원본과 완료 이벤트가 같은 응답을 중복 표시하지 않는다',async t=>{
  const f=await fixture(t); await f.write([meta,start]);
  const first=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  const raw={type:'response_item',payload:{type:'message',id:'a',role:'assistant',content:[{type:'output_text',text:'작성 중 응답'}]}};
  await fs.appendFile(f.file,JSON.stringify(raw)+'\n');
  const rawPage=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',after:first.cursor});
  await fs.appendFile(f.file,JSON.stringify(message('a','완료 응답'))+'\n');
  const done=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent',after:rawPage.cursor});
  const state=replaySession([...first.events,...rawPage.events,...done.events]);
  assert.deepEqual(state.blocks.filter(b=>b.kind==='text').map(b=>b.text),['완료 응답']);
  const reopened=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  assert.equal(reopened.events.filter(e=>e.type==='assistant_text').length,1);
});

test('Claude 증분 샘플: 새 지시와 응답을 자동 조회할 수 있다',async t=>{
  const f=await fixture(t),child=path.join(f.roots.claude,'project','parent','subagents','agent-a1.jsonl');
  await fs.mkdir(path.dirname(child),{recursive:true}); await fs.writeFile(child,'');
  const claude:SessionAgent={...row,id:'tool:launch',provider:'claude',backgroundId:'a1',blockId:'launch'};
  const first=await readSubagentHistory({roots:f.roots,row:claude,parentSessionId:'parent'});
  await fs.appendFile(child,[{type:'user',uuid:'u1',isSidechain:true,message:{content:'추가 요청'}},{type:'assistant',isSidechain:true,message:{id:'a1',content:[{type:'text',text:'응답'}]}}].map(record=>JSON.stringify(record)).join('\n')+'\n');
  const next=await readSubagentHistory({roots:f.roots,row:claude,parentSessionId:'parent',after:first.cursor});
  assert.equal(next.append,true);
  assert.deepEqual(replaySession(next.events).blocks.map(b=>b.kind==='user'||b.kind==='text'?b.text:b.kind),['추가 요청','응답']);
  assert.deepEqual((await readSubagentHistory({roots:f.roots,row:claude,parentSessionId:'parent',after:next.cursor})).events,[]);
});

test('Codex 서로 다른 원본 형식의 새 지시와 완료 응답을 함께 보존한다',async t=>{
  const f=await fixture(t);
  await f.write([meta,start,{type:'response_item',payload:{type:'message',id:'instruction',role:'user',content:[{type:'input_text',text:'추가 검토 요청'}]}},message('answer','검토 응답')]);
  const result=await readSubagentHistory({roots:f.roots,row,parentSessionId:'parent'});
  assert.deepEqual(replaySession(result.events).blocks.map(b=>b.kind==='user'||b.kind==='text'?b.text:b.kind),['추가 검토 요청','검토 응답']);
});
