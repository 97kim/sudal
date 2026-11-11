import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceStateDto } from './ipc';
import { emptyModel, createWorkspace, createTab, closeTab, deleteTab } from './workspace-model';
import { openSubagentTab, parseSubagentTabs, subagentTabId, subagentTabWorkspace, type SubagentTabsState } from './subagent-tabs';

function fixture(): WorkspaceStateDto {
  let model = createWorkspace(emptyModel(),'workspace',1,'ws').model;
  model = createTab(model,'ws',2,'parent',{provider:'codex'}).model;
  model = {...model,tabs:model.tabs.map(tab=>tab.id==='parent' ? {...tab,title:'Parent',sessionId:'parent-session'} : tab)};
  model = createTab(model,'ws',3,'other').model;
  return {model,statuses:{parent:'running'},attention:{},agents:{parent:[{id:'codex:child',provider:'codex',kind:'internal',status:'done',title:'Review',blockId:'spawn'}]}};
}
const ref = {parentTabId:'parent',agentId:'codex:child',title:'Review'};

test('읽기 전용 탭은 부모 옆에 한 번만 열고 원본 세션 모델을 변경하지 않는다',()=>{
  const source=fixture(), before=JSON.stringify(source);
  let state:SubagentTabsState={tabs:[],activeId:null};
  state=openSubagentTab(state,ref);state=openSubagentTab(state,ref);
  assert.equal(state.tabs.length,1);
  const ws=subagentTabWorkspace(source,state), id=subagentTabId(ref);
  assert.deepEqual(ws.model.openTabIds,['parent',id,'other']);
  assert.equal(ws.model.activeTabId,id);
  assert.equal(ws.model.tabs.find(tab=>tab.id===id)?.title,'↳ Review');
  assert.equal(ws.model.tabs.find(tab=>tab.id===id)?.sessionId,null);
  assert.equal(JSON.stringify(source),before);
});

test('읽기 전용 탭을 닫은 뒤 같은 참조로 다시 열며 기록 본문 없이 복원한다',()=>{
  const opened=openSubagentTab({tabs:[],activeId:null},ref);
  const restored=parseSubagentTabs(JSON.stringify(opened));
  assert.deepEqual(restored,opened);
  const closed={tabs:restored.tabs.filter(tab=>subagentTabId(tab)!==restored.activeId),activeId:null};
  const reopened=openSubagentTab(closed,ref);
  assert.equal(reopened.activeId,opened.activeId);
  assert.equal(reopened.tabs.length,1);
});

test('부모를 닫아도 조회 탭은 유지하고 삭제한 부모의 조회 탭은 투영에서 제외한다',()=>{
  const source=fixture(), state=openSubagentTab({tabs:[],activeId:null},ref);
  const closed=subagentTabWorkspace({...source,model:closeTab(source.model,'parent',4)},state);
  assert.ok(closed.model.openTabIds.includes(subagentTabId(ref)));
  const deleted=subagentTabWorkspace({...source,model:deleteTab(source.model,'parent',4)},state);
  assert.equal(deleted.model.openTabIds.includes(subagentTabId(ref)),false);
  assert.equal(deleted.model.activeTabId,'other');
});

test('동일 에이전트 ID도 부모별로 구분하고 손상된 저장값은 무시한다',()=>{
  let state=openSubagentTab({tabs:[],activeId:null},ref);
  state=openSubagentTab(state,{...ref,parentTabId:'other'});
  assert.equal(state.tabs.length,2);
  assert.notEqual(subagentTabId(ref),subagentTabId({...ref,parentTabId:'other'}));
  assert.deepEqual(parseSubagentTabs('bad'),{tabs:[],activeId:null});
  const parsed=parseSubagentTabs(JSON.stringify({tabs:[null,{},ref,ref],activeId:'bad'}));
  assert.equal(parsed.tabs.length,1);assert.equal(parsed.activeId,null);
});
