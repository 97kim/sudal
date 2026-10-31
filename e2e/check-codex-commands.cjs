// Isolated renderer checks; backend protocol behavior is covered by codex-controls.test.ts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { _electron } = require("playwright-core");

(async () => {
  const repo = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-codex-commands-"));
  const home = path.join(profile, "home"); fs.mkdirSync(home);
  const now = Date.now(); const tabId = "commands-test";
  fs.writeFileSync(path.join(profile,"settings.json"), JSON.stringify({warmTarget:"off",otter:false,language:"ko",notifyOnDone:"off"}));
  fs.writeFileSync(path.join(profile,"workspaces.json"),JSON.stringify({version:1,workspaces:[{id:"ws",name:"Command test",path:profile,addedAt:now,lastUsedAt:now}],tabs:[{id:tabId,workspaceId:"ws",title:"Codex commands",titleCustom:true,provider:"codex",policy:"ask",sessionId:null,createdAt:now,updatedAt:now,open:true}],openTabIds:[tabId],activeTabId:tabId}));
  const bootstrap = path.join(profile,"main.mjs");
  fs.writeFileSync(bootstrap,`
    import {app,ipcMain,BrowserWindow} from 'electron';
    app.setPath('userData',${JSON.stringify(profile)}); app.setPath('home',${JSON.stringify(home)});
    globalThis.__calls=[];
    const state={codexMode:'default',codexGoal:null};
    let usageReads=0;
    let terminalsStopped=false;
    let memoryMode='enabled';
    let failFastOff=true;
    const handle=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(channel,fn)=>handle(channel,
      channel==='chat:configure' ? async(...args)=>{
        if(args[2]?.policy==='auto_edit'){const error=new Error('fixture permission update rejected');error.name='MsgError';throw error;}
        if(args[2]?.model==='rejected-model'){const error=new Error('fixture model rejected');error.name='MsgError';throw error;}
        return fn(...args);
      } :
      channel==='chat:commands' ? async()=>[{name:'compact',description:'fixture Claude command',argumentHint:''},{name:'clear',description:'fixture clear',argumentHint:''}] :
      channel==='git:changes' ? async()=>[] :
      channel==='chat:codex-mentions' ? async()=>({list:[{kind:'skill',name:'example',description:'fixture',path:'/fixture/example/SKILL.md'}],complete:true}) :
      channel==='chat:send' ? async(_e,id,payload)=>{globalThis.__calls.push(['send',payload.text]);return {ok:true};} :
      channel==='chat:permission' ? async(_e,id,requestId,answer)=>{
        globalThis.__calls.push(['answer',answer]);
        const contents=BrowserWindow.getAllWindows()[0].webContents;
        contents.send('chat:event',{tabId:id,sequence:3,event:{type:'permission_resolved',ts:Date.now(),requestId,behavior:answer.behavior}});
        contents.send('chat:event',{tabId:id,sequence:4,event:{type:'status',ts:Date.now(),status:'idle'}});
        return true;
      } :
      channel==='chat:snapshot' ? async(...args)=>({...await fn(...args),...state}) :
      channel==='chat:codex-control' ? async(_e,id,command,arg)=>{
        globalThis.__calls.push([command,arg]);
        if(command==='rename' && arg==='Rejected rename'){const error=new Error('fixture rename rejected');error.name='MsgError';throw error;}
        if(command==='status')return {data:{session:{sessionId:'fixture-session',model:'gpt-fixture',status:'idle',policy:'ask',cwd:'C:/fixture',codexMode:'default',controller:'app',pendingPrompts:[]},thread:{thread:{cliVersion:'0.166.0',gitInfo:{branch:'feature/results'}}}}};
        if(command==='ps')return {data:{data:terminalsStopped?[]:[{processId:'worker-1',command:'node background.js',cwd:'C:/fixture',osPid:123,cpuPercent:0,rssKb:2048}]}};
        if(command==='stop'){terminalsStopped=true;return {data:{stopped:true}};}
        if(command==='fast'){
          if(!['on','off'].includes(arg)){const error=new Error('/fast on 또는 /fast off로 입력해 주세요.');error.name='MsgError';throw error;}
          if(arg==='off' && failFastOff){failFastOff=false;const error=new Error('fixture fast unavailable');error.name='MsgError';throw error;}
          return {data:{fast:arg==='on'}};
        }
        if(command==='memories'){
          if(arg){memoryMode=arg==='on'?'enabled':'disabled';return {data:{mode:memoryMode}};}
          return {data:{summary:memoryMode==='enabled'?'Fixture memory summary\\n\\nUse the project conventions.':null}};
        }
        if(command==='hooks')return {data:{data:[{cwd:'C:/fixture',warnings:['Fixture hook warning'],errors:[],hooks:[{key:'hook-1',eventName:'SessionStart',handlerType:'command',command:'echo fixture-hook',enabled:true,trustStatus:'trusted',matcher:'startup',sourcePath:'C:/fixture/hooks.json'},{key:'hook-2',eventName:'Stop',handlerType:'command',command:'echo changed-hook',enabled:false,trustStatus:'modified',sourcePath:'C:/fixture/hooks.json'}]}]}};
        if(command==='plugins')return {data:{marketplaces:[{name:'Fixture catalog',plugins:[{id:'installed',name:'Git tools',installed:true,enabled:true,interface:{displayName:'Git Tools',shortDescription:'Repository helpers',developerName:'Fixture developer'}},{id:'browser',name:'Browser tools',installed:false,enabled:true,interface:{shortDescription:'Browse documentation'}},{id:'blocked',name:'Blocked plugin',installed:true,enabled:true,availability:'DISABLED_BY_ADMIN',disabledReason:'disabled_by_admin'}]}],marketplaceLoadErrors:[]}};
        if(command==='debug-config')return {data:{model:'gpt-fixture',api_key:'••••',shell_environment_policy:{set:'••••'}}};
        if(command==='usage'){
          usageReads++;
          if(usageReads===3)throw new Error('fixture usage unavailable');
          return {data:{ordinaryUsageAllowed:false,rateLimits:{limitName:'Codex',planType:'pro',primary:{usedPercent:usageReads===1?37:42,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:86,windowDurationMins:10080,resetsAt:null},credits:{hasCredits:true,unlimited:false,balance:'12.50'}}}};
        }
        if(command==='mcp')return {data:[
          {name:'GitHub',runtimeStatus:'connected',authStatus:'oAuth',serverInfo:{version:'1.2.0'},httpOrigin:'https://example.com/private?token=fixture',tools:{issues:{name:'search_issues',title:'Search issues',description:'Find issues in a repository',inputSchema:{type:'object'}},files:{name:'read_file',description:'Read repository files',inputSchema:{type:'object'}}},resources:[{name:'Repository guide',description:'Project documentation'}],resourceTemplates:[]},
          {name:'Needs login',runtimeStatus:'authenticationRequired',authStatus:'notLoggedIn',tools:{},toolsError:'Sign in to discover tools'},
          {name:'Cached catalog',runtimeStatus:null,authStatus:'unknown',tools:{cached:{name:'cached_tool',description:'Cached metadata'}},resources:[],resourceTemplates:[]}
        ]};
        if(command==='plan'){state.codexMode=arg==='on'?'plan':arg==='off'?'default':state.codexMode==='plan'?'default':'plan';return {mode:state.codexMode};}
        if(command==='goal'){
          if(arg==='clear')state.codexGoal=null;
          else if(arg==='pause')state.codexGoal={...state.codexGoal,status:'paused'};
          else if(arg==='resume')state.codexGoal={...state.codexGoal,status:'active'};
          else if(arg)state.codexGoal={objective:arg,status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0};
          return {goal:state.codexGoal};
        }
        return {data:{fixture:command}};
      } : fn);
    await import(${JSON.stringify(pathToFileURL(path.join(repo,"out/main/index.js")).href)});
  `);
  let app;
  try {
    const env={...process.env,USERPROFILE:home}; delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    const page=await app.firstWindow(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const input=page.locator('[data-composer] textarea'); await input.waitFor({timeout:15000});
    await input.fill('/');
    const commandRow=name=>page.locator('[data-palette-row="command"]').filter({has:page.locator('span').filter({hasText:new RegExp('^/'+name+'$')})});
    await commandRow('plan').locator('[data-command-source="codex"]').waitFor();
    await commandRow('config').locator('[data-command-source="sudal"]').waitFor();
    await page.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/command-sources-ui.png')});
    await input.press('Escape');
    const submit=async text=>{await input.fill(text);await input.press('Escape');await input.press('Enter');};
    await submit('/plan'); await page.locator('[data-codex-mode="plan"]').waitFor();
    assert.ok(await page.locator('[data-codex-mode]').innerText().then(t=>t.includes('플랜 모드 켜짐')));
    await submit('/plan off'); await page.locator('[data-codex-mode="default"]').waitFor();
    await submit('/goal Inspect fixture');
    await page.getByRole('button',{name:/목표 진행 중.*Inspect fixture/}).waitFor();
    assert.equal(await page.locator('[data-codex-goal]').count(),0,'a new goal starts without covering permission cards');
    await submit('/goal'); await page.locator('[data-codex-goal]').waitFor();
    await page.getByRole('button',{name:'일시정지',exact:true}).click();
    await page.getByRole('button',{name:'재개',exact:true}).waitFor();
    await page.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/goal-ui.png')});
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/status');
    const status=page.locator('[data-codex-result="status"]');
    await status.getByText('gpt-fixture',{exact:true}).waitFor();
    assert.ok((await status.innerText()).includes('fixture-session'));
    assert.ok((await status.innerText()).includes('feature/results'));
    await page.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/status-result-ui.png')});
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/permissions auto_edit');
    await page.getByText('fixture permission update rejected',{exact:true}).waitFor();
    await submit('/permissions');
    const permissions=page.getByRole('dialog',{name:'/permissions',exact:true});
    await permissions.getByRole('button',{name:/작업 경로 내 파일 편집 허용/}).click();
    await page.locator('[data-terminal-banner]').getByText('fixture permission update rejected',{exact:true}).waitFor();
    await permissions.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/rename');
    const title=page.getByPlaceholder('세션 이름',{exact:true});
    await title.fill('Rejected rename'); await title.press('Enter');
    await page.locator('[data-terminal-banner]').getByText('fixture rename rejected',{exact:true}).waitFor();
    await page.locator('header').getByText('Codex commands',{exact:true}).waitFor();
    assert.ok(!(await page.locator('[data-terminal-banner]').innerText()).includes('MsgError'));
    assert.ok(!(await page.locator('[data-terminal-banner]').innerText()).includes('chat:codex-control'));
    await submit('/model');
    const model=page.locator('[data-model-picker]');
    await model.locator('[data-model-custom]').fill('rejected-model');
    await model.locator('[data-model-custom]').press('Enter');
    await model.getByText('fixture model rejected',{exact:true}).waitFor();
    assert.ok(!(await model.innerText()).includes('chat:configure'));
    assert.ok(!(await model.innerText()).includes('MsgError'));
    await model.getByRole('button').first().click();
    await submit('/ps');
    const processes=page.locator('[data-codex-result="ps"]');
    await processes.getByText('node background.js',{exact:true}).waitFor();
    assert.ok((await processes.innerText()).includes('2 MB'));
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/hooks');
    const hooks=page.locator('[data-codex-result="hooks"]');
    await hooks.getByText('SessionStart',{exact:true}).waitFor();
    assert.ok((await hooks.innerText()).includes('Fixture hook warning'));
    assert.ok((await hooks.innerText()).includes('변경됨 · 재확인 필요'));
    await hooks.getByText('실행 내용 보기',{exact:true}).first().click();
    await hooks.getByText('echo fixture-hook',{exact:true}).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/plugins');
    const plugins=page.locator('[data-codex-result="plugins"]');
    await plugins.getByText('Git Tools',{exact:true}).waitFor();
    assert.ok((await plugins.innerText()).includes('미설치'));
    assert.ok((await plugins.innerText()).includes('사용 불가'));
    await page.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/plugins-result-ui.png')});
    await plugins.getByRole('textbox',{name:'목록 검색'}).fill('Browser');
    assert.equal(await plugins.locator('[data-plugin-result]').count(),1);
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/memories');
    await page.locator('[data-memory-summary]').getByText(/Fixture memory summary/).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/fast');
    const fast=page.locator('[data-codex-fast-settings]');
    await fast.waitFor();
    assert.equal((await app.evaluate(()=>globalThis.__calls)).filter(call=>call[0]==='fast').length,0,'opening the picker must not change fast processing');
    await fast.getByRole('button',{name:'빠른 처리 켜기',exact:true}).click();
    await fast.getByText('이 세션의 빠른 처리를 켰습니다.',{exact:true}).waitFor();
    await fast.getByRole('button',{name:'빠른 처리 끄기',exact:true}).click();
    await fast.getByRole('alert').getByText('fixture fast unavailable',{exact:true}).waitFor();
    assert.ok(!(await fast.getByRole('alert').innerText()).includes('MsgError'));
    assert.ok(!(await fast.getByRole('alert').innerText()).includes('chat:codex-control'));
    await fast.getByText('이 세션의 빠른 처리를 켰습니다.',{exact:true}).waitFor();
    await fast.getByRole('button',{name:'빠른 처리 끄기',exact:true}).click();
    await fast.getByText('이 세션의 빠른 처리를 껐습니다.',{exact:true}).waitFor();
    assert.equal(await fast.getByRole('alert').count(),0);
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/fast invalid');
    await page.getByText('/fast on 또는 /fast off로 입력해 주세요.',{exact:true}).waitFor();
    for(const [text,message] of [['/memories off','메모리 사용을 껐습니다'],['/fast on','빠른 처리를 켰습니다'],['/fast off','빠른 처리를 껐습니다'],['/stop','터미널 중단 요청을 처리했습니다']]){
      await submit(text);
      const result=page.locator('[data-command-confirmation]');
      await result.getByText(new RegExp(message)).waitFor();
      assert.equal(await page.locator('[data-command-refresh]').count(),0,'mutation results must not repeat the operation on refresh');
      await page.getByRole('button',{name:'닫기',exact:true}).click();
    }
    await submit('/ps');
    await page.getByText('실행 중인 백그라운드 터미널이 없습니다.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/memories');
    await page.getByText(/표시할 메모리 요약이 없습니다/).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/debug-config');
    const diagnostics=page.locator('[data-codex-result="debug-config"]');
    assert.equal(await diagnostics.locator('pre').count(),0);
    await diagnostics.getByText('설정 원문 펼치기',{exact:true}).click();
    await diagnostics.locator('pre').waitFor();
    assert.ok((await diagnostics.locator('pre').innerText()).includes('••••'));
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/diff');
    await page.getByText('변경된 파일이 없습니다.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/resume');
    await page.getByText('이어갈 다른 Codex 대화가 없습니다.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/goal clear');
    await submit('/skills example'); assert.equal(await input.inputValue(),'$example');
    await input.fill('/res'); await page.locator('[data-palette-row="command"]').filter({hasText:'/resume'}).waitFor();
    await input.press('Escape');
    await submit('/usage');
    const usage=page.locator('[data-codex-result="usage"]');
    await usage.waitFor();
    assert.equal(await usage.locator('[role="progressbar"]').count(),2);
    assert.equal(await usage.locator('[role="progressbar"]').first().getAttribute('aria-valuenow'),'37');
    assert.ok((await usage.innerText()).includes('5시간'));
    assert.ok((await usage.innerText()).includes('7일'));
    assert.ok((await usage.innerText()).includes('초기화 시각 미제공'));
    assert.ok((await usage.innerText()).includes('기본 사용이 제한'));
    await usage.locator('[data-command-refresh]').click();
    await page.waitForFunction(()=>document.querySelector('[data-codex-result="usage"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='42');
    await usage.locator('[data-command-refresh]').click();
    await usage.getByRole('alert').filter({hasText:'fixture usage unavailable'}).waitFor();
    assert.ok(!(await usage.getByRole('alert').innerText()).includes('chat:codex-control'));
    assert.equal(await usage.locator('[role="progressbar"]').first().getAttribute('aria-valuenow'),'42','refresh errors retain the last successful result');
    await page.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/usage-result-ui.png')});
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/mcp'); await page.getByRole('dialog',{name:'/mcp',exact:true}).waitFor();
    const mcp=page.locator('[data-codex-result="mcp"]');
    assert.equal(await mcp.locator('[data-mcp-server]').count(),3);
    assert.ok((await mcp.locator('[data-mcp-summary]').innerText()).includes('연결됨 1개'));
    assert.equal(await mcp.locator('[data-mcp-tool]').count(),0);
    await mcp.getByRole('button',{name:/GitHub/}).click();
    await mcp.getByText('Find issues in a repository').waitFor();
    assert.equal(await mcp.locator('[data-mcp-tool]').count(),2);
    assert.ok((await mcp.innerText()).includes('상태 미제공'));
    assert.ok(!(await mcp.innerText()).includes('inputSchema'));
    assert.ok(!(await mcp.innerText()).includes('token=fixture'));
    await page.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/mcp-result-ui.png')});
    await mcp.getByRole('textbox',{name:'서버 또는 도구 검색'}).fill('read_file');
    await page.waitForFunction(()=>document.querySelectorAll('[data-mcp-tool]').length===1);
    await mcp.getByRole('textbox',{name:'서버 또는 도구 검색'}).fill('no-such-tool');
    await mcp.getByText('검색 결과가 없습니다.').waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await submit('/logout'); await page.getByText(/\/logout 명령은 아직 Sudal/).waitFor();
    await page.evaluate(id=>window.sudal.chat.configure(id,{provider:'claude'}),tabId);
    await input.fill('/');
    await commandRow('compact').locator('[data-command-source="claude"]').waitFor();
    await commandRow('config').locator('[data-command-source="sudal"]').waitFor();
    await input.press('Escape');
    await input.fill('');
    await page.evaluate(id=>window.sudal.chat.configure(id,{provider:'agy'}),tabId);
    await input.fill('/');
    await commandRow('plan').locator('[data-command-source="agy"]').waitFor();
    await input.press('Escape');
    await page.evaluate(id=>window.sudal.chat.configure(id,{provider:'codex'}),tabId);
    await input.fill('');
    await app.evaluate(({BrowserWindow},id)=>{
      const contents=BrowserWindow.getAllWindows()[0].webContents;
      contents.send('chat:event',{tabId:id,sequence:1,event:{type:'permission_request',ts:Date.now(),requestId:'question',toolUseId:'question',tool:'AskUserQuestion',canAlwaysAllow:false,input:{questions:[{question:'Which path?',answerKey:'q1',allowOther:false,options:[{label:'A',description:'fixture answer'}]}]}}});
      contents.send('chat:event',{tabId:id,sequence:2,event:{type:'status',ts:Date.now(),status:'waiting_permission'}});
    },tabId);
    await page.locator('[data-question-prompt]').waitFor();
    assert.equal(await page.locator('[data-question-other]').count(),0);
    await page.locator('[data-question-option]').click();
    await page.locator('[data-question-prompt]').waitFor({state:'hidden'});
    const calls=await app.evaluate(()=>globalThis.__calls);
    assert.equal(calls.filter(c=>c[0]==='send').length,0,'commands and goals must not become model prompts');
    assert.ok(calls.some(c=>c[0]==='mcp'));
    assert.equal(calls.filter(c=>c[0]==='stop').length,1);
    assert.deepEqual(calls.find(c=>c[0]==='answer')[1].answers,{q1:'A'});
    await app.evaluate(({BrowserWindow},id)=>{
      const contents=BrowserWindow.getAllWindows()[0].webContents;
      contents.send('chat:event',{tabId:id,sequence:5,event:{type:'assistant_text',ts:Date.now(),blockId:'native-review',text:'네이티브 리뷰 결과 확인'}});
      contents.send('chat:event',{tabId:id,sequence:6,event:{type:'turn_result',ts:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0},costUsd:0,durationMs:1,numTurns:1,modelUsage:{},isError:false}});
      contents.send('chat:event',{tabId:id,sequence:7,event:{type:'compacted',ts:Date.now(),trigger:'manual'}});
    },tabId);
    await page.getByText('네이티브 리뷰 결과 확인',{exact:true}).waitFor();
    const compacted=page.locator('[data-compacted="manual"]');
    await compacted.waitFor();
    assert.ok((await compacted.innerText()).includes('토큰 수 미제공'));
    assert.ok(!(await compacted.innerText()).includes('0k'));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,nativeReviewOutput:true,compactionWithoutTokenCount:true,formattedStatus:true,formattedTerminals:true,formattedHooks:true,formattedPlugins:true,memorySummary:true,mutationConfirmation:true,noMutationRefresh:true,emptyDiffAndResume:true,foldedDiagnostics:true,formattedUsage:true,usageRefresh:true,refreshErrorPreservesData:true,formattedMcp:true,mcpSearch:true,commandSourceBadges:true,planBadge:true,goalControls:true,goalNoDuplicatePrompt:true,skillsArguments:true,resumeInPalette:true,codexMcp:true,unsupportedBlocked:true,planningQuestionAnswer:true}));
  } catch(error) {
    if(app) {
      const failedPage=await app.firstWindow();
      console.error(JSON.stringify({visibleText:(await failedPage.locator('body').innerText()).slice(-8000),calls:await app.evaluate(()=>globalThis.__calls)}));
      await failedPage.screenshot({path:path.join(repo,'.sudal/codex-slash-audit/command-failure-ui.png')});
    }
    throw error;
  } finally {
    await app?.close();
    const target=path.resolve(profile);
    if(!target.startsWith(path.resolve(os.tmpdir())+path.sep+'sudal-codex-commands-'))throw new Error('Unexpected cleanup path');
    await fs.promises.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
