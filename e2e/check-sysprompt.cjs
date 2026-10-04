// 도구가 필요한 요청에서 첫 블록이 텍스트(한 줄 설명)인지
const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const ws=cli("ws","add","--path",E2E+"/repo");cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","프롬프트","--prompt","이 저장소에 어떤 파일이 있는지 확인하고 한 줄로 요약해줘.");
cli("tab","wait","--tab","프롬프트","--timeout-ms","180000");
const rd=cli("tab","read","--tab","프롬프트","--last","20");const kinds=(rd.blocks||[]).map(b=>b.kind);const i=kinds.indexOf("user");
console.log("blocks after user:",JSON.stringify(kinds.slice(i+1)));
console.log("first assistant block:",(rd.blocks||[])[i+1]?.kind, JSON.stringify(((rd.blocks||[])[i+1]?.text||"").slice(0,80)));
cli("tab","close","--tab","프롬프트");
