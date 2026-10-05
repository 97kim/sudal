// 표시 언어 전환: 설정의 language 를 바꾸면 도구 카드 상태 문구와 <html lang> 이 따라 바뀌는지.
// 미리 도구 카드가 있는 탭이 열려 있어야 한다(없으면 건너뜀으로 보고).
const { chromium } = require("playwright-core");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const check = (name, ok, ...extra) => { console.log(`RESULT (${name}):`, ok ? "PASS" : "FAIL", ...extra); if (!ok) process.exitCode = 1; };
  const read = () => ev(() => ({ lang: document.documentElement.lang, states: [...new Set([...document.querySelectorAll("[data-tool-card] [data-tool-toggle]")].map((e) => e.textContent.trim().split(/\s+/).slice(-1)[0]))] }));
  const before = await ev(() => window.sudal.app.getSettings());
  check("설정에 언어 항목과 해석값", ["system", "ko", "en"].includes(before.language) && ["ko", "en"].includes(before.resolvedLocale), before.language, before.resolvedLocale);
  await ev(() => window.sudal.app.setSettings({ language: "ko" })); await page.waitForTimeout(500);
  const ko = await read();
  await ev(() => window.sudal.app.setSettings({ language: "en" })); await page.waitForTimeout(700);
  const en = await read();
  console.log("ko:", JSON.stringify(ko), "en:", JSON.stringify(en));
  check("<html lang> 이 따라 바뀐다", ko.lang === "ko" && en.lang === "en");
  if (ko.states.length === 0) console.log("RESULT (도구 카드 문구): SKIP — 보이는 도구 카드가 없다");
  else check("도구 카드 상태 문구가 바뀐다", ko.states.some((s) => /완료|실패/.test(s)) && en.states.some((s) => /Done|Failed/.test(s)) && !en.states.some((s) => /완료|실패/.test(s)));
  const bad = await ev(() => window.sudal.app.setSettings({ language: "ja" }).then(() => "accepted", (e) => String(e.message)));
  check("모르는 언어는 거절", bad !== "accepted", bad);
  await ev((l) => window.sudal.app.setSettings({ language: l }), before.language);
  const after = await ev(() => window.sudal.app.getSettings());
  check("원래 설정으로 복원", after.language === before.language);
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
