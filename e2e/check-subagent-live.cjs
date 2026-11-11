// Real renderer + local transcript fixtures. No provider sessions or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright-core');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-subagent-live-'));
  const home = path.join(profile, 'home'), codex = path.join(profile, 'codex'), claude = path.join(profile, 'claude');
  fs.mkdirSync(home); fs.mkdirSync(path.join(profile, 'threads'));
  const disabled = path.join(profile, 'disabled.cmd'); fs.writeFileSync(disabled, '@exit /b 1\r\n');
  fs.writeFileSync(path.join(profile, 'cli-overrides.json'), JSON.stringify({codex:disabled,claude:disabled,agy:disabled}));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({language:'ko',warmTarget:'off',otter:false,notifyOnDone:'off'}));
  const now = Date.now();
  const tab = (id,provider) => ({id,title:id,provider,sessionId:`${provider}-session`,workspaceId:'ws',policy:'ask',createdAt:now,updatedAt:now,open:true,cwd:home});
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({version:1,
    workspaces:[{id:'ws',name:'자동 갱신 테스트',path:home,addedAt:now,lastUsedAt:now}],
    tabs:[tab('parent-codex','codex'),tab('parent-claude','claude'),tab('orphan-parent','codex'),{...tab('closed-review','claude'),open:false}],openTabIds:['parent-codex','parent-claude','orphan-parent'],activeTabId:'parent-codex'}));
  const write = (file,records) => fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
  write(path.join(profile,'threads','parent-codex.jsonl'),[
    {type:'user_message',id:'request',ts:now,text:'서브에이전트 확인'},
    {type:'tool_use',ts:now,toolUseId:'launch',name:'Agent',input:{codexAgent:true,operation:'spawnAgent',description:'자동 갱신',agents:[{id:'child',status:'running'}]}},
    {type:'review',ts:now,reviewer:'claude',reviewTabId:'deleted-review',scope:'1개 파일 · +3 −3',status:'failed',text:'과거 실패한 리뷰 기록'},
    {type:'review',ts:now,reviewer:'claude',reviewTabId:'closed-review',scope:'닫아 둔 리뷰',status:'failed',text:'닫아 둔 리뷰 기록'}
  ]);
  write(path.join(profile,'threads','orphan-parent.jsonl'),[
    {type:'review',ts:now,reviewer:'claude',reviewTabId:'another-deleted-review',scope:'삭제된 리뷰만 있는 세션',status:'failed',text:'보존할 과거 리뷰 기록'}
  ]);
  write(path.join(profile,'threads','parent-claude.jsonl'),[
    {type:'agent_status',ts:now,agentId:'a1',toolUseId:'launch-claude',provider:'claude',title:'Claude 자동 갱신',status:'running',background:true}
  ]);
  const codexFile = path.join(codex,'sessions','2026','11','11','rollout-date-child.jsonl'); fs.mkdirSync(path.dirname(codexFile),{recursive:true});
  const codexRecord = (id,text) => ({type:'event_msg',payload:{type:'item_completed',thread_id:'child',item:{type:'AgentMessage',id,content:[{type:'Text',text}]}}});
  write(codexFile,[{type:'session_meta',payload:{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'codex-session'}}}}},
    {type:'event_msg',payload:{type:'thread_settings_applied',thread_id:'child'}},
    ...Array.from({length:140},(_,i)=>codexRecord(`answer-${i}`,`답변 ${i}\n\n${'길이가 다른 대화 내용입니다. '.repeat(1+i%7*6)}`))]);
  const claudeFile = path.join(claude,'projects','project','claude-session','subagents','agent-a1.jsonl'); fs.mkdirSync(path.dirname(claudeFile),{recursive:true});
  const claudeRecord = (id,text) => ({type:'assistant',isSidechain:true,message:{id,content:[{type:'text',text}]}});
  write(claudeFile,[claudeRecord('first','Claude 초기 응답')]);
  const bootstrap = path.join(profile,'main.mjs');
  fs.writeFileSync(bootstrap, `import { app, ipcMain } from 'electron';
    app.setPath('userData',${JSON.stringify(profile)}); app.setPath('home',${JSON.stringify(home)});
    globalThis.__historyReads=0; const handle=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(channel,fn)=>handle(channel,channel==='chat:subagent-history'?(...args)=>{globalThis.__historyReads++;return fn(...args);}:fn);
    await import(${JSON.stringify(pathToFileURL(path.join(repo,'out/main/index.js')).href)});`);
  const env = {...process.env,USERPROFILE:home,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:claude};
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app;
  try {
    app = await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const sidebar=page.locator('[data-sidebar]');
    await sidebar.locator('[data-session-agent="codex:child"]').waitFor();
    let orphanRestored=false;
    for(let attempt=0;attempt<100;attempt++) {
      orphanRestored=await page.evaluate(async()=>!!(await window.sudal.workspaces.state()).agents['orphan-parent']?.length);
      if(orphanRestored) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(orphanRestored,'orphan summaries must be restored before checking their absence from the sidebar');
    assert.equal(await sidebar.locator('[data-session-agent="tab:deleted-review"]').count(),0,'deleted review is excluded');
    assert.equal(await sidebar.locator('[data-session-agent="tab:another-deleted-review"]').count(),0,'orphan-only parent has no stale review row');
    assert.equal(await sidebar.locator('[data-session="orphan-parent"] button[aria-expanded]').count(),0,'orphan-only parent has no empty expand control');
    assert.equal(await sidebar.locator('[data-session-agent="tab:closed-review"]').count(),1,'closed review remains available');
    await page.locator('[data-sidebar] [data-session-agent="codex:child"]').click();
    const history=page.locator('[data-subagent-history]'),list=history.locator('[data-message-list]');
    await history.locator('[data-block-id="answer-139"]').waitFor();
    await history.locator('[data-subagent-live]').waitFor();
    // Automatic append follows the bottom without replacing the scroll container.
    await list.evaluate(el=>{window.__liveList=el;});
    fs.appendFileSync(codexFile,JSON.stringify(codexRecord('live-1','새 응답 자동 반영'))+'\n');
    await history.getByText('새 응답 자동 반영',{exact:true}).waitFor();
    assert.equal(await list.evaluate(el=>el===window.__liveList),true);
    await page.waitForFunction(()=>{const e=document.querySelector('[data-subagent-history] [data-message-list]');return e.scrollHeight-e.scrollTop-e.clientHeight<3;});
    // While reading older content, both new instructions and new replies stay below.
    await list.hover(); await page.mouse.wheel(0,-2500); await page.waitForTimeout(450);
    const anchor=await list.evaluate(el=>{const top=el.getBoundingClientRect().top;const row=[...el.querySelectorAll('[data-virtual-row]')].find(e=>e.getBoundingClientRect().bottom>top);window.__readingRow=row;return {key:row.dataset.virtualRow,y:row.getBoundingClientRect().top,top:el.scrollTop};});
    fs.appendFileSync(codexFile,[{type:'response_item',payload:{type:'agent_message',id:'new-task',content:[{type:'input_text',text:'추가 지시'}]}},codexRecord('live-2','두 번째 자동 응답')].map(JSON.stringify).join('\n')+'\n');
    // Wait for replay even when the appended row is outside the virtual viewport.
    await page.waitForFunction(()=>document.querySelector('[data-subagent-history] [data-message-list]')?.dataset.historyCount==='143');
    await page.waitForTimeout(400);
    const reading=await list.evaluate(el=>({same:el===window.__liveList,anchorConnected:window.__readingRow.isConnected,y:window.__readingRow.getBoundingClientRect().top,top:el.scrollTop}));
    assert.equal(reading.same,true); assert.equal(reading.anchorConnected,true);
    assert.ok(Math.abs(reading.y-anchor.y)<8,`live append moved reading anchor ${reading.y-anchor.y}px`);
    assert.ok(Math.abs(reading.top-anchor.top)<8);
    // A transient file error retains content. Manual recovery does not clear it.
    fs.renameSync(codexFile,codexFile+'.backup');
    await history.getByRole('button',{name:'기록 새로고침',exact:true}).click();
    await history.getByText('이 서브에이전트의 기록을 찾지 못했어요.',{exact:false}).first().waitFor();
    assert.equal(await list.evaluate(el=>el===window.__liveList),true);
    assert.equal(await list.getAttribute('data-history-count'),'143');
    fs.renameSync(codexFile+'.backup',codexFile);
    await history.getByRole('button',{name:'기록 새로고침',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-subagent-history] [role="alert"]'));
    await page.evaluate(()=>document.querySelector('[data-scroll-bottom]')?.click());
    await history.getByText('두 번째 자동 응답',{exact:true}).waitFor();
    await page.screenshot({path:path.join(repo,'.sudal/subagent-live.png')});
    // Parent view unmounts the reader; no background polling remains.
    await history.getByRole('button',{name:'부모 대화',exact:true}).click();
    await history.waitFor({state:'detached'}); await page.waitForTimeout(100);
    const reads=await app.evaluate(()=>globalThis.__historyReads);
    await page.waitForTimeout(1400); assert.equal(await app.evaluate(()=>globalThis.__historyReads),reads);
    await page.locator('[data-sidebar] [data-session="parent-claude"]').click();
    await page.locator('[data-sidebar] [data-session-agent="tool:launch-claude"]').click();
    await history.getByText('Claude 초기 응답',{exact:true}).waitFor();
    fs.appendFileSync(claudeFile,JSON.stringify(claudeRecord('next','Claude 자동 반영 응답'))+'\n');
    await history.getByText('Claude 자동 반영 응답',{exact:true}).waitFor();
    // Deletion must update filtering even if the stored agent summaries are unchanged.
    await page.evaluate(()=>window.sudal.workspaces.deleteTab('closed-review'));
    await sidebar.locator('[data-session-agent="tab:closed-review"]').waitFor({state:'detached'});
    const retained=await page.evaluate(async()=>({agents:(await window.sudal.workspaces.state()).agents['parent-codex'],reviews:(await window.sudal.chat.events('parent-codex')).filter(e=>e.type==='review')}));
    assert.ok(retained.agents.some(row=>row.tabId==='closed-review'),'cached source agent summary remains intact');
    assert.equal(retained.reviews.length,2,'review history remains intact');
    await app.close();
    app=await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    const restoredPage=await app.firstWindow(); restoredPage.setDefaultTimeout(15000);
    restoredPage.on('pageerror',e=>errors.push(e.message));
    const restoredSidebar=restoredPage.locator('[data-sidebar]');
    await restoredSidebar.locator('[data-session-agent="codex:child"]').waitFor();
    assert.equal(await restoredSidebar.locator('[data-session-agent="tab:closed-review"]').count(),0,'deleted reference stays hidden after app restart');
    assert.equal(await restoredSidebar.locator('[data-session-agent="tab:deleted-review"]').count(),0);
    await restoredSidebar.screenshot({path:path.join(repo,'.sudal/sidebar-deleted-agents.png')});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,codexAutomaticAppend:true,claudeFixtureAutomaticAppend:true,readingAnchorDelta:reading.y-anchor.y,noBlankRefresh:true,unmountedStopsPolling:true,deletedAgentsHidden:true,closedAgentsRetained:true,reviewHistoryPreserved:true,noModelCalls:true}));
  } finally {
    await app?.close();
    if(path.dirname(path.resolve(profile))!==path.resolve(os.tmpdir())||!path.basename(profile).startsWith('sudal-subagent-live-')) throw Error('Unexpected cleanup path');
    await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
