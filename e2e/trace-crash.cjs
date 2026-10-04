const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "크래시" + Date.now(), "--activate").tab.id;
console.log("TAB", tab.slice(0, 6));
cli("tab", "send", "--tab", tab, "--text", "Bash 도구로 `sleep 40` 을 실행해라(백그라운드 아님). 끝나면 '끝' 한 마디만.");
