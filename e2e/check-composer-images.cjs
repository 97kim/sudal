// Isolated Electron profile and real file inputs. Sends are mocked; no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright-core');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-composer-images-'));
  const home = path.join(profile, 'home'); fs.mkdirSync(home);
  const disabled = path.join(profile, 'disabled.cmd'); fs.writeFileSync(disabled, '@exit /b 1\r\n');
  fs.writeFileSync(path.join(profile,'cli-overrides.json'),JSON.stringify({codex:disabled,claude:disabled,agy:disabled}));
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({language:'ko',warmTarget:'off',otter:false,notifyOnDone:'off'}));
  const now=Date.now();
  const tab=id=>({id,title:id,workspaceId:'ws',provider:'codex',policy:'ask',sessionId:null,createdAt:now,updatedAt:now,open:true,cwd:home});
  fs.writeFileSync(path.join(profile,'workspaces.json'),JSON.stringify({version:1,
    workspaces:[{id:'ws',name:'이미지 초안 검사',path:home,addedAt:now,lastUsedAt:now}],
    tabs:[tab('tab-a'),tab('tab-b')],openTabIds:['tab-a','tab-b'],activeTabId:'tab-a'}));
  const bootstrap=path.join(profile,'main.mjs');
  fs.writeFileSync(bootstrap,`import {app,ipcMain} from 'electron';
    app.setPath('userData',${JSON.stringify(profile)});app.setPath('home',${JSON.stringify(home)});
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.on('browser-window-created',(_event,win)=>{const show=win.showInactive.bind(win);win.webContents.setBackgroundThrottling(false);win.setIgnoreMouseEvents(true);win.show=()=>{win.setPosition(-10000,-10000);show();};win.focus=()=>{};});
    globalThis.__sends=[];
    const handle=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(channel,fn)=>handle(channel,channel==='chat:send'?async(_event,id,payload)=>{
      globalThis.__sends.push({id,payload});
      if(globalThis.__failSend){globalThis.__failSend=false;return {ok:false,error:'fixture send rejected'};}
      if(globalThis.__holdSend)await new Promise(resolve=>{globalThis.__releaseSend=resolve;});
      return {ok:true};
    }:fn);
    await import(${JSON.stringify(pathToFileURL(path.join(repo,'out/main/index.js')).href)});`);
  const env={...process.env,USERPROFILE:home};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNSkAAAAASUVORK5CYII=';
  let app;
  try {
    app=await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    const page=await app.firstWindow();page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const composer=page.locator('[data-composer]');
    const input=composer.locator('textarea');
    await input.waitFor();
    const attach=async name=>composer.locator('input[type="file"][accept]').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(base64,'base64')});
    const switchTo=async id=>{
      await page.locator(`[data-sidebar] [data-session="${id}"]`).click();
      await page.locator(`[data-tab="${id}"][data-active="true"]`).waitFor();
      await page.locator(`[data-composer][data-composer-tab="${id}"]`).waitFor();
    };
    await switchTo('tab-a');
    await input.fill('첫 번째 탭의 초안');
    await attach('first.png');await composer.getByRole('img',{name:'first.png',exact:true}).waitFor();
    await switchTo('tab-b');
    assert.equal(await input.inputValue(),'');assert.equal(await composer.locator('img').count(),0);
    await input.fill('두 번째 탭의 초안');
    await attach('second.png');await composer.getByRole('img',{name:'second.png',exact:true}).waitFor();
    for(let i=0;i<3;i++){
      await switchTo('tab-a');
      await composer.getByRole('img',{name:'first.png',exact:true}).waitFor();
      assert.equal(await input.inputValue(),'첫 번째 탭의 초안');assert.equal(await composer.locator('img').count(),1);
      await switchTo('tab-b');
      await composer.getByRole('img',{name:'second.png',exact:true}).waitFor();
      assert.equal(await input.inputValue(),'두 번째 탭의 초안');assert.equal(await composer.locator('img').count(),1);
    }
    await switchTo('tab-a');
    await composer.getByRole('img',{name:'first.png',exact:true}).locator('..').getByRole('button').click();
    await switchTo('tab-b');await switchTo('tab-a');
    assert.equal(await composer.locator('img').count(),0,'removed attachments must stay removed');

    await page.evaluate(()=>{
      const read=FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL=function(file){
        if(window.__delayImageRead){window.__delayImageRead=false;window.__resumeImageRead=()=>new Promise(resolve=>{this.addEventListener('loadend',resolve,{once:true});read.call(this,file);});}
        else read.call(this,file);
      };
      window.__delayImageRead=true;
    });
    await attach('delayed.png');
    await switchTo('tab-b');
    await page.evaluate(()=>window.__resumeImageRead());
    assert.equal(await composer.locator('img').count(),1,'late reads must not leak into the visible tab');
    assert.equal(await composer.getByRole('img',{name:'second.png',exact:true}).count(),1);
    await switchTo('tab-a');
    await composer.getByRole('img',{name:'delayed.png',exact:true}).waitFor();
    assert.equal(await composer.locator('img').count(),1,'late image reads must return to their original tab');
    const kv=await page.evaluate(()=>window.sudal.state.load());
    assert.ok(!JSON.stringify(kv).includes(base64),'image bytes must not enter renderer-state storage');

    await app.evaluate(()=>{globalThis.__failSend=true;});
    await input.press('Enter');await composer.getByText('fixture send rejected',{exact:true}).waitFor();
    await switchTo('tab-b');await switchTo('tab-a');
    await composer.getByRole('img',{name:'delayed.png',exact:true}).waitFor();
    assert.equal(await input.inputValue(),'첫 번째 탭의 초안','failed sends must keep the draft');
    await page.waitForFunction(async()=>(await window.sudal.state.load())['composerDraft.tab-a']==='첫 번째 탭의 초안');
    await app.evaluate(()=>{globalThis.__holdSend=true;});
    await input.press('Enter');
    for(let i=0;i<100 && !await app.evaluate(()=>!!globalThis.__releaseSend);i++)await page.waitForTimeout(20);
    assert.ok(await app.evaluate(()=>!!globalThis.__releaseSend));
    await switchTo('tab-b');
    await app.evaluate(()=>{globalThis.__holdSend=false;globalThis.__releaseSend();});
    await page.waitForFunction(async()=>!Object.hasOwn(await window.sudal.state.load(),'composerDraft.tab-a'));
    await switchTo('tab-a');
    await page.waitForFunction(()=>document.querySelector('[data-composer] textarea')?.value==='');
    assert.equal(await composer.locator('img').count(),0,'successful sends must clear an unmounted draft');
    await switchTo('tab-b');
    await composer.getByRole('img',{name:'second.png',exact:true}).waitFor();
    await input.fill('');await input.press('Enter');
    await composer.getByRole('img',{name:'second.png',exact:true}).waitFor({state:'detached'});
    const sends=await app.evaluate(()=>globalThis.__sends);
    assert.equal(sends.length,3);
    assert.equal(sends[1].id,'tab-a');assert.equal(sends[1].payload.images[0].name,'delayed.png');
    assert.equal(sends[2].id,'tab-b');assert.equal(sends[2].payload.text,'');assert.equal(sends[2].payload.images[0].base64,base64);
    assert.equal(sends[2].payload.images.length,1,'another tab must never inherit the late image');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,tabIsolation:true,repeatedSwitches:true,removalPreserved:true,lateReadPreserved:true,failedSendPreserved:true,sendWhileAwayCleared:true,imageOnlySend:true,noImageDiskPersistence:true,noModelCalls:true}));
  }catch(error){
    if(app){const page=await app.firstWindow();console.error(JSON.stringify(await page.evaluate(async()=>({composers:[...document.querySelectorAll('[data-composer]')].map(el=>({tab:el.dataset.composerTab,text:el.querySelector('textarea')?.value,images:[...el.querySelectorAll('img')].map(img=>img.alt)})),active:(await window.sudal.workspaces.state()).model.activeTabId,drafts:await window.sudal.state.load()}))));}
    throw error;
  }finally{
    await app?.close();
    if(path.dirname(path.resolve(profile))!==path.resolve(os.tmpdir())||!path.basename(profile).startsWith('sudal-composer-images-'))throw Error('Unexpected cleanup path');
    await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
