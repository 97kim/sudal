// 진단 첨부: 콘솔 오류 + 실패한 요청(4xx/통신오류) + 화면 캡처가 입력창에 붙는지
const os=require("os"),path=require("path"),fs=require("fs"),http=require("http"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
// 콘솔 오류 1건 + 404 1건 + 연결 거부 1건을 내는 페이지
const srv=http.createServer((req,res)=>{
  if(req.url==="/missing"){res.writeHead(404);return res.end("no")}
  res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
  res.end(`<!doctype html><meta charset=utf-8><title>진단 시험</title><body><h1>diag</h1><script>
    console.error("터진 곳: TypeError x is not a function");
    console.warn("조심"); console.log("보통 로그는 빠져야 함");
    fetch("/missing").catch(()=>{}); fetch("http://127.0.0.1:59999/nope").catch(()=>{});
  </script>`);
});
(async()=>{
await new Promise(r=>srv.listen(0,"127.0.0.1",r));const port=srv.address().port;
const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
const ws=cli("ws","add","--path",E2E+"/repo");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--title","진단","--activate");
cli("browser","open","--tab","진단","--url",`http://127.0.0.1:${port}/`);
await page.waitForTimeout(4000);
console.log("RESULT (진단 버튼 있음):", await ev(()=>!!document.querySelector("[data-browser-diagnose]"))?"PASS":"FAIL");
await page.click("[data-browser-diagnose]");
await page.waitForTimeout(3000);
const msg=await ev(()=>document.querySelector("[data-browser-pick-msg]")?.innerText||null);
console.log("안내:", msg);
// 입력창 초안에 붙었는지
const draft=await ev(()=>document.querySelector("textarea")?.value||"");
console.log("--- 첨부 내용 ---"); console.log(draft.slice(0,900)); console.log("---");
const hasConsole=/터진 곳: TypeError/.test(draft);
const noPlainLog=!/보통 로그는 빠져야 함/.test(draft);
const has404=/HTTP 404/.test(draft);
const hasNetErr=/net::ERR/.test(draft);
const imgs=await ev(()=>document.querySelectorAll("[data-composer-image], [data-attachment-thumb], img[alt='browser.png']").length);
console.log("RESULT (콘솔 오류 포함):",hasConsole?"PASS":"FAIL");
console.log("RESULT (보통 로그는 제외):",noPlainLog?"PASS":"FAIL");
console.log("RESULT (404 포함):",has404?"PASS":"FAIL");
console.log("RESULT (연결 거부 포함):",hasNetErr?"PASS":"FAIL");
console.log("RESULT (화면 캡처 첨부):",/캡처입니다/.test(draft)?"PASS":"FAIL", "| 썸네일 요소:",imgs);
const s=await ev(()=>window.workbench.workspaces.state());for(const w of s.model.workspaces){for(const t of s.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.workbench.workspaces.deleteTab(id),t.id);await ev(id=>window.workbench.workspaces.remove(id),w.id);}
await b.close();srv.close();})().catch(e=>{console.error("ERR",e.message);srv.close();process.exit(1)});
