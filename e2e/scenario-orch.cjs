// 오케스트레이션 1단계 검증(사람 코디네이터). usage: node scenario-orch.cjs
//  A) run-create(사람) → worker-start(claude, full, worktree 없음) → 워커 탭 생성·preamble 전송, 활성 탭 유지
//  B) 워커가 ask 로 질문 → 패널에 질문이 뜨고 옵션 버튼으로 답 → 워커가 답을 파일에 반영하고 worker_done
//  C) check --wait 로 완료 보고 수신, task succeeded, 턴이 끝나면 dispatch settled → 패널에서 해제
//  D) run-show / CLI read 에 orchestration 없음(사람 코디네이터는 카드 없음) — 패널 메시지 목록에 question/reply/worker_done
const os=require("os"),path=require("path"),fs=require("fs"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");const repo=path.join(E2E,"repo");
const cli=(...a)=>{try{return JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}))}catch(e){try{return JSON.parse(e.stdout)}catch{throw e}}};
const { chromium } = require("playwright-core");
const t0=Date.now();const log=(...a)=>console.log(`+${((Date.now()-t0)/1000).toFixed(1)}s`,...a);const results=[];const res=(n,ok,x="")=>{results.push([n,ok]);log(`RESULT ${n}:`,ok?"PASS":"FAIL",x)};
(async()=>{
  const target=path.join(repo,"a.txt");const orig=fs.readFileSync(target,"utf8");
  const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
  const ev=(fn,arg)=>page.evaluate(fn,arg);const errs=[];page.on("console",m=>{if(m.type()==="error")errs.push(m.text().slice(0,200))});
  const ws=cli("ws","add","--path",repo);const home=cli("tab","new","--ws",ws.workspaceId,"--title","코디(사람)","--activate");await page.waitForTimeout(600);
  // A
  const rc=cli("orch","run-create","--objective","a.txt 에 접미사 줄 추가");log("run:",JSON.stringify(rc).slice(0,160));
  const runId=rc.run?.id;
  const spec="Target: a.txt (이 저장소 루트). Change: 먼저 코디네이터에게 ask 명령으로 '접미사는 무엇으로 할까요?' 를 옵션 alpha,beta 로 물어보고, 받은 답을 써서 a.txt 맨 끝에 `orch: <답>` 한 줄을 추가한다. Constraints: 다른 파일은 건드리지 않는다. Acceptance: `cat a.txt` 마지막 줄이 `orch: <답>` 이면 완료. 끝나면 worker_done 보고(성공).";
  const key=rc.coordinatorKey;const ws1=cli("orch","worker-start","--run",runId,"--key",key,"--spec",spec,"--agent","claude","--policy","full","--cwd",repo);
  log("worker-start:",JSON.stringify(ws1).slice(0,300));
  const disp=ws1.dispatch;const list=cli("tab","list","--ws",ws.workspaceId);
  res("A (run-create + worker-start: 워커 탭·live·활성 탭 유지)",!!runId&&disp?.status==="live"&&list.tabs.some(t=>t.id===disp.tabId&&t.title.startsWith("워커 1"))&&list.tabs.find(t=>t.active)?.id===home.tab.id,JSON.stringify(ws1.receipt));
  // B: 질문 대기(최대 4분) → 패널에서 옵션으로 답
  let q=null;for(let i=0;i<240;i++){await page.waitForTimeout(1000);const pk=cli("orch","check","--run",runId,"--key",key,"--peek");q=(pk.inbox||[]).find(m=>m.type==="question"&&!m.answer);if(q)break;}
  log("question:",JSON.stringify(q).slice(0,200));
  await page.click("[data-orch]");await page.waitForTimeout(800);
  const panel=await ev(()=>({runs:document.querySelectorAll("[data-orch-run]").length,q:document.querySelectorAll("[data-orch-message-type=question]").length,opts:[...document.querySelectorAll("[data-orch-answer-option]")].map(e=>e.getAttribute("data-orch-answer-option"))}));
  log("panel:",JSON.stringify(panel));
  await page.screenshot({path:path.join(E2E,"shot-orch-question.png")});
  await page.click('[data-orch-answer-option="beta"]');await page.waitForTimeout(800);
  const answered=await ev(()=>document.querySelector("[data-orch-answered]")?.textContent??null);
  res("B (워커 질문 → 패널 옵션 답변)",!!q&&panel.runs>=1&&panel.q===1&&JSON.stringify(panel.opts)===JSON.stringify(["alpha","beta"])&&/답: beta/.test(answered||""),answered||"");
  await page.keyboard.press("Escape");
  // C: 완료 보고 대기
  const done=cli("orch","check","--run",runId,"--key",key,"--wait","--types","worker_done,note,escalation","--timeout-ms","300000");
  log("check:",JSON.stringify(done).slice(0,400));
  const msgs=done.delivery?.messages||[];const wd=msgs.find(m=>m.type==="worker_done");
  const fileNow=fs.readFileSync(target,"utf8");
  let show=cli("orch","run-show","--run",runId);
  for(let i=0;i<60&&show.workers?.[0]?.status!=="settled";i++){await page.waitForTimeout(1000);show=cli("orch","run-show","--run",runId);}
  log("show:",JSON.stringify(show).slice(0,400));
  res("C (worker_done 수신 · 파일 반영 · task succeeded · settled)",!!wd&&wd.outcome==="succeeded"&&/orch: beta\s*$/.test(fileNow)&&show.tasks?.[0]?.status==="succeeded"&&show.workers?.[0]?.status==="settled",fileNow.trim().split("\n").pop());
  // ack + 해제(패널)
  cli("orch","check","--run",runId,"--key",key,"--ack",done.delivery.id);
  await page.click("[data-orch]");await page.waitForTimeout(800);
  await page.click("[data-orch-worker-release]");await page.waitForTimeout(600);
  const st=await ev(()=>({types:[...document.querySelectorAll("[data-orch-message-type]")].map(e=>e.getAttribute("data-orch-message-type")),dispatch:document.querySelector("[data-orch-dispatch]")?.textContent}));
  await page.screenshot({path:path.join(E2E,"shot-orch-done.png")});
  await page.keyboard.press("Escape");
  const show2=cli("orch","run-show","--run",runId);
  res("D (패널 메시지 목록 + 해제)",st.types.includes("question")&&st.types.includes("reply")&&st.types.includes("worker_done")&&show2.workers?.[0]?.ownership==="released",JSON.stringify(st.types));
  const closed=cli("orch","run-close","--run",runId,"--key",key);res("E (run-close)",closed.run?.status==="closed");
  // 정리
  fs.writeFileSync(target,orig);
  const s=await ev(()=>window.sudal.workspaces.state());for(const w of s.model.workspaces){for(const t of s.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
  if(errs.length)log("CONSOLE ERRORS:",errs.slice(0,5));
  log("cleaned up;",results.filter(([,ok])=>!ok).length===0?"ALL PASS":"FAILED: "+results.filter(([,ok])=>!ok).map(([n])=>n).join(", "));
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
