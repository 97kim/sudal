// AskUserQuestion: 전부 자동(full) 정책에서 승인 카드가 아니라 질문 카드([data-question-prompt])가 뜨고,
// 선택지를 누르면 답이 모델에 전달되어 턴이 그 답으로 끝나는지 확인.
const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
const ws=cli("ws","add","--path",E2E+"/repo");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","질문","--activate","--prompt",
  "지금 바로 AskUserQuestion 도구를 한 번 호출해서 '어느 색을 고를까요?' 라는 질문에 선택지 '파랑', '초록' 두 개를 제시해. 다른 도구는 쓰지 마. 내가 답하면 '선택: <답>' 형식으로 한 줄만 답하고 끝내.");
// 1) 질문 카드가 뜨는지 (승인 카드가 아니라)
let q=null;for(let i=0;i<120;i++){await page.waitForTimeout(500);q=await ev(()=>{const e=document.querySelector("[data-question-prompt]");if(!e)return null;return{title:e.querySelector(".font-medium")?.innerText,options:[...e.querySelectorAll("[data-question-option]")].map(o=>o.innerText.split("\n")[0].trim()),other:!!e.querySelector("[data-question-other]"),status:document.querySelector("[data-tool-card=AskUserQuestion]")?.innerText.replace(/\s+/g," ")}});if(q)break;}
console.log("question card:",JSON.stringify(q));
const approvalCard=await ev(()=>!!document.querySelector("[data-question-prompt]")&&![...document.querySelectorAll("button")].some(b=>/^허용/.test(b.textContent.trim())));
console.log("RESULT (질문 카드가 뜨고 허용/거부 버튼이 없음):",q&&q.options.length===2&&q.other&&approvalCard?"PASS":"FAIL");
console.log("RESULT (툴카드 상태 '답변 대기'):",q&&/답변 대기/.test(q.status||"")?"PASS":"FAIL");
// 2) '초록' 선택 → 즉시 전송(단일 질문·단일 선택)
await page.screenshot({path:E2E+"/shot-question.png"});
await ev(()=>[...document.querySelectorAll("[data-question-option]")].find(o=>/초록/.test(o.innerText))?.click());
let st;for(let i=0;i<120;i++){await page.waitForTimeout(500);st=cli("tab","status","--tab","질문");if(st.tab?.status==="idle")break;}
const gone=await ev(()=>!document.querySelector("[data-question-prompt]"));
const out=cli("tab","read","--tab","질문");const text=JSON.stringify(out);
console.log("final status:",st.tab?.status,"| reply has 선택: 초록 ->",/선택:\s*초록/.test(text));
console.log("RESULT (카드 사라지고 모델이 답을 받아 '선택: 초록' 으로 끝남):",gone&&st.tab?.status==="idle"&&/선택:\s*초록/.test(text)?"PASS":"FAIL");
if(!/선택:\s*초록/.test(text))console.log("reply tail:",text.slice(-600));
// 정리
const s=await ev(()=>window.sudal.workspaces.state());for(const w of s.model.workspaces){for(const t of s.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
