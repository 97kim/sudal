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
        if(!JSON.stringify(request.params.input).includes('expected true, received false'))throw Error('diagnostics missing');
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
    await page.locator('[data-verify-edit]').click();
    await page.locator('[data-feedback-enabled]').check();
    await page.locator('[data-verify-run]').click();
    const panel=page.locator('[data-verification-feedback="passed"]');
    await panel.waitFor({timeout:30000});
    await panel.locator('summary').click();
    await panel.getByText('expected true, received false',{exact:false}).waitFor();
    assert.match(fs.readFileSync(path.join(project,'value.cjs'),'utf8'),/true/);
    const rows=fs.readFileSync(requests,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(rows.filter(row=>row.method==='turn/start').length,1);
    assert.equal(rows.find(row=>row.method==='turn/start').params.approvalPolicy,'untrusted');
    assert.equal(rows.find(row=>row.method==='turn/start').params.sandboxPolicy.type,'readOnly');
    const state=await page.evaluate(id=>window.sudal.chat.feedbackSnapshot(id),tabId);
    assert.equal(state.attempt,1);assert.equal(state.phase,'passed');
    fs.mkdirSync(path.join(repo,'.sudal'),{recursive:true});
    await page.screenshot({path:path.join(repo,'.sudal/verification-feedback-ui.png')});
    await page.locator('[data-verify-edit]').click();
    await page.locator('[data-verify-commands]').fill('node -e "setTimeout(() => {}, 30000)"');
    await page.locator('[data-verify-run]').click();
    await page.locator('[data-verification-feedback="checking"]').waitFor();
    await page.evaluate(id=>window.sudal.chat.codexControl(id,'status',''),tabId);
    assert.equal((await page.evaluate(id=>window.sudal.chat.feedbackSnapshot(id),tabId)).phase,'checking','read-only commands must not cancel automatic verification');
    await page.getByText('node -e "setTimeout(() => {}, 30000)"',{exact:true}).waitFor({timeout:15000});
    await page.getByRole('button',{name:'자동 수정 중단',exact:true}).click();
    await page.locator('[data-verification-feedback="stopped"]').waitFor({timeout:15000});
    assert.ok((await page.evaluate(id=>window.sudal.chat.events(id),tabId)).some(event=>event.type==='verify'&&event.status==='aborted'));
    fs.writeFileSync(path.join(project,'value.cjs'),'module.exports = false;\n');fs.writeFileSync(holdRepair,'hold');
    await page.locator('[data-verify-edit]').click();
    await page.locator('[data-verify-commands]').fill('node check.cjs');
    await page.locator('[data-verify-run]').click();
    const deadline=Date.now()+15000;
    const turnCount=()=>fs.readFileSync(requests,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.method==='turn/start').length;
    while(turnCount()<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(turnCount(),2);
    await page.locator('[data-verification-feedback="fixing"]').waitFor();
    await page.getByRole('button',{name:'자동 수정 중단',exact:true}).click();
    await page.locator('[data-verification-feedback="stopped"]').waitFor({timeout:15000});
    assert.match(fs.readFileSync(path.join(project,'value.cjs'),'utf8'),/false/);
    assert.equal((await page.evaluate(id=>window.sudal.chat.snapshot(id),tabId)).policy,'ask');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,realVerificationFailure:true,diagnosticDeliveredToFakeAgent:true,singleRepair:true,reverificationPassed:true,failureEvidenceVisible:true,verificationProcessStopped:true,agentRepairInterrupted:true,permissionPolicyPreserved:true,readOnlyCommandsDoNotCancel:true}));
  }catch(error){if(app){const page=await app.firstWindow();console.error((await page.locator('body').innerText()).slice(-5000));await page.screenshot({path:path.join(repo,'.sudal/verification-feedback-failure.png')});}throw error;}
  finally{await app?.close();const target=path.resolve(profile);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('sudal-feedback-e2e-'))throw Error('Unexpected cleanup path');await fs.promises.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
})().catch(error=>{console.error(error);process.exitCode=1;});
