// 진행 중 총 경과 시간 줄([data-turn-elapsed]) + 설정의 알림 라디오([data-setting=notify]) 확인
const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","경과","--activate","--prompt","다음 셸 명령을 순서대로 실행하고 마지막에 '끝' 이라고만 답해: sleep 4; sleep 4; echo done");
let seen=[];for(let i=0;i<120;i++){await page.waitForTimeout(500);const f=await ev(()=>{const e=document.querySelector("[data-turn-elapsed]");return e?{secs:Number(e.getAttribute("data-turn-elapsed")),text:e.innerText.replace(/\s+/g," ")}:null});if(f)seen.push(f);const st=cli("tab","status","--tab","경과");if(i>6&&st.tab?.status==="idle")break;}
const last=seen[seen.length-1];const grew=seen.length>3&&seen[seen.length-1].secs>seen[0].secs;const tools=seen.some(s=>/도구 \d+회/.test(s.text));
console.log("footer samples:",seen.length,"first:",JSON.stringify(seen[0]),"last:",JSON.stringify(last));
console.log("RESULT (진행 중 경과 시간 줄 + 도구 횟수):",grew&&tools?"PASS":"FAIL");
const gone=await ev(()=>!document.querySelector("[data-turn-elapsed]"));console.log("RESULT (끝나면 사라짐):",gone?"PASS":"FAIL");
await page.click('button[title="설정"], [data-nav=settings]').catch(()=>{});await page.waitForTimeout(600);
const notify=await ev(()=>{const s=document.querySelector("[data-setting=notify]");return s?{opts:[...s.querySelectorAll("input[type=radio]")].map(i=>i.value+":"+i.checked)}:null});
console.log("notify setting:",JSON.stringify(notify));console.log("RESULT (알림 설정 라디오, 기본 always):",notify&&notify.opts.includes("always:true")?"PASS":"FAIL");
await page.click('[data-setting=notify] input[value=unfocused]');await page.waitForTimeout(400);
const s2=await ev(()=>window.sudal.app.settings ? null : null);
const back=cli("status");
await ev(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="채팅")?.click());await page.waitForTimeout(400);
const st=await ev(()=>window.sudal.workspaces.state());for(const w of st.model.workspaces){for(const t of st.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
