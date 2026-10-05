// 오케스트레이션 2단계 검증(사람 코디네이터, CLI + 패널). usage: node scenario-orch-dag.cjs
//  A) Task A(c.txt 만들기), Task B(--deps A, c.txt 에 줄 추가) → B 는 deps_unmet, task-list --ready 는 A 만
//  B) A 워커 완료 → B ready → B 에 게이트 → worker-start 는 gate_pending → 패널 게이트 버튼으로 결정
//  C) B 를 A 의 탭에 --terminal 로 재사용해 시작 → 완료 → c.txt 두 줄 → worker-cleanup 으로 탭 닫힘
const os=require("os"),path=require("path"),fs=require("fs"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");const repo=path.join(E2E,"repo");
const cli=(...a)=>{try{return JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}))}catch(e){try{return JSON.parse(e.stdout)}catch{throw e}}};
const { chromium } = require("playwright-core");
const t0=Date.now();const log=(...a)=>console.log(`+${((Date.now()-t0)/1000).toFixed(1)}s`,...a);const results=[];const res=(n,ok,x="")=>{results.push([n,ok]);log(`RESULT ${n}:`,ok?"PASS":"FAIL",x)};
(async()=>{
  const cfile=path.join(repo,"c.txt");fs.rmSync(cfile,{force:true});
  const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
  const ev=(fn,arg)=>page.evaluate(fn,arg);
  const ws=cli("ws","add","--path",repo);cli("tab","new","--ws",ws.workspaceId,"--title","코디(DAG)","--activate");await page.waitForTimeout(500);
  const rc=cli("orch","run-create","--objective","c.txt 두 줄");const runId=rc.run.id,key=rc.coordinatorKey;
  const A=cli("orch","task-create","--run",runId,"--key",key,"--spec","Target: c.txt (저장소 루트). Change: 내용이 'first' 한 줄인 c.txt 를 만든다. Acceptance: cat c.txt 가 first. 끝나면 worker_done(성공).");
  const B=cli("orch","task-create","--run",runId,"--key",key,"--spec","Target: c.txt (저장소 루트, 앞 Task 가 만든 파일). Change: c.txt 끝에 'second' 한 줄을 추가한다. Acceptance: cat c.txt 가 first, second 두 줄. 끝나면 worker_done(성공).","--deps",A.task.id);
  const ready0=cli("orch","task-list","--run",runId,"--ready");
  const wb0=cli("orch","worker-start","--run",runId,"--key",key,"--task",B.task.id,"--agent","claude","--policy","full","--cwd",repo);
  res("A (deps: B 는 deps_unmet, ready 는 A 만)",(ready0.tasks||[]).map(t=>t.id).join()===A.task.id&&wb0.error?.code==="deps_unmet",JSON.stringify(wb0.error?.code));
  const wa=cli("orch","worker-start","--run",runId,"--key",key,"--task",A.task.id,"--agent","claude","--policy","full","--cwd",repo);
  const d1=cli("orch","check","--run",runId,"--key",key,"--wait","--types","worker_done,note,escalation","--timeout-ms","300000");
  cli("orch","check","--run",runId,"--key",key,"--ack",d1.delivery?.id);
  let show=cli("orch","run-show","--run",runId);for(let i=0;i<60&&show.workers?.[0]?.status!=="settled";i++){await page.waitForTimeout(1000);show=cli("orch","run-show","--run",runId);}
  const ready1=cli("orch","task-list","--run",runId,"--ready");
  const g=cli("orch","gate-create","--run",runId,"--key",key,"--task",B.task.id,"--question","second 를 대문자로?","--options","yes,no");
  const wb1=cli("orch","worker-start","--run",runId,"--key",key,"--task",B.task.id,"--agent","claude","--policy","full","--cwd",repo);
  await page.click("[data-orch]");await page.waitForTimeout(800);
  const gateUi=await ev(()=>({gates:document.querySelectorAll("[data-orch-gate]").length,opts:[...document.querySelectorAll("[data-orch-gate-option]")].map(e=>e.getAttribute("data-orch-gate-option"))}));
  await page.screenshot({path:path.join(E2E,"shot-orch-gate.png")});
  await page.click('[data-orch-gate-option="no"]');await page.waitForTimeout(600);
  const resolved=await ev(()=>document.querySelector("[data-orch-gate]")?.getAttribute("data-orch-gate-resolved"));
  await page.keyboard.press("Escape");
  const gl=cli("orch","gate-list","--run",runId);
  res("B (A 완료 → B ready → 게이트 gate_pending → 패널에서 결정)",show.workers?.[0]?.status==="settled"&&(ready1.tasks||[]).map(t=>t.id).join()===B.task.id&&wb1.error?.code==="gate_pending"&&gateUi.gates===1&&JSON.stringify(gateUi.opts)===JSON.stringify(["yes","no"])&&resolved==="true"&&gl.gates?.[0]?.resolution?.choice==="no",JSON.stringify(wb1.error?.code));
  // C: 탭 재사용
  const wb=cli("orch","worker-start","--run",runId,"--key",key,"--task",B.task.id,"--agent","claude","--policy","full","--terminal",wa.dispatch.tabId);
  log("reuse:",JSON.stringify(wb).slice(0,200));
  const d2=cli("orch","check","--run",runId,"--key",key,"--wait","--types","worker_done,note,escalation","--timeout-ms","300000");
  cli("orch","check","--run",runId,"--key",key,"--ack",d2.delivery?.id);
  show=cli("orch","run-show","--run",runId);for(let i=0;i<60&&show.workers?.[1]?.status!=="settled";i++){await page.waitForTimeout(1000);show=cli("orch","run-show","--run",runId);}
  const c=fs.existsSync(cfile)?fs.readFileSync(cfile,"utf8"):"";
  const cl=cli("orch","worker-cleanup","--run",runId,"--key",key,"--dispatch",wb.dispatch?.id);
  const tabsNow=cli("tab","list","--ws",ws.workspaceId);
  res("C (--terminal 재사용 → B 완료 → c.txt 두 줄 → cleanup 탭 닫힘)",wb.dispatch?.tabId===wa.dispatch.tabId&&/^first\s*\n\s*second\s*$/.test(c.trim()+"\n")===false?/first[\s\S]*second/.test(c):/first[\s\S]*second/.test(c)&&show.tasks?.every(t=>t.status==="succeeded")&&cl.worker?.cleaned?.tabClosed===true&&!tabsNow.tabs.some(t=>t.id===wa.dispatch.tabId),JSON.stringify({c:c.trim(),cleaned:cl.worker?.cleaned}));
  const closed=cli("orch","run-close","--run",runId,"--key",key);res("D (run-close)",closed.run?.status==="closed");
  fs.rmSync(cfile,{force:true});
  const s=await ev(()=>window.sudal.workspaces.state());for(const w of s.model.workspaces){for(const t of s.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
  log("cleaned up;",results.filter(([,ok])=>!ok).length===0?"ALL PASS":"FAILED: "+results.filter(([,ok])=>!ok).map(([n])=>n).join(", "));
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
