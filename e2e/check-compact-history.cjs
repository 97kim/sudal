// Real renderer/persistence, isolated profile, no account or CLI calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright-core');
(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-compact-e2e-'));
  const home = path.join(profile, 'home'), tab = 'compact-history', now = Date.now();
  fs.mkdirSync(home); fs.mkdirSync(path.join(profile, 'threads'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', warmTarget: 'off', otter: false, language: 'ko', notifyOnDone: 'off' }));
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ version: 1,
    workspaces: [{ id: 'ws', name: 'Sudal', path: profile, addedAt: now, lastUsedAt: now }],
    tabs: [{ id: tab, workspaceId: 'ws', title: '압축 기록 미리보기', titleCustom: true, provider: 'codex', policy: 'ask', sessionId: null, createdAt: now, updatedAt: now, open: true }], openTabIds: [tab], activeTabId: tab }));
  const events = [];
  for (let i = 0; i < 450; i++) events.push({ type: 'user_message', id: `old-${i}`, ts: now + i, text: `old-message-${i} ` + '이전 대화 본문 '.repeat(100) });
  events.push({ type: 'user_message', id: 'compact-command', ts: now + 500, text: '/compact' }, { type: 'compacted', ts: now + 501, trigger: 'manual' },
    { type: 'assistant_text', blockId: 'recent', ts: now + 502, text: '압축 이후의 새 대화입니다.' });
  const thread = path.join(profile, 'threads', tab + '.jsonl');
  fs.writeFileSync(thread, events.map(JSON.stringify).join('\n') + '\n');
  const bootstrap = path.join(profile, 'main.mjs');
  fs.writeFileSync(bootstrap, `import {app,ipcMain,BrowserWindow} from 'electron';import{appendFileSync}from'node:fs';
    app.setPath('userData',${JSON.stringify(profile)});app.setPath('home',${JSON.stringify(home)});
    const handle=ipcMain.handle.bind(ipcMain);globalThis.__holdOlder=false;
    ipcMain.handle=(channel,fn)=>handle(channel,channel==='chat:history'?async(...args)=>{if(args[2]&&globalThis.__holdOlder)await new Promise(r=>setTimeout(r,400));if(args[2]&&globalThis.__failOlder){globalThis.__failOlder=false;throw Error('archive unavailable');}return fn(...args);}:fn);
    globalThis.__push=events=>{const contents=BrowserWindow.getAllWindows()[0].webContents;for(const event of events){appendFileSync(${JSON.stringify(thread)},JSON.stringify(event)+'\\n');contents.send('chat:event',{tabId:${JSON.stringify(tab)},event,sequence:++globalThis.__seq});}};globalThis.__seq=1000;
    await import(${JSON.stringify(pathToFileURL(path.join(repo,'out/main/index.js')).href)});`);
  let app;
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 30000 });
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const list = page.locator('[data-message-list]');
    await page.locator('[data-compact-history="collapsed"]').waitFor();
    assert.equal(await list.getAttribute('data-history-count'), '3');
    assert.equal(await page.locator('[data-block-id="old-449"]').count(), 0);
    assert.equal(await page.locator('[data-block-id="compact-command"]').count(), 1);
    await app.evaluate(() => { globalThis.__holdOlder = true; globalThis.__failOlder = true; });
    await page.locator('[data-compact-history] button').click();
    await page.locator('[data-compact-history] button[aria-busy="true"]').waitFor();
    assert.equal(await page.locator('[data-older-history]').count(), 0, 'opening archive must not advertise unloaded pages');
    await page.getByRole('alert').filter({ hasText: 'archive unavailable' }).waitFor();
    assert.equal(await page.locator('[data-compact-history="collapsed"]').count(), 1);
    assert.equal(await list.getAttribute('data-history-count'), '3');
    await app.evaluate(() => globalThis.__holdOlder = false);
    await page.locator('[data-compact-history] button').click();
    await page.waitForFunction(() => +document.querySelector('[data-message-list]').dataset.historyCount > 3);
    assert.equal(await page.locator('[data-compact-history="expanded"]').count(), 1);
    // Collapse while an additional archive page is in flight. Its late response must not reopen the archive.
    await app.evaluate(() => globalThis.__holdOlder = true);
    await page.evaluate(() => document.querySelector('[data-older-history] button')?.click());
    await page.evaluate(() => document.querySelector('[data-compact-history] button').click());
    await page.waitForSelector('[data-history-count="3"]');
    await page.waitForTimeout(600);
    assert.equal(await list.getAttribute('data-history-count'), '3');
    // Search must explicitly expand the archive and hydrate the original body.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:shortcut','search'));
    await page.locator('[data-search-palette] input').fill('old-message-440');
    await page.locator('[data-search-hit]').first().click();
    await page.locator('[data-block-id="old-440"]').waitFor();
    assert.match(await page.locator('[data-block-id="old-440"]').innerText(), /이전 대화 본문/);
    // A new successful compaction folds an already expanded archive and preserves live tail events.
    await app.evaluate(() => globalThis.__push([{ type:'user_message', id:'second-command', ts:Date.now(), text:'/compact' },{type:'compacted',ts:Date.now()+1,trigger:'manual'},{type:'assistant_text',blockId:'after-second',ts:Date.now()+2,text:'두 번째 압축 이후'}]));
    await page.locator('[data-compact-history="collapsed"]').waitFor();
    await page.locator('[data-block-id="after-second"]').waitFor();
    assert.equal(await list.getAttribute('data-history-count'), '3');
    await page.screenshot({path:path.join(repo,'.sudal/compact-history-ui.png')});
    await page.reload();
    await page.locator('[data-compact-history="collapsed"]').waitFor();
    assert.equal(await list.getAttribute('data-history-count'), '3');
    assert.equal((await page.evaluate(id=>window.sudal.chat.events(id),tab)).filter(event=>event.type==='user_message'&&event.id==='old-0').length,1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed:true, recentFirst:true, archiveOnDemand:true, stalePageFenced:true, searchHydrates:true, liveCompaction:true, reloadCollapsed:true, historyPreserved:true }));
  } finally {
    await app?.close();
    const target=path.resolve(profile);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('sudal-compact-e2e-'))throw Error('Unexpected cleanup path');
    await fs.promises.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
