// 검증용 앱의 표시 언어를 바꾼다: node set-language.cjs ko|en|system
// 다른 스크립트는 한국어 화면의 글자로 요소를 찾으므로, 돌리기 전에 ko 로 맞춘다.
const { chromium } = require("playwright-core");
(async () => {
  const language = process.argv[2] ?? "ko";
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost"));
  await page.evaluate((l) => window.sudal.app.setSettings({ language: l }), language);
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => window.sudal.app.getSettings());
  console.log(`language=${s.language} resolvedLocale=${s.resolvedLocale}`);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
