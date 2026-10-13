// 폴더 신뢰: 저장소의 .claude/settings.json(hooks·permissions)·.mcp.json 은 SDK 가 확인 없이 읽는다 — SDK 는 `claude -p` 처럼
// 신뢰 창을 건너뛴다. 대화형 CLI 와 같게, 신뢰한 폴더에서만 저장소 설정을 읽게 한다.
// 판정은 CLI 를 따른다: 프로젝트 뿌리(worktree 면 원래 저장소)가 신뢰됐거나, cwd 에서 git 뿌리까지 올라가는 길에 신뢰된 폴더가 있으면 신뢰.
// git 밖이면 맨 위까지 올라간다. 홈 신뢰는 CLI 처럼 기록하지 않고 앱이 켜져 있는 동안만 둔다.
// CLI 가 기록한 신뢰(~/.claude.json 의 projects[경로].hasTrustDialogAccepted)는 읽기만 한다 — CLI 가 그 파일을 통째로 다시 쓰므로 함께 쓰면 경합한다.

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

let sudalFile = "";
let sudalTrusted = new Set<string>();
let cliFile = path.join(homedir(), ".claude.json");
let cliCache: { mtimeMs: number; size: number; trusted: Set<string> } | null = null;

/** CLI 는 경로를 "/" 로 적는다(Windows 도). Windows 에서만 바꾼다 — macOS·Linux 에서 "\" 는 파일 이름에 쓸 수 있는 글자다. */
function key(p: string): string {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.replace(/\\/g, "/") : r;
}

/** 홈 신뢰는 CLI 처럼 앱이 켜져 있는 동안만 기억한다 — 기록하면 홈 아래 git 밖 폴더 전부가 영영 신뢰된다. */
const sessionTrusted = new Set<string>();

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

/** 가장 가까운 .git 이 있는 폴더(저장소 경계). git 을 부르지 않는다 — 낯선 저장소의 .git/config 를 읽는 순간 그 설정이 명령을 실행할 수 있고, 실패를 "git 밖"으로 읽으면 경계가 사라진다. */
function gitTopOf(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    // 링크든 무엇이든 있으면 경계다 — 링크라고 건너뛰면 그 저장소가 위 폴더의 신뢰를 물려받는다
    try {
      fs.lstatSync(path.join(d, ".git"));
      return d;
    } catch {}
    if (path.dirname(d) === d) return null;
  }
}

/** 일반 파일일 때만 읽는다 — FIFO 같은 특수 파일을 동기로 읽으면 메인 프로세스가 멈춘다. */
function readPlainFile(p: string): string | null {
  return fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : null;
}

/**
 * worktree 면 원래 저장소 뿌리. worktree 의 .git 파일(gitdir: …)만 믿지 않는다 — 아무 폴더나 그 줄로 신뢰된 저장소를 가리킬 수 있다.
 * git 이 실제로 두는 자리(<원래 저장소>/.git/worktrees/<이름>)여야 하고, 그 안의 기록(gitdir)이 이 .git 파일을 되가리켜야 인정한다.
 * 그 자리는 원래 저장소 안이라, 낯선 폴더가 자기 안에 비슷한 메타데이터를 만들어도 통하지 않는다.
 */
function worktreeRoot(top: string): string | null {
  try {
    const dotGit = path.join(top, ".git");
    if (!fs.lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readPlainFile(dotGit) ?? "");
    if (!m) return null;
    const gitdir = fs.realpathSync.native(path.resolve(top, m[1].trim()));
    const common = path.dirname(path.dirname(gitdir));
    if (path.basename(path.dirname(gitdir)) !== "worktrees" || path.basename(common) !== ".git" || !fs.statSync(common).isDirectory()) return null;
    const back = readPlainFile(path.join(gitdir, "gitdir"))?.trim();
    if (!back || fs.realpathSync.native(path.resolve(gitdir, back)) !== fs.realpathSync.native(dotGit)) return null;
    return path.dirname(common);
  } catch {
    return null;
  }
}

/** 신뢰를 기록할 프로젝트 뿌리와, 신뢰를 물려받을 수 있는 폴더들(cwd 부터 위로). */
export async function trustScope(cwd: string): Promise<{ root: string; walk: string[] }> {
  let real = path.resolve(cwd);
  try {
    real = fs.realpathSync.native(real);
  } catch {}
  const gitTop = gitTopOf(real);
  const root = (gitTop && worktreeRoot(gitTop)) ?? gitTop ?? real;
  const walk: string[] = [];
  for (let d = real; ; d = path.dirname(d)) {
    walk.push(d);
    if ((gitTop && key(d) === key(gitTop)) || path.dirname(d) === d) break;
  }
  return { root, walk };
}

export async function isFolderTrusted(cwd: string): Promise<boolean> {
  const { root, walk } = await trustScope(cwd);
  const cli = cliTrusted();
  const home = key(homedir());
  return [root, ...walk].some((p) => {
    const k = key(p);
    return k === home ? sessionTrusted.has(k) : sudalTrusted.has(k) || cli.has(k);
  });
}

export async function trustFolder(cwd: string): Promise<void> {
  const { root } = await trustScope(cwd);
  if (key(root) === key(homedir())) {
    sessionTrusted.add(key(root));
    return;
  }
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
