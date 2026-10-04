const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "경합" + Date.now(), "--activate").tab.id;
console.log("TAB", tab.slice(0, 6));
cli("tab", "send", "--tab", tab, "--text", "Bash 도구를 run_in_background:true 로 `sleep 90 && echo 끝` 실행하고, 기다리지 말고 '시작' 한 마디만 답해라.");
