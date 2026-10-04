const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--title","셀렉트","--activate");await page.waitForTimeout(700);
await page.click("[data-fanout]");await page.waitForTimeout(500);
const read=()=>page.evaluate(()=>[...document.querySelectorAll("[data-fanout-variant]")].map(v=>({provider:v.querySelector('[data-fanout-provider][data-selected="true"]')?.getAttribute("data-fanout-provider"),tag:v.querySelector("[data-fanout-model]")?.tagName,value:v.querySelector("[data-fanout-model]")?.value,options:[...v.querySelectorAll("[data-fanout-model] option")].map(o=>o.value)})));
const s1=await read();
await page.selectOption('[data-fanout-variant="A"] [data-fanout-model]',"sonnet");
await page.click('[data-fanout-variant="A"] [data-fanout-provider="codex"]');await page.waitForTimeout(200);
const s2=await read();
console.log(JSON.stringify(s1),"\n",JSON.stringify(s2));
const pass=s1[0].tag==="SELECT"&&JSON.stringify(s1[0].options)===JSON.stringify(["","opus","sonnet","haiku"])&&JSON.stringify(s1[1].options)===JSON.stringify(["","gpt-5.3-codex","gpt-5.4"])&&s2[0].provider==="codex"&&s2[0].value===""&&JSON.stringify(s2[0].options)===JSON.stringify(["","gpt-5.3-codex","gpt-5.4"]);
console.log("RESULT (모델 셀렉트 + provider 바꾸면 기본으로):",pass?"PASS":"FAIL");
await page.screenshot({path:path.join(E2E,"shot-fanout-select.png")});
await page.keyboard.press("Escape");
const st=await page.evaluate(()=>window.workbench.workspaces.state());for(const w of st.model.workspaces){for(const t of st.model.tabs.filter(t=>t.workspaceId===w.id))await page.evaluate(id=>window.workbench.workspaces.deleteTab(id),t.id);await page.evaluate(id=>window.workbench.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
