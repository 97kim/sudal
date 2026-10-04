const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const { chromium } = require("playwright-core");
(async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9333");const page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("localhost")||p.url().startsWith("file:"));
const ws=cli("ws","add","--path",E2E+"/repo");const tab=cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","생각중","--activate","--prompt","1부터 30까지 각 숫자의 제곱을 계산해서 마크다운 표로 만들어줘. 계산 전에 접근을 잠깐 생각해.");
let m=null;
for(let i=0;i<120;i++){await page.waitForTimeout(250);m=await page.evaluate(()=>{const t=document.querySelector("[data-thinking]");if(!t)return null;const img=t.querySelector("img");const lbl=t.querySelector(".thinking-dots");if(!img||!lbl)return {noAvatar:true};const a=img.getBoundingClientRect(),l=lbl.getBoundingClientRect();return {avatarMid:(a.top+a.bottom)/2,labelMid:(l.top+l.bottom)/2,labelH:l.height}});if(m&&!m.noAvatar)break;}
console.log(JSON.stringify(m));
const ok=m&&!m.noAvatar&&Math.abs(m.avatarMid-m.labelMid)<=2;
console.log("RESULT (생각 중 라벨이 아바타와 세로 중앙):",ok?"PASS":"FAIL");
await page.screenshot({path:path.join(E2E,"shot-thinking.png"),clip:{x:400,y:150,width:700,height:200}});
cli("tab","abort","--tab","생각중");await page.waitForTimeout(1000);
const st=await page.evaluate(()=>window.workbench.workspaces.state());for(const w of st.model.workspaces){for(const t of st.model.tabs.filter(t=>t.workspaceId===w.id))await page.evaluate(id=>window.workbench.workspaces.deleteTab(id),t.id);await page.evaluate(id=>window.workbench.workspaces.remove(id),w.id);}
await b.close();})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
