// Real renderer, isolated profile, and deterministic provider events. No model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright-core');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-completion-e2e-'));
  const home = path.join(profile, 'home'); fs.mkdirSync(home);
  fs.mkdirSync(path.join(profile, 'threads'));
  const now = Date.now(), tabId = 'completion-test';
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({language:'ko',warmTarget:'off',otter:false,notifyOnDone:'off'}));
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({version:1,
    workspaces:[{id:'ws',name:'응답 완료 검사',path:home,addedAt:now,lastUsedAt:now}],
    tabs:[{id:tabId,workspaceId:'ws',title:'완료 시 스크롤',provider:'codex',policy:'ask',sessionId:'completion-native',createdAt:now,updatedAt:now,open:true}],
    openTabIds:[tabId],activeTabId:tabId}));
  const usage = {input:100,output:150,cacheRead:0,cacheWrite:0};
  const turn = () => ({type:'turn_result',ts:Date.now(),usage,costUsd:0,durationMs:1500,numTurns:1,modelUsage:{},isError:false,
    forkPoint:{provider:'codex',sessionId:'completion-native',pointId:'completion-fork'}});
  const events = Array.from({length:80}, (_,i) => [
    {type:'user_message',id:`user-${i}`,ts:now+i*3,text:`질문 ${i}`},
    {type:'assistant_text',blockId:`answer-${i}`,ts:now+i*3+1,text:'이전 답변입니다. '.repeat(40)},
    {...turn(),ts:now+i*3+2},
  ]).flat();
  fs.writeFileSync(path.join(profile,'threads',`${tabId}.jsonl`),events.map(JSON.stringify).join('\n')+'\n');
  const bootstrap = path.join(profile,'main.mjs');
  fs.writeFileSync(bootstrap, `import {app} from 'electron';
    app.setPath('userData',${JSON.stringify(profile)}); app.setPath('home',${JSON.stringify(home)});
    ${process.env.SUDAL_E2E_OFFSCREEN === '1' ? `app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.on('browser-window-created',(_event,win)=>{ const show=win.showInactive.bind(win);win.webContents.setBackgroundThrottling(false);win.setIgnoreMouseEvents(true);win.show=()=>{win.setPosition(-10000,-10000);show();};win.focus=()=>{};});` : ''}
    await import(${JSON.stringify(pathToFileURL(path.join(repo,'out/main/index.js')).href)});`);
  const env = {...process.env,USERPROFILE:home};
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app;
  try {
    app = await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.locator('[data-message-list][data-history-count="200"]').waitFor();
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500);
    let sequence = 1000;
    const push = async (data) => app.evaluate(({BrowserWindow}, envelopes) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      envelopes.forEach(e => wc.send('chat:event', e));
    }, data.map(event => ({tabId,sequence:sequence++,event:{ts:Date.now(),...event}})));
    const snapshot = await page.evaluate(id=>window.sudal.chat.snapshot(id),tabId);
    const startTurn = async (ambientFromBg=false) => app.evaluate(({BrowserWindow},snapshot)=>{
      BrowserWindow.getAllWindows()[0].webContents.send('chat:snapshot-changed',snapshot);
    },{...snapshot,turnStartedAt:Date.now(),ambientFromBg});
    const results = [];
    const sendResults = [];
    for (const narrow of [false,true]) {
      await app.evaluate(({BrowserWindow}, narrow) => BrowserWindow.getAllWindows()[0].setSize(narrow?900:1280,860), narrow);
      for (const reading of [false,true]) {
        const id = `live-${narrow}-${reading}`;
        const text = Array.from({length:20},(_,i) => `문단 ${i} `+'응답 완료 전후 위치를 확인하는 본문입니다. '.repeat(8)).join('\n\n');
        await startTurn();
        await page.evaluate(id=>{
          window.__sendTrace=[];window.__samplingSend=true;
          const sample=()=>{
            const user=document.querySelector(`[data-virtual-row="user:${id}-user"]`),previous=user?.previousElementSibling;
            if(user&&previous)window.__sendTrace.push({y:user.getBoundingClientRect().top,gap:user.getBoundingClientRect().top-previous.getBoundingClientRect().bottom,footer:document.querySelector('[data-turn-footer]')?.dataset.turnFooter});
            if(window.__samplingSend)requestAnimationFrame(sample);
          };sample();
        },id);
        await push([{type:'user_message',id:`${id}-user`,text:'완료 시 위치 확인'}, {type:'status',status:'running'}]);
        await page.waitForTimeout(350);
        const sendSamples=await page.evaluate(()=>{window.__samplingSend=false;return window.__sendTrace;});
        assert.ok(sendSamples.length>=5,'next message transition is sampled across frames');
        const gaps=sendSamples.map(s=>s.gap),gapRange=Math.max(...gaps)-Math.min(...gaps);
        assert.ok(gapRange<2,`moving completed turn into history changed message spacing ${gapRange}px`);
        // Starting a turn deliberately adds its thinking/progress indicators.
        // After they appear, the unchanged bubble must not jump a second time.
        const activeSamples=sendSamples.filter(s=>s.footer==='running');
        assert.ok(activeSamples.length>=5,'new turn progress is sampled');
        const userYs=activeSamples.map(s=>s.y),userRange=Math.max(...userYs)-Math.min(...userYs);
        if(!reading)assert.ok(userRange<2,`next message moved after appearing ${userRange}px`);
        sendResults.push({reading,narrow,gapRangePx:gapRange,userRangePx:userRange});
        await push([{type:'text_delta',blockId:id,text}]);
        await page.locator(`[data-block-id="${id}"]`).waitFor(); await page.waitForTimeout(500);
        const list = page.locator('[data-message-list]');
        if (reading) { await list.hover(); await page.mouse.wheel(0,-700); await page.waitForTimeout(500); }
        assert.equal(await page.locator('[data-turn-elapsed]').count(),1,'running footer exists before completion');
        await page.evaluate(id => {
          const list = document.querySelector('[data-message-list]');
          const block = document.querySelector(`[data-block-id="${id}"]`);
          const anchor = [...block.querySelectorAll('.md p')].find(n => n.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
          if (!anchor) throw new Error('No visible paragraph to track');
          window.__completionTrace = []; window.__samplingCompletion = true;
          const sample = () => {
            window.__completionTrace.push({top:list.scrollTop,height:list.scrollHeight,viewport:list.clientHeight,y:anchor.getBoundingClientRect().top,connected:anchor.isConnected});
            if (window.__samplingCompletion) requestAnimationFrame(sample);
          }; sample();
        }, id);
        await page.waitForTimeout(80);
        if (narrow) { await push([{type:'assistant_text',blockId:id,text}]); await page.waitForTimeout(80); }
        await push([turn()]); await page.waitForTimeout(150);
        await push([{type:'status',status:'idle'}]); await page.waitForTimeout(350);
        const samples = await page.evaluate(() => {window.__samplingCompletion=false;return window.__completionTrace;});
        assert.ok(samples.length >= 10,'completion is sampled across animation frames');
        assert.ok(samples.every(s=>s.connected),'visible paragraph stays mounted');
        const ys = samples.map(s=>s.y), range = Math.max(...ys)-Math.min(...ys);
        assert.ok(range < 2,`completion moved paragraph ${range}px (${JSON.stringify({reading,narrow})})`);
        if (!reading) assert.ok(samples.every(s=>s.height-s.top-s.viewport<3),'bottom following holds throughout completion');
        else assert.ok(samples.every(s=>Math.abs(s.top-samples[0].top)<2),'reading position holds throughout completion');
        assert.equal(await page.locator('[data-turn-elapsed]').count(),0,'running indicator is replaced on completion');
        const footer = page.locator('[data-turn-footer="completed"]');
        assert.ok((await footer.innerText()).includes('1.5s'),'completion statistics remain visible');
        assert.equal(await footer.locator('[data-fork-turn]').count(),1,'completed turn keeps its fork control');
        assert.equal(await footer.locator('[data-harness-conversation-slot]').count(),1,'completion keeps its harness anchor');
        results.push({reading,narrow,anchorRangePx:range,samples:samples.length});
      }
    }
    // Native ambientEvent sets a new start time but adds no user block when it
    // resumes with thinking_delta. The prior turn must not hide its progress.
    await startTurn(true);
    await push([{type:'status',status:'running'},{type:'thinking_delta',text:'백그라운드 결과 확인'}]);
    await page.locator('[data-turn-elapsed]').waitFor();
    assert.match(await page.locator('[data-turn-elapsed]').innerText(),/백그라운드/);
    await push([{type:'status',status:'waiting_permission'}]);
    assert.equal(await page.locator('[data-turn-elapsed]').count(),1,'ambient permission wait stays visible');
    await push([{type:'status',status:'running'},{type:'text_delta',blockId:'ambient-answer',text:'백그라운드 결과를 처리했습니다.'}]);
    await push([turn()]); await page.waitForTimeout(100);
    await push([{type:'status',status:'idle'}]);
    await page.locator('[data-turn-footer="completed"]').waitFor();
    assert.equal(await page.locator('[data-turn-elapsed]').count(),0,'ambient completion replaces its own progress');
    assert.deepEqual(errors,[]);
    await page.evaluate(() => document.querySelector('[data-scroll-bottom]')?.click());
    await page.locator('[data-turn-footer="completed"]').scrollIntoViewIfNeeded();
    fs.mkdirSync(path.join(repo,'.sudal'),{recursive:true});
    await page.screenshot({path:path.join(repo,'.sudal/turn-completion-fixed.png')});
    console.log(JSON.stringify({passed:true,noModelCalls:true,results,sendResults,ambientResume:true,ambientPermissionWait:true}));
  } finally {
    await app?.close();
    if(path.dirname(path.resolve(profile))!==path.resolve(os.tmpdir())||!path.basename(profile).startsWith('sudal-completion-e2e-')) throw Error('Unexpected cleanup path');
    await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
