// 별도 프로필과 가짜 stdio 에이전트로 실제 채팅 UI·IPC·ACP 경로를 검증한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { _electron } = require("playwright-core");

(async () => {
  const repo = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-acp-e2e-"));
  const home = path.join(profile, "home");
  fs.mkdirSync(home);
  const now = Date.now();
  const language = process.argv.includes("--english") ? "en" : "ko";
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ warmTarget: "off", otter: false, language, notifyOnDone: "off" }));
  fs.writeFileSync(path.join(profile, "trusted-folders.json"), JSON.stringify([profile]));
  const tabs = ["codex", "claude"].map(provider => ({ id: `source-${provider}`, workspaceId: "ws", title: provider, provider, policy: "full", sessionId: null, createdAt: now, updatedAt: now, open: true }));
  fs.writeFileSync(path.join(profile, "workspaces.json"), JSON.stringify({ version: 1,
    workspaces: [{ id: "ws", name: "ACP test", path: profile, addedAt: now, lastUsedAt: now }],
    tabs, openTabIds: tabs.map(tab => tab.id), activeTabId: tabs[0].id,
  }));
  const adapter = { command: process.execPath, args: [path.join(repo, "src/main/test-fixtures/acp-agent.cjs"), "chat-skills"] };
  const config = path.join(profile, "acp-adapters.json");
  fs.writeFileSync(config, JSON.stringify({ codex: adapter, claude: adapter }));
  const bootstrap = path.join(profile, "main.mjs");
  fs.writeFileSync(bootstrap, `
    import { app, ipcMain } from 'electron';
    app.setPath('userData', ${JSON.stringify(profile)});
    app.setPath('home', ${JSON.stringify(home)});
    globalThis.__nativeMentions = 0;
    globalThis.__invalidNativeMentions = 0;
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => handle(channel,
      channel === 'chat:codex-mentions' ? (_e, id) => {
        if (!id.startsWith('source-')) { globalThis.__invalidNativeMentions++; throw new Error('ACP must not request native mentions'); }
        globalThis.__nativeMentions++;
        return {list: [], complete: true};
      } : channel === 'chat:commands' ? (...args) => args[1].startsWith('source-') ? [] : fn(...args) : fn);
    await import(${JSON.stringify(pathToFileURL(path.join(repo, "out/main/index.js")).href)});
  `);
  let app;
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, SUDAL_ACP_CONFIG: config };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 30000 });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const provider of ["codex", "claude"]) {
      await page.evaluate(id => window.sudal.workspaces.activateTab(id), `source-${provider}`);
      await page.waitForFunction(id => document.querySelector(`[data-composer] textarea`) && !document.querySelector('[data-acp-trial]'), provider);
      assert.equal(await page.locator('[data-composer-plan]').count(), 0, "native sessions do not claim an ACP mode");
      await page.locator("[data-header-more]").click();
      await page.locator('[data-header-menu-item="acp-new"]').click();
      await page.locator("[data-acp-trial]").waitFor();
      const trialId = await page.evaluate(() => window.sudal.workspaces.state().then(state => state.model.activeTabId));
      const snapshot = await page.evaluate(id => window.sudal.chat.snapshot(id), trialId);
      assert.equal(snapshot.connection, "acp");
      assert.equal(snapshot.provider, provider);
      assert.equal(snapshot.policy, "ask");
      const input = page.locator("[data-composer] textarea");
      await page.locator('[data-composer] [data-composer-plan="off"]').waitFor();
      assert.equal(await page.locator('[data-composer-plan]').innerText(), language === "ko" ? "계획 모드 꺼짐" : "Plan mode off");
      await input.fill("/plan");
      await input.press("Enter");
      await page.locator('[data-composer] [data-composer-plan="on"]').waitFor();
      assert.equal(await page.locator('[data-composer-plan]').innerText(), language === "ko" ? "계획 모드 켜짐" : "Plan mode on");
      if (process.env.SUDAL_E2E_SCREENSHOT && provider === "codex") await page.locator('[data-composer]').screenshot({ path: process.env.SUDAL_E2E_SCREENSHOT });
      assert.equal(await page.locator('[data-acp-config-id="collaboration_mode"]').innerText(), "Plan");
      await input.fill("/plan off");
      await input.press("Enter");
      await page.locator('[data-composer] [data-composer-plan="off"]').waitFor();
      await page.waitForFunction(async id => (await window.sudal.chat.snapshot(id)).status === 'idle', trialId);
      assert.equal(await page.locator('[data-message-list] [data-virtual-row]').count(), 0, "mode toggles leave no chat rows");
      assert.equal((await page.evaluate(id => window.sudal.workspaces.state().then(state => state.model.tabs.find(tab => tab.id === id).title), trialId)), null, "mode toggles do not rename the chat");
      if (provider === "codex") {
        await input.fill("/");
        await page.locator('[data-palette-row="command"]').filter({ hasText: "/review" }).waitFor();
        assert.ok(!(await page.locator('[data-composer] [role="listbox"]').innerText()).includes("/$fixture-skill"));
        await input.fill("Use $fixture");
        const skill = page.locator('[data-palette-row="mention"]').filter({ hasText: "$fixture-skill" });
        await skill.waitFor();
        await skill.click();
        assert.equal(await input.inputValue(), "Use $fixture-skill ");
        await input.fill("Use $fixture-skill to check this");
        await input.press("Enter");
        await page.waitForFunction(async id => (await window.sudal.chat.events(id)).some(event => event.type === 'text_delta' && event.text === 'Use $fixture-skill to check this'), trialId);
      }
      await input.fill("/rev");
      const review = page.locator('[data-palette-row="command"]').filter({ hasText: "/review" });
      await review.waitFor();
      await review.click();
      assert.equal(await input.inputValue(), "/review ");
      await input.fill("/review staged");
      await input.press("Enter");
      await page.waitForFunction(async id => {
        const events = await window.sudal.chat.events(id);
        return events.some(event => event.type === 'text_delta' && event.text === '/review staged');
      }, trialId);
      await page.getByText(language === "ko" ? "사용량 집계 미지원" : "Usage unavailable", { exact: false }).first().waitFor();
      await input.fill("/commands");
      await input.press("Enter");
      await page.waitForFunction(async id => (await window.sudal.chat.commands(id)).some(command => command.name === 'doctor'), trialId);
      if (provider === "codex") {
        await input.fill("$fixture");
        assert.equal(await page.locator('[data-palette-row="mention"]').count(), 0, "removed ACP skills disappear from $ completion");
      }
      await input.fill("/doc");
      await page.locator('[data-palette-row="command"]').filter({ hasText: "/doctor" }).waitFor();
      await input.fill("/logout");
      // 목록 확인만 한다. 실제 로그아웃은 실행하지 않는다.
      await page.locator('[data-palette-row="command"]').filter({ hasText: "/logout" }).waitFor();
      await input.fill("/clear");
      await input.press("Enter");
      await page.waitForFunction(async id => !(await window.sudal.chat.events(id)).some(event => event.type === 'user_message'), trialId);
      assert.equal((await page.evaluate(id => window.sudal.chat.snapshot(id), trialId)).connection, "acp");
      assert.equal((await page.evaluate(id => window.sudal.chat.snapshot(id), `source-${provider}`)).connection, undefined);
    }
    assert.deepEqual(errors, []);
    assert.equal(await app.evaluate(() => globalThis.__invalidNativeMentions), 0);
    console.log(JSON.stringify({ passed: true, language, providers: ["codex", "claude"], palette: true, execution: true, planMode: true, dynamicCommands: true, clearPreservesAcp: true }));
  } catch (error) {
    console.error("ACP E2E failed:", error);
    if (app) console.error((await (await app.firstWindow()).locator("body").innerText()).slice(-2500));
    throw error;
  } finally {
    await app?.close();
    const target = path.resolve(profile);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep + "sudal-acp-e2e-")) throw new Error("Unexpected cleanup path");
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
