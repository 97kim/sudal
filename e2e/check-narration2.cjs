const os=require("os"),path=require("path"),fs=require("fs"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const ws=cli("ws","add","--path",E2E+"/repo");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","디버그","--prompt","`node buggy.js` 를 실행하면 에러가 나. 원인을 찾아서 고치고, 다시 실행해서 확인해 줘.");
cli("tab","wait","--tab","디버그","--timeout-ms","300000");
const rd=cli("tab","read","--tab","디버그","--last","40");const bl=(rd.blocks||[]);const i=bl.findIndex(b=>b.kind==="user");
for(const b of bl.slice(i+1)) console.log(b.kind.padEnd(10), b.kind==="assistant"?JSON.stringify((b.text||"").slice(0,100)):b.kind==="tool"?`${b.name} ${(b.summary||"").slice(0,60)}`:"");
cli("tab","close","--tab","디버그");
