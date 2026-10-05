const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--title","헤더","--activate");await page.waitForTimeout(700);
await page.click("[data-browser-open]");await page.waitForTimeout(800);
const r=await page.evaluate(()=>({toggle:document.querySelector("[data-editor-toggle]")?.textContent.trim(),open:document.querySelector("[data-browser-open]")?.textContent.trim(),toggleState:document.querySelector("[data-editor-toggle]")?.getAttribute("data-editor-toggle")}));
console.log(JSON.stringify(r),"RESULT:",r.toggle==="브라우저 1"&&r.open==="새 브라우저"&&r.toggleState==="open"?"PASS":"FAIL");
const box=await page.evaluate(()=>{const a=document.querySelector("[data-editor-toggle]").getBoundingClientRect();const c=document.querySelector("[data-browser-open]").getBoundingClientRect();return {x:a.left-12,y:a.top-10,width:c.right-a.left+24,height:a.height+20}});
await page.screenshot({path:path.join(E2E,"shot-header.png"),clip:box});
const st=await page.evaluate(()=>window.sudal.workspaces.state());for(const w of st.model.workspaces){for(const t of st.model.tabs.filter(t=>t.workspaceId===w.id))await page.evaluate(id=>window.sudal.workspaces.deleteTab(id),t.id);await page.evaluate(id=>window.sudal.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
