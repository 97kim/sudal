const os=require("os"),path=require("path"),fs=require("fs"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const ws=cli("ws","add","--path",E2E+"/repo");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","설명","--prompt","이 저장소의 a.txt 를 읽고, 줄 수를 wc 로 세고, 그 숫자를 d.txt 에 써 줘. 그리고 git status 로 상태를 확인한 뒤 결과를 한 줄로 알려줘.");
cli("tab","wait","--tab","설명","--timeout-ms","240000");
const rd=cli("tab","read","--tab","설명","--last","40");const bl=(rd.blocks||[]);const i=bl.findIndex(b=>b.kind==="user");
for(const b of bl.slice(i+1)) console.log(b.kind.padEnd(10), b.kind==="assistant"?JSON.stringify((b.text||"").slice(0,90)):b.kind==="tool"?`${b.name} ${(b.summary||"").slice(0,60)}`:"");
fs.rmSync(path.join(E2E,"repo","d.txt"),{force:true});cli("tab","close","--tab","설명");
