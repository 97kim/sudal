// Exercise the real renderer, IPC, and prediction runner with a fake Codex CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('playwright-core');

function fakeCodex(log, routeOverride) {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
  if (args.includes('--version')) { console.log('codex-cli 0.171.0'); return; }
  if (args.includes('exec')) {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => {
      const context = JSON.parse(text.trim().split('\n').at(-1));
      record({ type: 'prediction', user: context.user, reply: context.assistant, args, cwd: process.cwd(), pid: process.pid });
      setTimeout(() => {
        record({ type: 'predictionDone', user: context.user });
        send({ type: 'item.completed', item: { type: 'agent_message', text: '누락된 테스트를 추가해 주세요.' } });
        send({ type: 'turn.completed' });
      }, context.user === '탭을 바꾸는 요청' || context.user === '입력 중인 요청' ? 3000 : 40);
    });
    return;
  }
  if (!args.includes('app-server')) process.exit(1);
  let n = 0;
  let currentUser = '';
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const req = JSON.parse(line);
    if (req.id === undefined) return;
    const reply = result => send({ id: req.id, result });
    if (req.method === 'thread/start' || req.method === 'thread/resume')
      return reply({ thread: { id: 'fixture-thread' }, model: 'fixture', modelProvider: 'openai' });
    if (req.method === 'config/read') {
      record({ type: 'routeCheck', user: currentUser });
      return reply({ config: {
        cli_auth_credentials_store: 'file',
        ...(fs.existsSync(routeOverride) ? { chatgpt_base_url: 'https://gateway.example.invalid/codex' } : {}),
      } });
    }
    if (req.method !== 'turn/start') return reply({ data: [], goal: null });
    const id = 'fixture-turn-' + ++n;
    const text = req.params.input.find(item => item.type === 'text').text;
    currentUser = text;
    record({ type: 'userTurn', text });
    reply({ turn: { id } });
    const notify = (method, params) => send({ method, params: { threadId: 'fixture-thread', ...params } });
    notify('turn/started', { turn: { id } });
    setTimeout(() => {
      notify('item/completed', { turnId: id, item: { type: 'agentMessage', id: 'answer-' + n, text: '테스트가 한 개 빠져 있습니다.' } });
      notify('turn/completed', { turn: { id, status: 'completed' } });
    }, 60);
  });
}

(async () => {
  const repo = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sudal-predictions-e2e-'));
  const project = path.join(profile, 'project');
  const home = path.join(profile, 'home');
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  const log = path.join(profile, 'requests.jsonl');
  const routeOverride = path.join(profile, 'route-override');
  fs.writeFileSync(log, '');
  const readLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const source = '(' + fakeCodex.toString() + ')(' + [log, routeOverride].map(JSON.stringify).join(',') + ');\n';
  const win = process.platform === 'win32';
  const cli = path.join(profile, win ? 'codex.cmd' : 'codex');
  const disabled = path.join(profile, win ? 'disabled.cmd' : 'disabled');
  if (win) {
    fs.writeFileSync(cli, '@echo off\r\nnode "%~dp0\\codex.cjs" %*\r\n');
    fs.writeFileSync(path.join(profile, 'codex.cjs'), source);
    fs.writeFileSync(disabled, '@exit /b 1\r\n');
  } else {
    fs.writeFileSync(cli, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
    fs.writeFileSync(disabled, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const save = (name, data) => fs.writeFileSync(path.join(profile, name), JSON.stringify(data));
  save('cli-overrides.json', { codex: cli, claude: disabled, agy: disabled });
  save('trusted-folders.json', [project]);
  save('settings.json', { language: 'ko', warmTarget: 'off', otter: false, notifyOnDone: 'always' });
  const now = Date.now();
  const tab = id => ({ id, title: id, workspaceId: 'ws', provider: 'codex', policy: 'ask', sessionId: null, createdAt: now, updatedAt: now, open: true });
  save('workspaces.json', {
    version: 1, workspaces: [{ id: 'ws', name: 'Prediction fixture', path: project, addedAt: now, lastUsedAt: now }],
    tabs: [tab('tab-a'), tab('tab-b')], openTabIds: ['tab-a', 'tab-b'], activeTabId: 'tab-a',
  });
  const bootstrap = path.join(profile, 'main.mjs');
  fs.writeFileSync(bootstrap, [
    "import { app, Notification } from 'electron';",
    "app.setPath('userData', " + JSON.stringify(profile) + ");",
    "app.setPath('home', " + JSON.stringify(home) + ");",
    "app.commandLine.appendSwitch('disable-background-timer-throttling');",
    "globalThis.__notifications = []; Notification.isSupported = () => true; Notification.prototype.show = function () { globalThis.__notifications.push(this.body); };",
    "app.on('browser-window-created', (_event, win) => { const show = win.showInactive.bind(win); win.webContents.setBackgroundThrottling(false); win.setIgnoreMouseEvents(true); win.show = () => { win.setPosition(-10000,-10000); show(); }; win.focus = () => {}; });",
    "await import(" + JSON.stringify(pathToFileURL(path.join(repo, 'out/main/index.js')).href) + ");",
  ].join('\n'));
  let app;
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), SUDAL_APPROVED_ROOTS: project };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 30000 });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const input = page.locator('[data-composer] textarea');
    const suggestion = page.locator('[data-composer-prediction]');
    const activate = async id => {
      await page.locator('[data-sidebar] [data-session="' + id + '"]').click();
      await page.locator('[data-composer][data-composer-tab="' + id + '"]').waitFor();
    };
    const send = async text => {
      await input.fill(text);
      await input.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-composer] textarea')?.value === '');
    };
    const waitForLog = async (type, text) => {
      const end = Date.now() + 12000;
      const find = () => readLog().find(r => r.type === type && r.user === text);
      while (!find() && Date.now() < end)
        await new Promise(resolve => setTimeout(resolve, 25));
      const request = find();
      assert.ok(request, 'expected ' + type + ' for ' + text);
      return request;
    };
    const assertCanceled = async request => {
      const alive = () => {
        try { process.kill(request.pid, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      };
      const end = Date.now() + 5000;
      while (alive() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(alive(), false);
      assert.ok(!readLog().some(r => r.type === 'predictionDone' && r.user === request.user), 'the running CLI should be canceled');
    };
    await activate('tab-a');
    assert.equal(await page.evaluate(async () => (await window.sudal.app.getSettings()).codexComposerPredictions), false);
    await send('설정을 끈 상태');
    await page.getByText('테스트가 한 개 빠져 있습니다.', { exact: true }).waitFor();
    await page.waitForFunction(async () => (await window.sudal.chat.snapshot('tab-a')).status === 'idle');
    assert.ok((await app.evaluate(() => globalThis.__notifications)).at(-1)?.includes('테스트가 한 개 빠져 있습니다.'), 'completion notification should contain the live reply');
    assert.equal(await suggestion.count(), 0);
    assert.equal(readLog().filter(r => r.type === 'prediction').length, 0);
    await activate('tab-b');
    await page.locator('nav button[title="설정"]').click();
    await page.locator('[data-setting="codex-composer-predictions"] input').check();
    await page.waitForFunction(async () => (await window.sudal.app.getSettings()).codexComposerPredictions);
    await page.locator('nav button[title="채팅"]').click();
    await activate('tab-a');
    assert.equal(await suggestion.count(), 0, 'opening existing history must not suggest a reply');

    await send('무엇이 빠졌어?');
    await suggestion.getByText('누락된 테스트를 추가해 주세요.', { exact: true }).waitFor();
    if (process.env.SUDAL_E2E_SCREENSHOT === '1') {
      const folder = path.join(repo, '.sudal');
      fs.mkdirSync(folder, { recursive: true });
      await page.locator('[data-composer]').screenshot({ path: path.join(folder, 'composer-prediction.png') });
    }
    assert.equal(await input.inputValue(), '', 'suggestion is not draft text until accepted');
    const request = readLog().find(r => r.type === 'prediction');
    assert.equal(request.user, '무엇이 빠졌어?');
    assert.equal(request.reply, '테스트가 한 개 빠져 있습니다.');
    assert.ok(request.args.includes('--ephemeral') && request.args.includes('--ignore-user-config') && request.args.includes('read-only'));
    assert.ok(request.args.includes('cli_auth_credentials_store="file"'));
    assert.notEqual(request.cwd, project);
    await input.press('Shift+Tab');
    assert.equal(await input.inputValue(), '', 'reverse tab navigation should remain available');
    await input.press('Tab');
    assert.equal(await input.inputValue(), '누락된 테스트를 추가해 주세요.');
    assert.equal(readLog().filter(r => r.type === 'userTurn').length, 2, 'Tab must not send a message');
    await input.fill('입력 중인 요청');
    await input.press('Enter');
    const typingRequest = await waitForLog('prediction', '입력 중인 요청');
    await input.fill('내가 쓰는 초안');
    assert.equal(await suggestion.count(), 0);
    assert.equal(await input.inputValue(), '내가 쓰는 초안');
    await assertCanceled(typingRequest);

    await send('탭을 바꾸는 요청');
    const switchRequest = await waitForLog('prediction', '탭을 바꾸는 요청');
    await activate('tab-b');
    assert.equal(await input.inputValue(), '');
    assert.equal(await suggestion.count(), 0);
    await assertCanceled(switchRequest);
    await activate('tab-a');
    assert.equal(await suggestion.count(), 0);
    fs.writeFileSync(routeOverride, '');
    await send('사용자 지정 경로');
    await waitForLog('routeCheck', '사용자 지정 경로');
    fs.unlinkSync(routeOverride);
    await send('클릭으로 넣는 요청');
    await suggestion.getByRole('button').click();
    assert.equal(await input.inputValue(), '누락된 테스트를 추가해 주세요.');
    assert.equal(readLog().filter(r => r.type === 'userTurn').length, 6);
    assert.ok(!readLog().some(r => r.type === 'prediction' && r.user === '사용자 지정 경로'));
    await input.fill('');

    const file = path.join(project, 'fixture.txt');
    fs.writeFileSync(file, 'fixture');
    await app.evaluate(({ BrowserWindow }, filePath) => {
      BrowserWindow.getAllWindows()[0].webContents.send('control:open', { kind: 'file', tabId: 'tab-a', path: filePath });
    }, file);
    await page.locator('[data-editor-maximize="off"]').click();
    await page.locator('[data-editor-maximized="true"]').waitFor();
    await page.evaluate(() => window.sudal.chat.send('tab-a', { text: '에디터가 열린 상태의 요청', images: [] }));
    await page.waitForFunction(async () => (await window.sudal.chat.snapshot('tab-a')).status === 'idle');
    await page.waitForTimeout(500); // Allow the 250 ms request debounce to expire while the composer stays hidden.
    assert.ok(!readLog().some(r => r.type === 'routeCheck' && r.user === '에디터가 열린 상태의 요청'));
    await page.locator('[data-editor-maximize="on"]').click();
    await suggestion.getByRole('button').waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, optIn: true, noHistoryGeneration: true, latestExchangeOnly: true, tabInsertsWithoutSending: true, clickInsertsWithoutSending: true, typingPreserved: true, tabIsolation: true, customRouteSkipped: true, hiddenComposerSkipped: true, completionNotification: true }));
  } finally {
    await app?.close();
    const target = path.resolve(profile);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('sudal-predictions-e2e-'))
      throw Error('Unexpected cleanup path');
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
