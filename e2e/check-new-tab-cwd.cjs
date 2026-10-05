// B 워크스페이스의 탭을 보면서 A 워크스페이스에 새 탭을 만들면, 새 탭의 작업 경로가 B 가 아니라 A 의 최근 경로가 되는지.
// 워크스페이스에 기본 경로가 없을 때(이름으로만 만든 워크스페이스) 비어 있던 문제.
const path = require("path");
const { chromium } = require("playwright-core");
const E2E = __dirname;
let fails = 0;
const result = (n, ok, note) => { if (!ok) fails += 1; console.log(`RESULT (${n}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const r = await page.evaluate(async ([repoA, repoB]) => {
    const w = window.sudal.workspaces;
    let s = await w.state();
    for (const x of s.model.workspaces.filter((q) => q.name === "A-e2e" || q.name === "B-e2e")) await w.remove(x.id);
    await w.create("A-e2e");
    await w.create("B-e2e");
    s = await w.state();
    const aws = s.model.workspaces.find((x) => x.name === "A-e2e");
    const bws = s.model.workspaces.find((x) => x.name === "B-e2e");
    const aTab = s.model.tabs.find((t) => t.workspaceId === aws.id);
    const bTab = s.model.tabs.find((t) => t.workspaceId === bws.id);
    await window.sudal.chat.configure(aTab.id, { cwd: repoA });
    await window.sudal.chat.configure(bTab.id, { cwd: repoB });
    await w.activateTab(bTab.id);
    const created = await w.createTab(aws.id);
    const newId = typeof created === "string" ? created : created?.tabId;
    s = await w.state();
    const t = s.model.tabs.find((x) => x.id === newId);
    const out = { inA: t?.workspaceId === aws.id, cwd: t?.cwd ?? null };
    for (const x of [aws, bws]) await w.remove(x.id);
    return out;
  }, [path.join(E2E, "repo"), path.join(E2E, "repo-b")]);
  result("새 탭은 A 워크스페이스에 생긴다", r.inA, JSON.stringify(r));
  result("B 탭을 보며 만들어도 A 의 경로를 쓴다", r.cwd === path.join(E2E, "repo"), JSON.stringify(r));
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
