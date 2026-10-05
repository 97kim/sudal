// 같은 탭의 두 번째 턴에서 footer 가 0초 근처에서 시작하는지
const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ev=(fn,arg)=>page.evaluate(fn,arg);
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","경과2","--activate","--prompt","숫자 1만 답해.");
cli("tab","wait","--tab","경과2","--timeout-ms","120000");
await page.waitForTimeout(65000); // 첫 턴 뒤 65초 쉬고 두 번째 턴
cli("tab","send","--tab","경과2","--text","`sleep 6` 을 Bash 로 실행하고 '끝' 이라고 답해.");
let first=null;for(let i=0;i<60;i++){await page.waitForTimeout(300);const f=await ev(()=>{const e=document.querySelector("[data-turn-elapsed]");return e?Number(e.getAttribute("data-turn-elapsed")):null});if(f!==null){first=f;break;}}
console.log("second turn first footer secs:",first);console.log("RESULT (두 번째 턴 경과가 0초 근처에서 시작):",first!==null&&first<=5?"PASS":"FAIL");
for(let i=0;i<120;i++){await page.waitForTimeout(500);if(cli("tab","status","--tab","경과2").tab?.status==="idle")break;}
const st=await ev(()=>window.sudal.workspaces.state());for(const w of st.model.workspaces){for(const t of st.model.tabs.filter(t=>t.workspaceId===w.id))await ev(id=>window.sudal.workspaces.deleteTab(id),t.id);await ev(id=>window.sudal.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
