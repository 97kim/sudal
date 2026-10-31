// Isolated app + real Git/verification + fake Codex App Server. No account or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {_electron} = require('playwright-core');

(async()=>{
  const repo=path.resolve(__dirname,'..');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sudal-feedback-e2e-'));
  const project=path.join(profile,'project'), home=path.join(profile,'home');
  fs.mkdirSync(project);fs.mkdirSync(home);
  const git=(...args)=>execFileSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+home,...args],{cwd:project,windowsHide:true,stdio:'pipe'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(project,'value.cjs'),'module.exports = false;\n');
  fs.writeFileSync(path.join(project,'check.cjs'),"if(require('./value.cjs')!==true){console.error('expected true, received false');process.exit(1)}\n");
  git('add','.');git('commit','-qm','테스트 초기 상태');
  const requests=path.join(profile,'requests.jsonl');fs.writeFileSync(requests,'');
  const holdRepair=path.join(profile,'hold-repair');
  const fake=path.join(profile,'codex.cjs');
  fs.writeFileSync(fake,`
    if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.166.0\\n');process.exit(0);}
    const fs=require('node:fs');const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let repairTimer;
    require('node:readline').createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line',line=>{
      const request=JSON.parse(line);if(request.id===undefined||!request.method)return;
      fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(request)+'\\n');
      const reply=result=>send({id:request.id,result});
      if(request.method==='thread/start'||request.method==='thread/resume')return reply({thread:{id:'fixture-thread'},model:'fixture'});
      if(request.method==='turn/start'){
        
        reply({turn:{id:'repair'}});
        send({method:'turn/started',params:{threadId:'fixture-thread',turn:{id:'repair'}}});
        const finish=()=>{
          fs.writeFileSync(${JSON.stringify(path.join(project,'value.cjs'))},'module.exports = true;\\n');
          send({method:'item/completed',params:{threadId:'fixture-thread',turnId:'repair',item:{type:'agentMessage',id:'answer',text:'검증 실패 원인을 수정했습니다.'}}});
          send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'repair',status:'completed'}}});
        };
        repairTimer=setTimeout(finish,fs.existsSync(${JSON.stringify(holdRepair)})?30000:40);return;
      }
      if(request.method==='turn/interrupt'){clearTimeout(repairTimer);reply({});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'repair',status:'interrupted'}}});return;}
      reply({data:[],goal:null});
    });
  `);
  let executable, disabled;
  if(process.platform==='win32'){
    executable=path.join(profile,'codex.cmd');disabled=path.join(profile,'disabled.cmd');
    fs.writeFileSync(executable,'@echo off\r\nnode "%~dp0\\codex.cjs" %*\r\n');fs.writeFileSync(disabled,'@exit /b 1\r\n');
  }else{
    executable=path.join(profile,'codex');disabled=path.join(profile,'disabled');
    fs.writeFileSync(executable,'#!/usr/bin/env node\n'+fs.readFileSync(fake,'utf8'),{mode:0o755});fs.writeFileSync(disabled,'#!/bin/sh\nexit 1\n',{mode:0o755});
  }
  const tabId='feedback-test', now=Date.now();
  fs.writeFileSync(path.join(profile,'cli-overrides.json'),JSON.stringify({codex:executable,claude:disabled,agy:disabled}));
  fs.writeFileSync(path.join(profile,'trusted-folders.json'),JSON.stringify([project]));
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({warmTarget:'off',otter:false,language:'ko',notifyOnDone:'off'}));
  fs.writeFileSync(path.join(profile,'workspaces.json'),JSON.stringify({version:1,workspaces:[{id:'ws',name:'Feedback fixture',path:project,addedAt:now,lastUsedAt:now,verifyCommands:['node check.cjs']}],tabs:[{id:tabId,workspaceId:'ws',title:'Verification feedback',titleCustom:true,provider:'codex',policy:'ask',sessionId:null,createdAt:now,updatedAt:now,open:true}],openTabIds:[tabId],activeTabId:tabId}));
  const bootstrap=path.join(profile,'main.mjs');
  fs.writeFileSync(bootstrap,`import {app} from 'electron';app.setPath('userData',${JSON.stringify(profile)});app.setPath('home',${JSON.stringify(home)});await import(${JSON.stringify(pathToFileURL(path.join(repo,'out/main/index.js')).href)});`);
  let app;
  try{
    const env={...process.env,USERPROFILE:home,HOME:home,SUDAL_APPROVED_ROOTS:project};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
    app=await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.locator('[data-composer] textarea').waitFor({timeout:15000});
    const rpc=action=>page.evaluate(({id,action})=>window.sudal.chat.harness(id,action),{id:tabId,action});
    assert.equal((await rpc({type:'snapshot'})).enabled,false);
    const hp=page.locator('[data-harness-panel]');
    await hp.getByRole('button',{name:'작업 환경',exact:true}).click();
    await hp.getByRole('checkbox',{name:'하네스 사용',exact:true}).click();
    await hp.getByRole('button',{name:'작업 시작',exact:true}).click();
    await hp.getByLabel('작업 목표',{exact:true}).fill('요청 기록 보존');
    await hp.getByLabel('완료 조건 · 한 줄에 하나',{exact:true}).fill('재시작 후 기록 유지 | node check.cjs');
    await hp.getByRole('button',{name:'변경 적용',exact:true}).click();
    await hp.getByText('재시작 후 기록 유지 · 미확인',{exact:true}).waitFor();
    let state=await rpc({type:'snapshot'});const task=state.tasks[0];
    await assert.rejects(rpc({type:'status',taskId:task.id,status:'completed'}));
    await hp.getByRole('checkbox',{name:'재시작 후 기록 유지 · 미확인',exact:true}).check();
    await hp.getByLabel('검증 명령 · 한 줄에 하나',{exact:true}).fill('node -e "process.exit(0)"');
    await hp.getByRole('button',{name:'선택 항목 검증',exact:true}).click();
    const deadline=Date.now()+15000;
    do {state=await rpc({type:'snapshot'});if(state.tasks[0].evidence.length)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
    assert.equal(state.tasks[0].evidence[0].result,'passed');
    await page.evaluate(id=>window.sudal.chat.send(id,{text:'작업 기준을 확인해줘'}),tabId);
    const requestDeadline=Date.now()+15000;let rows;
    do {rows=fs.readFileSync(requests,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);if(rows.some(row=>row.method==='turn/start'))break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<requestDeadline);
    const turn=rows.find(row=>row.method==='turn/start');assert.ok(turn);assert.match(JSON.stringify(turn.params.input),/sudal-task-context/);assert.match(JSON.stringify(turn.params.input),/요청 기록 보존/);
    const events=await page.evaluate(id=>window.sudal.chat.events(id),tabId);
    assert.ok(events.find(event=>event.type==='user_message'&&event.text==='작업 기준을 확인해줘'));
    fs.writeFileSync(path.join(project,'changed.txt'),'new revision');
    state=await rpc({type:'snapshot'});assert.notEqual(state.revision,state.tasks[0].evidence[0].codeRevision);
    await rpc({type:'status',taskId:task.id,status:'completed',reason:'앱 확인은 다음 작업에서 수행'});
    fs.writeFileSync(path.join(project,'value.cjs'),'module.exports = false;\n');
    state=await rpc({type:'start',goal:'자동 수정 후 근거 확인',criteria:[{description:'검증 명령 통과',method:'node check.cjs'}]});
    const repairTask=state.tasks.find(item=>item.status==='active');
    await rpc({type:'verify',taskId:repairTask.id,criterionIds:[repairTask.criteria[0].id],commands:['node check.cjs'],autoRepair:true});
    const repairDeadline=Date.now()+30000;
    do {state=await rpc({type:'snapshot'});if(state.tasks.find(item=>item.id===repairTask.id).evidence.length)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<repairDeadline);
    assert.equal(state.tasks.find(item=>item.id===repairTask.id).evidence[0].result,'passed');
    await rpc({type:'enable',enabled:false});
    state=await rpc({type:'snapshot'});assert.equal(state.tasks[0].status,'completed');assert.equal(state.tasks[0].evidence.length,1);
    await rpc({type:'enable',enabled:true});
    await page.reload();
    await page.locator('[data-harness-panel]').getByRole('button',{name:'작업 환경',exact:true}).click();
    await page.locator('[data-harness-panel]').getByRole('button',{name:'작업 기록',exact:true}).click();
    await page.getByText('요청 기록 보존 · 완료',{exact:true}).waitFor();
    await page.screenshot({path:path.join(repo,'.sudal/harness-ui.png')});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,projectToggle:true,taskCard:true,realVerification:true,evidenceAssociation:true,contextInjection:true,rawUserHistoryPreserved:true,staleEvidence:true,completionReason:true,recordsPreserved:true}));
  }catch(error){if(app){const page=await app.firstWindow();console.error((await page.locator('body').innerText()).slice(-5000));await page.screenshot({path:path.join(repo,'.sudal/verification-feedback-failure.png')});}throw error;}
  finally{await app?.close();const target=path.resolve(profile);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('sudal-feedback-e2e-'))throw Error('Unexpected cleanup path');await fs.promises.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
})().catch(error=>{console.error(error);process.exitCode=1;});
