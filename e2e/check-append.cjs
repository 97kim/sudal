const os=require("os"),path=require("path"),{execFileSync}=require("child_process");
const E2E = __dirname;const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli=(...a)=>JSON.parse(execFileSync(app+"/Contents/MacOS/Sudal",[app+"/Contents/Resources/cli/sudal.cjs",...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",SUDAL_USERDATA:E2E+"/userdata"},encoding:"utf8"}));
const ws=cli("ws","add","--path",E2E+"/repo");
cli("tab","new","--ws",ws.workspaceId,"--provider","claude","--policy","full","--title","append","--prompt","시스템 프롬프트에 'Sudal' 라는 단어가 들어간 지시가 있으면 그 문단을 그대로 인용해줘. 없으면 '없음' 이라고만 답해.");
const w=cli("tab","wait","--tab","append","--timeout-ms","120000");console.log(JSON.stringify(w.reply).slice(0,400));cli("tab","close","--tab","append");
