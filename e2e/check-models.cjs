const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--title","모델목록","--activate");await page.waitForTimeout(700);
await page.click("[data-fanout]");
for(let i=0;i<60;i++){await page.waitForTimeout(500);const s=await page.evaluate(()=>[...document.querySelectorAll("[data-fanout-model]")].map(e=>e.getAttribute("data-models-source")));if(s.length===2&&s.every(x=>x==="cli"))break;}
const r=await page.evaluate(()=>[...document.querySelectorAll("[data-fanout-variant]")].map(v=>({provider:v.querySelector('[data-fanout-provider][data-selected="true"]')?.getAttribute("data-fanout-provider"),source:v.querySelector("[data-fanout-model]")?.getAttribute("data-models-source"),options:[...v.querySelectorAll("[data-fanout-model] option")].map(o=>o.textContent)})));
console.log(JSON.stringify(r,null,1));
const a=r[0],c=r[1];
const pass=a.source==="cli"&&c.source==="cli"&&a.options.some(o=>/Fable/.test(o))&&a.options.some(o=>/Opus \(1M/.test(o))&&c.options[0].includes("기본 (CLI 설정: gpt-6-astra)")&&c.options.some(o=>o==="GPT-6-Astra");
console.log("RESULT (CLI 에서 읽은 모델 목록):",pass?"PASS":"FAIL");
await page.screenshot({path:path.join(E2E,"shot-models.png")});
await page.keyboard.press("Escape");await page.waitForTimeout(300);
// /model 피커도 같은 목록인지
await page.fill("textarea:not(.xterm-helper-textarea)","/model");await page.waitForTimeout(300);await page.keyboard.press("Escape");await page.waitForTimeout(200);await page.keyboard.press("Enter");await page.waitForTimeout(1500);
const pk=await page.evaluate(()=>document.querySelector("[data-model-picker]")?.innerText.replace(/\s+/g," ").slice(0,400)??null);
console.log("picker:",pk);console.log("RESULT (/model 피커에도 Fable):",pk&&/Fable/.test(pk)?"PASS":"FAIL");
await page.screenshot({path:path.join(E2E,"shot-model-picker.png")});
await page.keyboard.press("Escape");
const st=await page.evaluate(()=>window.workbench.workspaces.state());for(const w of st.model.workspaces){for(const t of st.model.tabs.filter(t=>t.workspaceId===w.id))await page.evaluate(id=>window.workbench.workspaces.deleteTab(id),t.id);await page.evaluate(id=>window.workbench.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
