// 앱 이름이 Atelier → Sudal 로 바뀌면서 옛 설치가 남긴 것을 넘겨받는다.
// 옛 이름을 계속 받아 주는 호환이 아니다 — 처음 한 번 옮기고 나면 옛 이름은 어디에도 쓰지 않는다.

import fs from "node:fs";
import path from "node:path";
import type { Provider } from "@shared/ipc";

/** 옛 userData 폴더 이름. 앞의 것이 더 최근 이름이다. */
export const LEGACY_USERDATA_NAMES = ["Atelier", "ai-workbench"];

/** 실행 중인 인스턴스의 것이라 옮기면 안 되는 파일. 새 앱이 자기 것을 새로 만든다. */
const INSTANCE_FILES = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort", "control.json", "control.sock"]);

/** Electron 의 SingletonLock 은 "<호스트>-<pid>" 를 가리키는 심링크다. 그 pid 가 살아 있으면 옛 앱이 실행 중이다. */
export function legacyInstanceRunning(dir: string, isAlive: (pid: number) => boolean = pidAlive): boolean {
  try {
    const pid = Number(fs.readlinkSync(path.join(dir, "SingletonLock")).split("-").pop());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid);
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type UserDataMigration = { kind: "none" } | { kind: "migrated"; from: string } | { kind: "running"; from: string };

/**
 * 옛 userData 를 새 폴더로 옮긴다. Electron 이 새 폴더를 먼저 만들어 두므로 폴더 유무가 아니라 workspaces.json 유무로
 * 판단하고, 항목 단위로 옮긴다. 새 폴더에 이미 같은 이름이 있으면(Chromium 캐시 등) 건너뛴다.
 * 옛 앱이 실행 중이면 옮기지 않는다 — 쓰는 중인 폴더를 빼내면 양쪽이 다 깨진다.
 * userData 를 따로 지정해 띄운 경우(--user-data-dir, 검증용 인스턴스)에는 하지 않는다 — 쓰던 데이터를 엉뚱한 곳으로 옮기게 된다.
 */
export function migrateUserData(next: string, appData: string, isAlive?: (pid: number) => boolean): UserDataMigration {
  if (path.dirname(next) !== appData) return { kind: "none" };
  if (fs.existsSync(path.join(next, "workspaces.json"))) return { kind: "none" };
  for (const name of LEGACY_USERDATA_NAMES) {
    const prev = path.join(appData, name);
    if (!fs.existsSync(path.join(prev, "workspaces.json"))) continue;
    if (legacyInstanceRunning(prev, isAlive)) return { kind: "running", from: prev };
    fs.mkdirSync(next, { recursive: true });
    for (const entry of fs.readdirSync(prev)) {
      if (INSTANCE_FILES.has(entry)) {
        fs.rmSync(path.join(prev, entry), { force: true });
        continue;
      }
      if (fs.existsSync(path.join(next, entry))) continue;
      fs.renameSync(path.join(prev, entry), path.join(next, entry));
    }
    if (fs.readdirSync(prev).length === 0) fs.rmdirSync(prev);
    return { kind: "migrated", from: prev };
  }
  return { kind: "none" };
}

/** 옛 이름으로 설치된 CLI 와 에이전트 스킬. 지우고 나서 같은 것을 새 이름으로 다시 설치할 수 있게 무엇이 있었는지 돌려준다. */
export function removeLegacyInstall(home: string, codexHome: string): { cli: boolean; skills: (Provider)[] } {
  const found = { cli: false, skills: [] as (Provider)[] };
  const shim = path.join(home, ".local", "bin", "atelier");
  try {
    // 같은 이름의 남의 프로그램일 수 있으니 우리가 쓴 스크립트일 때만 지운다
    if (fs.readFileSync(shim, "utf8").includes("atelier.cjs")) {
      fs.rmSync(shim, { force: true });
      found.cli = true;
    }
  } catch {
    // 없으면 할 일이 없다
  }
  const skills: [Provider, string][] = [
    ["claude", path.join(home, ".claude", "skills", "atelier-cli")],
    ["codex", path.join(codexHome, "skills", "atelier-cli")],
  ];
  for (const [agent, dir] of skills) {
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    found.skills.push(agent);
  }
  return found;
}

/** 옛 기본 worktree 폴더. 설정으로 정해 둔 적이 없고 이 폴더가 있으면, 이미 만든 worktree 를 계속 쓰도록 그 경로를 설정에 적는다. */
export function legacyWorktreeDir(home: string): string | null {
  const dir = path.join(home, "atelier", "worktrees");
  return fs.existsSync(dir) ? dir : null;
}
