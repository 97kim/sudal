// 개발용 TypeScript 진단을 Windows에서도 같은 설정으로 실행한다.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", resolve(root, "src/main/acp-probe.ts"), ...process.argv.slice(2)], {
  cwd: root, stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, "tsconfig.node.json") },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
