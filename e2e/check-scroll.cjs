// 자동 스크롤: 위로 올린 뒤에는 새 블록·스트리밍이 와도 안 내려가고, 내 메시지를 보내면 맨 아래로
const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","스크롤","--activate","--prompt","1부터 150까지 각 숫자를 `- N` 마크다운 목록으로 한 줄씩 출력해. 그 다음 `echo a; sleep 2; echo b` 를 Bash 로 실행하고, 다시 151부터 250까지 `- N` 목록으로 출력해. 설명은 하지 마.");
const st=()=>ev(()=>{const el=document.querySelector("[data-message-list]");return {top:el.scrollTop,h:el.scrollHeight,c:el.clientHeight,blocks:document.querySelectorAll("[data-message-list] .ml-11, [data-message-list] [data-tool-card]").length}});
// 스크롤이 생길 때까지 기다린 뒤 위로 올린다
let s=null;for(let i=0;i<120;i++){await page.waitForTimeout(500);s=await st();if(s.h-s.c>600)break;}
{const r=await ev(()=>{const x=document.querySelector("[data-message-list]").getBoundingClientRect();return{x:x.x+x.width/2,y:x.y+x.height/2}});await page.mouse.move(r.x,r.y);await page.mouse.wheel(0,-500);}
await page.waitForTimeout(300);const after=await st();const anchor=after.top;
// 이후 8초 동안(스트리밍 + 툴카드 등장) scrollTop 이 바뀌지 않아야 한다
const samples=[];for(let i=0;i<16;i++){await page.waitForTimeout(500);const x=await st();samples.push({top:x.top,h:x.h});}
const moved=samples.some(x=>Math.abs(x.top-anchor)>2);const grew=samples[samples.length-1].h>after.h;
console.log("anchor",anchor,"samples",JSON.stringify(samples.slice(-4)));
console.log("RESULT (위로 올린 뒤엔 내용이 늘어도 위치 유지):",!moved&&grew?"PASS":"FAIL");
const pill=await ev(()=>!!document.querySelector("[data-scroll-bottom]"));console.log("RESULT (맨 아래로 pill 표시):",pill?"PASS":"FAIL");
// 턴이 끝날 때까지 기다린 뒤 내 메시지를 보내면 맨 아래로
for(let i=0;i<240;i++){await page.waitForTimeout(500);const t=cli("tab","status","--tab","스크롤");if(t.tab?.status==="idle")break;}
cli("tab","send","--tab","스크롤","--text","숫자 7만 답해.");await page.waitForTimeout(800);
const afterSend=await st();console.log("RESULT (내 메시지 보내면 맨 아래로):",afterSend.h-afterSend.top-afterSend.c<80?"PASS":"FAIL",JSON.stringify(afterSend));
for(let i=0;i<120;i++){await page.waitForTimeout(500);const t=cli("tab","status","--tab","스크롤");if(t.tab?.status==="idle")break;}
const stt=await ev(()=>window.sudal.workspaces.state());for(const w of stt.model.workspaces){for(const t of stt.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
