// Real CLI, control server, renderer, and restart. Isolated profile; no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron } = require('playwright-core');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-tab-parent-e2e-'));
  const home = path.join(profile, 'home'); fs.mkdirSync(home);
  const disabled = path.join(profile, 'disabled.cmd'); fs.writeFileSync(disabled, '@exit /b 1\r\n');
  fs.writeFileSync(path.join(profile, 'cli-overrides.json'), JSON.stringify({codex:disabled,claude:disabled,agy:disabled}));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({language:'ko',warmTarget:'off',otter:false,notifyOnDone:'off'}));
  const now = Date.now();
  const tab = (id, title) => ({id,title,workspaceId:'ws',provider:'codex',policy:'ask',sessionId:null,createdAt:now,updatedAt:now,open:true,cwd:home});
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({version:1,
    workspaces:[{id:'ws',name:'탭 부모 연결 검사',path:home,addedAt:now,lastUsedAt:now}],
    tabs:[tab('caller','호출 탭'),tab('visible','화면의 탭')],openTabIds:['caller','visible'],activeTabId:'visible'}));
  const bootstrap = path.join(profile, 'main.mjs');
  fs.writeFileSync(bootstrap, `import {app} from 'electron';
    app.setPath('userData',${JSON.stringify(profile)}); app.setPath('home',${JSON.stringify(home)});
    ${process.env.SUDAL_E2E_OFFSCREEN !== '0' ? `app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.on('browser-window-created',(_event,win)=>{const show=win.showInactive.bind(win);win.webContents.setBackgroundThrottling(false);win.setIgnoreMouseEvents(true);win.show=()=>{win.setPosition(-10000,-10000);show();};win.focus=()=>{};});` : ''}
    await import(${JSON.stringify(pathToFileURL(path.join(repo, 'out/main/index.js')).href)});`);
  const env = {...process.env,USERPROFILE:home};
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const cliEnv = {...process.env,SUDAL_USERDATA:profile,SUDAL_TAB_ID:'caller'};
  delete cliEnv.SUDAL_SOCKET; // Never connect to the user's running app.
  const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath,
    [path.join(repo,'cli/sudal.cjs'),...args],{cwd:repo,env:cliEnv,timeout:15000})).stdout);
  let app;
  const errors = [];
  try {
    app = await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    let page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    await page.locator('[data-sidebar] [data-session="caller"]').waitFor();
    const ordinary = (await cli('tab','new','--provider','codex','--title','일반 탭')).tab.id;
    const continuation = (await cli('tab','new','--provider','codex','--title','이어서')).tab.id;
    const worker = (await cli('tab','new','--provider','codex','--title','명시적 워커','--parent','self')).tab.id;
    const check = async () => {
      const sidebar = page.locator('[data-sidebar]');
      for (const id of [ordinary,continuation,worker]) await sidebar.locator(`[data-session="${id}"]`).waitFor();
      for (const id of [ordinary,continuation]) {
        assert.equal(await sidebar.locator(`[data-session-agent="tab:${id}"]`).count(),0,'ordinary and handoff tabs stay independent');
      }
      await sidebar.locator(`[data-session-agent="tab:${worker}"]`).waitFor();
      const state = await page.evaluate(() => window.sudal.workspaces.state());
      for (const id of [ordinary,continuation]) assert.equal(state.model.tabs.find(t=>t.id===id).parentTabId,undefined);
      assert.equal(state.model.tabs.find(t=>t.id===worker).parentTabId,'caller');
      assert.equal(state.agents.caller.find(row=>row.tabId===worker).kind,'worker');
      assert.equal(state.model.activeTabId,'visible','creating tabs does not switch the visible conversation');
    };
    await check();
    await app.close(); app = undefined;
    app = await _electron.launch({args:[bootstrap],cwd:repo,env,timeout:30000});
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    await check();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,ordinaryIndependent:true,continuationIndependent:true,explicitWorkerLinked:true,restartPreserved:true,noModelCalls:true}));
  } finally {
    await app?.close();
    if(path.dirname(path.resolve(profile))!==path.resolve(os.tmpdir())||!path.basename(profile).startsWith('sudal-tab-parent-e2e-')) throw Error('Unexpected cleanup path');
    await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
