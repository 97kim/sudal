// 오케스트레이션(탭 코디네이터) 검증. usage: node scenario-orch-ai.cjs
//  A) Claude 탭에 "sudal orch 로 Run 을 만들고(--coordinator active) 워커 1개를 띄워 완료 보고를 받아 ack 하라" 지시
//     → 코디네이터 탭에 orchestration 카드, 워커 탭 생성, 카드가 succeeded 로 갱신, 코디네이터 답에 결과
//  B) 보고 없이 끝나는 워커: spec 에 "worker_done 을 보내지 말고 '끝' 이라고만 답하라" → 앱 통지 turn_ended_without_report → 사람이 abandon
const os=require("os"),path=require("path"),fs=require("fs"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");const repo=path.join(E2E,"repo");
const cli=(...a)=>{try{return JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}))}catch(e){try{return JSON.parse(e.stdout)}catch{throw e}}};
const { chromium } = require("playwright-core");
const t0=Date.now();const log=(...a)=>console.log(`+${((Date.now()-t0)/1000).toFixed(1)}s`,...a);const results=[];const res=(n,ok,x="")=>{results.push([n,ok]);log(`RESULT ${n}:`,ok?"PASS":"FAIL",x)};
(async()=>{
  const bfile=path.join(repo,"b.txt");fs.rmSync(bfile,{force:true});
  const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
  const ev=(fn,arg)=>page.evaluate(fn,arg);
  // 이전 실행 잔재 정리: 탭 코디네이터 Run 은 사람이 인수한 뒤 닫는다
  for(const r of (cli("orch","run-list").runs||[])){ if(r.status!=="active")continue; const show=cli("orch","run-show","--run",r.id); for(const w of (show.workers||[])) if(w.status==="live"||w.status==="reported"){await ev(({id,d})=>window.sudal.orch.worker(id,d,"stop"),{id:r.id,d:w.dispatchId});} }
  await page.waitForTimeout(1500);
  for(const r of (cli("orch","run-list").runs||[])){ if(r.status!=="active")continue; const show=cli("orch","run-show","--run",r.id); for(const w of (show.workers||[])) if(w.status==="live")await ev(({id,d})=>window.sudal.orch.worker(id,d,"abandon"),{id:r.id,d:w.dispatchId}); await ev(id=>window.sudal.orch.takeover(id),r.id); const c=await ev(id=>window.sudal.orch.close(id),r.id); log("closed leftover run",r.id,JSON.stringify(c)); }
  { const s0=await ev(()=>window.sudal.workspaces.state()); for(const ww of s0.model.workspaces){for(const t of s0.model.tabs.filter(t=>t.workspaceId===ww.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),ww.id);} }
  const ws=cli("ws","add","--path",repo);
  const prompt=`sudal CLI 의 오케스트레이션으로 이 작업을 감독해. 순서대로: (1) \`sudal orch run-create --objective "b.txt 만들기" --coordinator active\` 로 Run 을 만들고 응답의 run id 와 coordinatorKey 를 기억해. (2) \`sudal orch worker-start --run <id> --key <key> --agent claude --policy full --cwd ${repo} --spec "Target: b.txt (저장소 루트). Change: 내용이 hello 한 줄인 b.txt 를 만든다. Acceptance: cat b.txt 가 hello. 끝나면 worker_done 보고(성공)."\` 로 워커 하나를 띄워. (3) \`sudal orch check --run <id> --key <key> --wait --types worker_done,question,escalation,note --timeout-ms 600000\` 으로 완료 보고를 기다려. question 이 오면 reply 로 답하고, worker_done 이 오면 \`--ack <delivery id>\` 로 확인한 뒤 멈춰. (4) 마지막에 "결과: <outcome>" 한 줄로만 답해. 워커 탭을 직접 열거나 파일을 직접 만들지 마.`;
  const coord=cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","코디(탭)","--activate","--prompt",prompt);
  log("coordinator tab:",coord.tab?.id,JSON.stringify(coord.send));
  let card=null;
  for(let i=0;i<600;i++){await page.waitForTimeout(1000);card=await ev(()=>{const c=document.querySelector("[data-orch-card]");return c?{status:c.getAttribute("data-orch-status"),tasks:[...c.querySelectorAll("[data-orch-task]")].map(t=>t.getAttribute("data-orch-task-status"))}:null});
    if(i%15===0)log(`poll ${i}: card=${JSON.stringify(card)}`);
    const st=cli("tab","status","--tab","코디(탭)");if(i>10&&st.tab?.status==="idle"&&card&&card.tasks.length>0&&card.tasks.every(s=>s!=="running"&&s!=="pending"))break;}
  await page.screenshot({path:path.join(E2E,"shot-orch-ai.png")});
  const rd=cli("tab","read","--tab","코디(탭)","--last","60");const blocks=rd.blocks||[];const cardBlock=blocks.find(b=>b.kind==="orchestration");const lastText=[...blocks].reverse().find(b=>b.kind==="assistant")?.text||"";
  const runs=cli("orch","run-list");const run=(runs.runs||[])[0];
  const bNow=fs.existsSync(bfile)?fs.readFileSync(bfile,"utf8"):null;
  const listTabs=cli("tab","list","--ws",ws.workspaceId);
  log("card:",JSON.stringify(cardBlock??null).slice(0,300));log("last text:",JSON.stringify(lastText.slice(0,120)));log("b.txt:",JSON.stringify(bNow),"| tabs:",listTabs.tabs.map(t=>t.title));
  res("A (탭 코디네이터: 카드 + 워커 + succeeded + 결과 답)",!!cardBlock&&cardBlock.tasks?.[0]?.status==="succeeded"&&run?.coordinator==="tab"&&/hello/.test(bNow||"")&&/결과: ?succeeded/.test(lastText)&&listTabs.tabs.some(t=>t.title.startsWith("워커 1")));
  // B: 보고 없이 끝나는 워커(사람 코디네이터 Run)
  const rc=cli("orch","run-create","--objective","보고 누락 테스트");
  const key2=rc.coordinatorKey;const w=cli("orch","worker-start","--run",rc.run.id,"--key",key2,"--spec","Target: 없음. Change: 아무 파일도 만들지 말고, worker_done 보고도 보내지 말고, 그냥 '끝' 이라고만 답하고 턴을 마쳐라(테스트 목적).","--agent","claude","--policy","full","--cwd",repo);
  let note=null;for(let i=0;i<180;i++){await page.waitForTimeout(1000);const pk=cli("orch","check","--run",rc.run.id,"--key",key2,"--peek");note=(pk.inbox||[]).find(m=>m.noteKind==="turn_ended_without_report");if(note)break;}
  log("note:",JSON.stringify(note).slice(0,160));
  const ab=cli("orch","worker-abandon","--run",rc.run.id,"--key",key2,"--dispatch",w.dispatch.id,"--reason","보고 없음");
  const show=cli("orch","run-show","--run",rc.run.id);
  res("B (보고 없이 종료 → 앱 통지 → abandon)",!!note&&ab.worker?.status==="abandoned"&&show.tasks?.[0]?.status==="abandoned",JSON.stringify(ab.worker?.status));
  // 정리
  fs.rmSync(bfile,{force:true});
  const s=await ev(()=>window.sudal.workspaces.state());for(const ww of s.model.workspaces){for(const t of s.model.tabs.filter(t=>t.workspaceId===ww.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),ww.id);}
  log("cleaned up;",results.filter(([,ok])=>!ok).length===0?"ALL PASS":"FAILED: "+results.filter(([,ok])=>!ok).map(([n])=>n).join(", "));
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
