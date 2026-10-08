#!/usr/bin/env node
// yarn test. 명령 앞에 환경변수를 붙이는 셸 문법은 Windows 에서 돌지 않아 여기서 넣고 node 를 띄운다.
// 뒤에 준 인자는 node --test 에 그대로 붙인다.
import { spawnSync } from "node:child_process";

const r = spawnSync(
  process.execPath,
  ["--import", "tsx", "--import", "./scripts/test-electron-stub.mjs", "--test", "--test-force-exit", "src/**/*.test.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.node.json" } },
);
process.exit(r.status ?? 1);
