// 폴더 신뢰: 저장소의 .claude/settings.json(hooks·permissions)·.mcp.json 은 SDK 가 확인 없이 읽는다 — SDK 는 `claude -p` 처럼
// 신뢰 창을 건너뛴다. 대화형 CLI 와 같게, 신뢰한 폴더에서만 저장소 설정을 읽게 한다.
// 판정은 CLI 를 따른다: 프로젝트 뿌리(worktree 면 원래 저장소)가 신뢰됐거나, cwd 에서 git 뿌리까지 올라가는 길에 신뢰된 폴더가 있으면 신뢰.
// git 밖이면 맨 위까지 올라간다. 홈 폴더는 건너뛴다(CLI 도 홈 신뢰는 그 세션에만 두고 기록하지 않는다).
// CLI 가 기록한 신뢰(~/.claude.json 의 projects[경로].hasTrustDialogAccepted)는 읽기만 한다 — CLI 가 그 파일을 통째로 다시 쓰므로 함께 쓰면 경합한다.

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runGit } from "./git-run";

let sudalFile = "";
let sudalTrusted = new Set<string>();
let cliFile = path.join(homedir(), ".claude.json");
let cliCache: { mtimeMs: number; size: number; trusted: Set<string> } | null = null;

/** CLI 는 경로를 "/" 로 적는다(Windows 도). 같은 모양으로 비교한다. */
function key(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

export function initFolderTrust(file: string, claudeConfig = cliFile): void {
  sudalFile = file;
  cliFile = claudeConfig;
  cliCache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    sudalTrusted = new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string").map(key) : []);
  } catch {
    sudalTrusted = new Set();
  }
}

function cliTrusted(): Set<string> {
  try {
    const st = fs.statSync(cliFile);
    if (cliCache && cliCache.mtimeMs === st.mtimeMs && cliCache.size === st.size) return cliCache.trusted;
    const projects = (JSON.parse(fs.readFileSync(cliFile, "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> }).projects ?? {};
    const trusted = new Set(Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted === true).map(([k]) => key(k)));
    cliCache = { mtimeMs: st.mtimeMs, size: st.size, trusted };
    return trusted;
  } catch {
    return new Set();
  }
}

/** 신뢰를 기록할 프로젝트 뿌리와, 신뢰를 물려받을 수 있는 폴더들(cwd 부터 위로). */
export async function trustScope(cwd: string): Promise<{ root: string; walk: string[] }> {
  let real = path.resolve(cwd);
  try {
    real = fs.realpathSync.native(real);
  } catch {}
  const r = await runGit(real, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], process.env, { timeout: 5000 });
  const [top, common] = r.code === 0 ? r.stdout.split(/\r?\n/) : [];
  const gitTop = top ? path.resolve(top) : null;
  // worktree 는 원래 저장소 뿌리를 프로젝트로 본다(오케스트레이션 worktree 가 저장소 신뢰를 이어받는다)
  const root = common && path.basename(common) === ".git" ? path.dirname(path.resolve(common)) : (gitTop ?? real);
  const home = key(homedir());
  const walk: string[] = [];
  for (let d = real; ; d = path.dirname(d)) {
    if (key(d) !== home) walk.push(d);
    if ((gitTop && key(d) === key(gitTop)) || path.dirname(d) === d) break;
  }
  return { root, walk };
}

export async function isFolderTrusted(cwd: string): Promise<boolean> {
  const { root, walk } = await trustScope(cwd);
  const cli = cliTrusted();
  return [root, ...walk].some((p) => sudalTrusted.has(key(p)) || cli.has(key(p)));
}

export async function trustFolder(cwd: string): Promise<void> {
  const { root } = await trustScope(cwd);
  sudalTrusted.add(key(root));
  if (!sudalFile) return;
  fs.mkdirSync(path.dirname(sudalFile), { recursive: true });
  const tmp = `${sudalFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...sudalTrusted], null, 2), "utf8");
  fs.renameSync(tmp, sudalFile);
}

/** 신뢰하지 않은 폴더에서는 저장소 설정(project·local)을 빼고 사용자 설정만 읽는다. */
export async function claudeSettingSources(cwd: string): Promise<["user"] | undefined> {
  return (await isFolderTrusted(cwd)) ? undefined : ["user"];
}
