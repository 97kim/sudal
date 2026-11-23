// A cold, folded log with its authoritative page deliberately held at the IPC boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright-core');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-history-preview-e2e-'));
  const home = path.join(profile, 'home');
  const threads = path.join(profile, 'threads');
  fs.mkdirSync(home);
  fs.mkdirSync(threads);
  const disabled = path.join(profile, process.platform === 'win32' ? 'disabled.cmd' : 'disabled');
  fs.writeFileSync(disabled, process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const now = Date.now();
  const tab = id => ({ id, title: id, titleCustom: true, workspaceId: 'workspace', provider: 'codex', policy: 'ask', sessionId: null, createdAt: now, updatedAt: now, open: true });
  const save = (name, value) => fs.writeFileSync(path.join(profile, name), JSON.stringify(value));
  save('cli-overrides.json', { codex: disabled, claude: disabled, agy: disabled });
  save('settings.json', { language: 'ko', warmTarget: 'off', otter: false, notifyOnDone: 'off' });
  save('workspaces.json', { version: 1, workspaces: [{ id: 'workspace', name: 'Preview fixture', path: home, addedAt: now, lastUsedAt: now }], tabs: [tab('short'), tab('long')], openTabIds: ['short', 'long'], activeTabId: 'short' });
  const events = [
    { type: 'assistant_text', blockId: 'large', text: '큰'.repeat(2 * 1024 * 1024), ts: now - 10 },
    { type: 'user_message', id: 'folded', text: '접힌 요청입니다.', ts: now - 9 },
    { type: 'compacted', trigger: 'auto', ts: now - 8 },
    { type: 'user_message', id: 'recent', text: '최근 요청입니다.', ts: now - 7 },
    { type: 'text_delta', blockId: 'answer', text: '최근 답변입니다.', ts: now - 6 },
    { type: 'review', reviewTabId: 'review-fixture', reviewer: 'agy', status: 'done', text: '정확한 카드 내용', ts: now - 5 },
  ];
  fs.writeFileSync(path.join(threads, 'long.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const bootstrap = path.join(profile, 'main.mjs');
  fs.writeFileSync(bootstrap, [
    "import {app, ipcMain} from 'electron';",
    "app.setPath('userData', " + JSON.stringify(profile) + ");",
    "app.setPath('home', " + JSON.stringify(home) + ");",
    "app.commandLine.appendSwitch('disable-background-timer-throttling');",
    "app.on('browser-window-created', (_event, win) => { const show = win.showInactive.bind(win); win.webContents.setBackgroundThrottling(false); win.setIgnoreMouseEvents(true); win.show = () => { win.setPosition(-10000,-10000); show(); }; win.focus = () => {}; });",
    "const handle = ipcMain.handle.bind(ipcMain);",
    "const hold = new Promise(resolve => { globalThis.__releaseHistory = resolve; });",
    "ipcMain.handle = (channel, fn) => handle(channel, channel !== 'chat:history' ? fn : async (...args) => {",
    "  if (args[1] === 'long' && !args[2]) await hold;",
    "  return fn(...args);",
    "});",
    "await import(" + JSON.stringify(pathToFileURL(path.join(repo, 'out/main/index.js')).href) + ");",
  ].join('\n'));
  let app;
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), SUDAL_APPROVED_ROOTS: home };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 30000 });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const activate = async id => {
      await page.locator('[data-sidebar] [data-session="' + id + '"]').click();
      await page.locator('[data-composer-tab="' + id + '"]').waitFor();
    };
    const sendEvent = async envelope => app.evaluate(({ BrowserWindow }, payload) =>
      BrowserWindow.getAllWindows()[0].webContents.send('chat:event', payload), envelope);
    const marker = page.locator('[data-history-preview]');
    const recent = page.locator('[data-block-id="answer"]');
    await activate('short');
    await activate('long');
    await marker.waitFor();
    await recent.getByText('최근 답변입니다.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-block-id="folded"]').count(), 0);
    assert.equal(await page.locator('[data-review-card="review-fixture"]').count(), 0);
    await sendEvent({ tabId: 'long', sequence: 0, event: events[4] });
    await sendEvent({ tabId: 'long', sequence: 1, event: { type: 'assistant_text', blockId: 'large', text: '숨겨진 예전 답변 갱신', ts: now } });
    await sendEvent({ tabId: 'long', sequence: 2, event: { type: 'user_message', id: 'live', text: '로딩 중 새 메시지입니다.', ts: now } });
    await page.getByText('로딩 중 새 메시지입니다.', { exact: true }).waitFor();
    assert.equal(await page.getByText('숨겨진 예전 답변 갱신', { exact: true }).count(), 0);
    assert.equal(await recent.innerText(), '최근 답변입니다.');
    await app.evaluate(() => globalThis.__releaseHistory());
    await marker.waitFor({ state: 'detached' });
    await page.locator('[data-review-card="review-fixture"]').waitFor();
    await page.getByText('로딩 중 새 메시지입니다.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-block-id="live"]').count(), 1);
    assert.equal(await page.locator('[data-block-id="folded"]').count(), 0);
    await page.locator('[data-compact-history] button').click();
    await page.getByText('접힌 요청입니다.', { exact: true }).waitFor();
    await activate('short');
    assert.equal(await marker.count(), 0);
    assert.equal(await recent.count(), 0);
    console.log(JSON.stringify({ passed: true, recentBeforeReplay: true, liveTextOnce: true, canonicalCards: true, archiveOnDemand: true, isolatedTab: true }));
  } finally {
    await app?.close();
    const target = path.resolve(profile);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('sudal-history-preview-e2e-'))
      throw Error('Unexpected cleanup path');
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
