// 브라우저 탭: ①개발자 도구 버튼 ②채팅 탭을 옮겼다 와도 "이동한 주소" 가 유지되는지
const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
const ws=cli("ws","add","--path",E2E+"/repo");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--title","브A","--activate");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--title","브B");
// 브A 에서 브라우저를 열고 example.com → 다른 주소로 이동
cli("browser","open","--tab","브A","--url","https://example.com");
await page.waitForTimeout(3000);
const first=await ev(()=>document.querySelector("[data-browser-url]")?.value);
console.log("처음 주소:", first);
console.log("RESULT (더보기 메뉴 버튼 있음):", await ev(()=>!!document.querySelector("[data-browser-more]"))?"PASS":"FAIL");
// 주소창으로 이동
await page.fill("[data-browser-url]","https://example.com/moved");
await page.press("[data-browser-url]","Enter");
await page.waitForTimeout(2500);
const moved=await ev(()=>document.querySelector("[data-browser-url]")?.value);
console.log("이동 후 주소:", moved);
// 다른 채팅 탭으로 갔다가 돌아온다 (BrowserPane 이 내려갔다 올라온다)
cli("tab","activate","--tab","브B");await page.waitForTimeout(1200);
const gone=await ev(()=>!document.querySelector("[data-browser-url]"));
cli("tab","activate","--tab","브A");await page.waitForTimeout(2500);
const back=await ev(()=>document.querySelector("[data-browser-url]")?.value);
console.log("돌아온 뒤 주소:", back, "| 탭 전환 중 내려갔었나:", gone);
console.log("RESULT (이동한 주소가 유지됨):", back && back.includes("/moved")?"PASS":"FAIL (기대: /moved, 실제: "+back+")");
// 개발자 도구 토글
await page.click("[data-browser-more]");await page.click("[data-browser-devtools]");await page.waitForTimeout(1500);
const opened=await ev(()=>{const w=document.querySelector("webview");return w&&w.isDevToolsOpened?w.isDevToolsOpened():null});
await page.click("[data-browser-more]");await page.click("[data-browser-devtools]");await page.waitForTimeout(1000);
const closed=await ev(()=>{const w=document.querySelector("webview");return w&&w.isDevToolsOpened?w.isDevToolsOpened():null});
console.log("devtools 열림:",opened,"→ 닫힘:",closed);
console.log("RESULT (개발자 도구 토글):", opened===true&&closed===false?"PASS":"FAIL");
const s=await ev(()=>window.sudal.workspaces.state());for(const w of s.model.workspaces){for(const t of s.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
