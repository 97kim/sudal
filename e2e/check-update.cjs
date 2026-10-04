// DMG 에서 뺀 Claude SDK 번들 바이너리 없이 Claude 가 도는지 + 설정 > 일반의 업데이트 카드([data-setting=update])
const path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
// 9333 에 다른 인스턴스(사용자 앱)가 떠 있으면 아래 정리가 남의 대화를 지운다 — 격리 userData 인지 먼저 본다
const info=await ev(()=>window.workbench.app.info());
if(info.userDataPath!==path.join(E2E,"userdata")){console.error("ERR 9333 의 앱이 e2e/userdata 인스턴스가 아니다:",info.userDataPath);process.exit(1);}
const check=(name,ok,...extra)=>{console.log(`RESULT (${name}):`,ok?"PASS":"FAIL",...extra);if(!ok)process.exitCode=1;};
// ws add 는 같은 경로가 있으면 기존 것을 돌려준다 — 이번에 새로 만든 경우에만 워크스페이스째 지운다
const existed=cli("ws","list").workspaces.some(w=>w.path===E2E+"/repo");
const ws=cli("ws","add","--path",E2E+"/repo");
const sent=cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","번들 없음","--prompt","'ok' 라고만 답해");cli("tab","wait","--tab","번들 없음");
const reply=cli("tab","read","--tab","번들 없음");
const answer=(reply.blocks??[]).filter(x=>x.kind==="assistant").pop()?.text??"";
console.log("claude reply:",JSON.stringify(reply).slice(-300));
check("번들 바이너리 없이 Claude 턴",!(reply.blocks??[]).some(x=>x.kind==="turn"&&x.isError)&&/^\W*ok\W*$/i.test(answer),JSON.stringify(answer));
const models=await ev(()=>window.workbench.app.models("claude",{force:true}));
check("Claude 모델 목록을 CLI 에서",models.source==="cli"&&models.models.length>0,models.source,models.models.length);
await page.click('button[title="설정"], [data-nav=settings]').catch(()=>{});await page.waitForTimeout(600);
const before=await ev(()=>document.querySelector("[data-setting=update] [data-update-state]")?.textContent);
await page.click("[data-update-check]");
await page.waitForFunction(()=>document.querySelector("[data-update-state]")?.getAttribute("data-update-state")!=="checking",null,{timeout:30000});
const after=await ev(()=>({state:document.querySelector("[data-update-state]")?.textContent,err:document.querySelector("[data-update-error]")?.textContent??null,buttons:[...document.querySelectorAll("[data-setting=update] button")].map(b=>b.textContent)}));
const r=await ev(()=>window.workbench.app.checkUpdate());
console.log("card:",before,"→",JSON.stringify(after),"| check:",JSON.stringify(r));
check("업데이트 확인",!after.err&&r.latest&&r.brew===false);
const run=await ev(()=>window.workbench.app.runUpdate());
check("/Applications 밖의 앱은 brew 업그레이드 거부",!run.ok&&/Applications/.test(run.error),JSON.stringify(run));
await page.screenshot({path:E2E+"/update-card.png"});
await ev(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="채팅")?.click());await page.waitForTimeout(400);
// 이 스크립트가 만든 탭(과 새로 만든 워크스페이스)만 지운다
await ev(id=>window.workbench.workspaces.deleteTab(id),sent.tab.id);if(!existed)await ev(id=>window.workbench.workspaces.remove(id),ws.workspaceId);
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
