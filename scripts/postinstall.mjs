#!/usr/bin/env node
// yarn install 뒤에 돈다. 셸 문법(&&, glob, chmod) 없이 써서 Windows 의 cmd 에서도 돈다.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const r = spawnSync(process.execPath, [join(ROOT, "node_modules/electron/install.js")], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

// node-pty 프리빌드의 spawn-helper 는 실행 권한 없이 풀려 터미널을 띄우지 못한다. Windows 에는 이 파일도 실행 권한도 없다.
if (process.platform !== "win32") {
  const prebuilds = join(ROOT, "node_modules/node-pty/prebuilds");
  for (const dir of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
    const helper = join(prebuilds, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
