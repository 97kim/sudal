// Isolated desktop test: no real chats or CLI turns are created.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { _electron } = require("playwright-core");

(async () => {
  const repo = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-history-e2e-"));
  const home = path.join(profile, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(profile, "threads"));
  const tabId = "history-test";
  const now = Date.now();
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ warmTarget: "off", otter: false, language: "ko", notifyOnDone: "off" }));
  fs.writeFileSync(path.join(profile, "workspaces.json"), JSON.stringify({ version: 1,
    workspaces: [{ id: "ws", name: "History test", path: profile, addedAt: now, lastUsedAt: now }],
    tabs: [{ id: tabId, workspaceId: "ws", title: "Memory test", titleCustom: true, provider: "codex", policy: "ask", sessionId: null, createdAt: now, updatedAt: now, open: true }],
    openTabIds: [tabId], activeTabId: tabId }));
  fs.writeFileSync(path.join(profile, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=", "base64"));
  const events = [];
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  for (let i = 0; i < 400; i++) {
    events.push({ type: "user_message", id: `user-${i}`, ts: now + i * 10, text: `question-${i}` });
    events.push({ type: "assistant_text", blockId: `answer-${i}`, ts: now + i * 10 + 1,
      text: `answer-${i}\n\n${"본문 내용입니다. ".repeat(i % 5 * 12 + 1)}\n\n![preview](pixel.png)` });
    events.push({ type: "turn_result", ts: now + i * 10 + 2, usage, modelUsage: {}, costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
  }
  fs.writeFileSync(path.join(profile, "threads", `${tabId}.jsonl`), events.map(JSON.stringify).join("\n") + "\n");
  const bootstrap = path.join(profile, "main.mjs");
  // Electron's built-in module must be resolved by name; launch from the repository
  // so the bundled application can resolve its own dependencies.
  fs.writeFileSync(bootstrap, `
    import { app, ipcMain, BrowserWindow } from 'electron';
    app.setPath('userData', ${JSON.stringify(profile)});
    app.setPath('home', ${JSON.stringify(home)});
    globalThis.__imageReads = 0;
    const handle = ipcMain.handle.bind(ipcMain);
    let injected = false;
    ipcMain.handle = (channel, fn) => handle(channel, channel === 'file:read' ? (...args) => { globalThis.__imageReads++; return fn(...args); } : channel === 'chat:history' ? (...args) => {
      const result = fn(...args);
      if (!injected) {
        injected = true;
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.send('chat:event', { tabId: '${tabId}', sequence: 0, event: { type: 'text_delta', ts: Date.now(), blockId: 'answer-399', text: 'DUPLICATE-SHOULD-BE-SKIPPED' } });
        contents.send('chat:event', { tabId: '${tabId}', sequence: 1, event: { type: 'text_delta', ts: Date.now(), blockId: 'answer-399', text: ' live-tail' } });
      }
      return result;
    } : fn);
    await import(${JSON.stringify(pathToFileURL(path.join(repo, "out/main/index.js")).href)});
  `);
  let app;
  try {
    const env = { ...process.env, USERPROFILE: home };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.waitForSelector("[data-message-list][data-history-count='200']", { timeout: 15_000 }).catch(async (error) => {
      console.error(JSON.stringify({ urls: app.windows().map((p) => p.url()), body: (await page.locator("body").innerText()).slice(0, 3000), profile, logs: fs.existsSync(path.join(profile, "logs/main.log")) ? fs.readFileSync(path.join(profile, "logs/main.log"), "utf8").slice(-4000) : "" }));
      throw error;
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForTimeout(500);
    const mounted = await page.locator("[data-virtual-row]").count();
    assert.ok(mounted > 0 && mounted < 80, `mounted ${mounted} of 200 rows`);
    assert.ok(await page.locator('[data-block-id="answer-399"]').count(), "latest response is visible");
    const latestText = await page.locator('[data-block-id="answer-399"]').innerText();
    assert.ok(latestText.includes("live-tail"), "live text arriving during paging is preserved");
    assert.ok(!latestText.includes("DUPLICATE-SHOULD-BE-SKIPPED"), "snapshot sequence fences duplicate deltas");
    const imageReads = await app.evaluate(() => globalThis.__imageReads);
    assert.ok(imageReads < 30, `only nearby images should load; got ${imageReads}`);
    const allCount = await page.evaluate(async (id) => (await window.sudal.chat.events(id)).length, tabId);
    assert.equal(allCount, 1200, "history is preserved on disk");

    const list = page.locator("[data-message-list]");
    await list.hover();
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(350);
    const anchor = await page.evaluate(() => {
      const container = document.querySelector("[data-message-list]");
      const top = container.getBoundingClientRect().top;
      const row = [...document.querySelectorAll("[data-virtual-row]")].find((el) => el.getBoundingClientRect().top >= top + 30);
      return { key: row.dataset.virtualRow, top: row.getBoundingClientRect().top };
    });
    await page.evaluate(() => document.querySelector("[data-older-history] button").click());
    await page.waitForSelector("[data-history-count='400']");
    await page.waitForTimeout(350);
    const after = await page.locator(`[data-virtual-row="${anchor.key}"]`).boundingBox();
    assert.ok(after && Math.abs(after.y - anchor.top) < 8, `prepend anchor moved ${after ? after.y - anchor.top : 'offscreen'}`);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("app:shortcut", "search"));
    await page.locator("[data-search-palette] input").fill("question-0");
    await page.locator("[data-search-hit]").first().click();
    await page.waitForSelector('[data-block-id="user-0"]', { timeout: 5000 }).catch(async (error) => {
      console.error(JSON.stringify(await page.evaluate(() => {
        const el = document.querySelector("[data-message-list]");
        return { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, blocks: el.dataset.historyCount, rows: [...document.querySelectorAll("[data-virtual-row]")].map((node) => ({ key: node.dataset.virtualRow, top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })), body: document.body.innerText.slice(0, 500) };
      })));
      throw error;
    });
    await page.waitForSelector("[data-history-count='1200']");
    assert.ok(await page.locator("[data-virtual-row]").count() < 80);
    await page.locator("[data-scroll-bottom]").click();
    await app.evaluate(({ BrowserWindow }, id) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      for (let i = 0; i < 10; i++) contents.send("chat:event", { tabId: id, sequence: 100 + i, event: { type: "text_delta", ts: Date.now(), blockId: "live", text: "Streaming answer. ".repeat(80) + "\n" } });
    }, tabId);
    await page.waitForFunction(() => { const el = document.querySelector("[data-message-list]"); return el.scrollHeight - el.scrollTop - el.clientHeight < 3; });
    await list.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(350);
    const parkedTop = await list.evaluate((el) => el.scrollTop);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("chat:event", { tabId: id, sequence: 200, event: { type: "text_delta", ts: Date.now(), blockId: "live", text: "More text.\n".repeat(100) } }), tabId);
    await page.waitForTimeout(350);
    assert.ok(Math.abs(await list.evaluate((el) => el.scrollTop) - parkedTop) < 8, "reading position survives streaming below the viewport");
    await page.screenshot({ path: path.join(repo, ".sudal/history-e2e.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, initialHistory: 200, totalHistory: 1200, initialMounted: mounted, initialImageReads: imageReads, anchorDeltaPx: after.y - anchor.top, searchedOlderHistory: true, liveSequenceFence: true, scrollFollow: true }));
  } finally {
    await app?.close();
    const target = path.resolve(profile);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep + "sudal-history-e2e-")) throw new Error("Unexpected cleanup path");
    fs.rmSync(target, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
