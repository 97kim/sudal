// 작업 디렉토리의 git 정보 — 컨텍스트 패널(저장소·브랜치·변경 파일)용. git 이 없거나 레포가 아니면 null.
import { runGit, type GitRun } from "./git-run";
import fs from "node:fs";
import { basename, resolve } from "node:path";
import type { GitChangeDto, GitCommitResult, GitInfoDto } from "@shared/ipc";
import { mt } from "./i18n";

/** 사용자가 고른 경로는 그대로 파일 이름이다 — `:(glob)`·`:(exclude)` 같은 pathspec 매직으로 해석되지 않게 한다. */
function literal(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

function gitRun(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 15000): Promise<GitRun> {
  return runGit(cwd, args, env, { timeout });
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return gitRun(cwd, args, env, 5000).then((r) => (r.code === 0 ? r.stdout : null));
}

export async function gitInfo(cwd: string, env: NodeJS.ProcessEnv): Promise<GitInfoDto | null> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"], env))?.trim();
  if (!top) return null;
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env))?.trim() || null;
  // cwd 가 레포 하위 디렉토리(또는 심링크 경로)일 때 status 의 루트 기준 경로와 맞추기 위한 접두 경로
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"], env))?.trim().replace(/\/$/, "") ?? "";
  return { root: top, name: basename(top), branch, prefix };
}

/**
 * `git status --porcelain -z` + `git diff --numstat -z` 를 합쳐 파일별 상태와 +/- 줄 수를 만든다.
 * -z(NUL 구분)를 쓰는 이유: 공백·한글이 든 경로가 "..." 로 인용·이스케이프되지 않아 그대로 파일 이름으로 쓸 수 있다.
 */
export async function gitChanges(cwd: string, env: NodeJS.ProcessEnv): Promise<GitChangeDto[]> {
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], env);
  if (status === null) return [];
  const counts = new Map<string, { added: number; deleted: number }>();
  const numstat = (await git(cwd, ["diff", "--numstat", "-z", "HEAD"], env)) ?? "";
  // 레코드: "a\tb\tpath" 또는 (이름 변경) "a\tb\t" 뒤에 old, new 가 별도 필드로 온다.
  const nf = numstat.split("\0");
  for (let i = 0; i < nf.length; i++) {
    const m = nf[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let path = m[3];
    if (!path) {
      i += 2;
      path = nf[i] ?? "";
    }
    if (!path) continue;
    counts.set(path, { added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  const out: GitChangeDto[] = [];
  // 레코드: "XY path" 이고, XY 에 R/C 가 있으면 다음 필드가 옛 경로다.
  const sf = status.split("\0");
  for (let i = 0; i < sf.length; i++) {
    const rec = sf[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    let oldPath: string | undefined;
    if (/[RC]/.test(xy)) oldPath = sf[++i];
    const kind: GitChangeDto["kind"] =
      xy === "??" || xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : xy.includes("R") ? "renamed" : "modified";
    const c = counts.get(path);
    out.push({ path, ...(oldPath ? { oldPath } : {}), kind, added: c?.added ?? 0, deleted: c?.deleted ?? 0 });
  }
  // 추적 중인 파일의 수정을 먼저, 새 파일(대개 생성물)은 뒤로.
  const rank: Record<GitChangeDto["kind"], number> = { modified: 0, deleted: 1, renamed: 2, added: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
}

/**
 * 고른 파일만 커밋한다. `git add -A -- <paths>` 로 새 파일·삭제를 인덱스에 반영한 뒤
 * `git commit -- <paths>` 로 그 경로만 커밋하므로, 다른 파일의 스테이징 상태는 그대로 남는다.
 * 단, 고른 파일 자체는 작업 트리 내용 전체가 들어간다(`git add -p` 로 만든 부분 스테이징은 덮어씀).
 * 머지·리베이스 진행 중에는 git 이 부분 커밋을 거부하므로 그 stderr 가 그대로 오류로 보인다.
 */
export async function gitCommit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  paths: string[],
  message: string,
): Promise<GitCommitResult> {
  const wanted = paths.filter((p) => p.trim().length > 0);
  const msg = message.trim();
  if (wanted.length === 0) return { ok: false, error: mt("repo.git.pickFiles") };
  if (!msg) return { ok: false, error: mt("repo.git.needMessage") };
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"], env))?.trim();
  if (!top) return { ok: false, error: mt("repo.git.notGitRepo") };
  // 목록을 본 뒤 사라진 파일(훅이 만든 임시 파일 등)은 건너뛴다 — pathspec 오류로 전체가 실패하지 않게.
  const files = await resolveChangePaths(top, env, wanted);
  if (files.length === 0) return { ok: false, error: mt("repo.git.noChanges") };
  // add 에는 새 경로만: 이름 변경(R)의 옛 경로는 이미 인덱스에서 삭제돼 있어 add 가 pathspec 오류를 낸다.
  // commit 에는 옛 경로도 넣어야 삭제가 같은 커밋에 들어간다.
  // 삭제는 add 대신 rm --cached 로: `git rm` 으로 이미 스테이징된 삭제는 인덱스에도 작업 트리에도 없어 add 가 pathspec 오류를 낸다.
  // --ignore-unmatch 라 그런 경우는 조용히 지나가고, 작업 트리에서만 지운 파일은 여기서 인덱스에서 빠진다.
  const deleted = files.filter((f) => f.kind === "deleted");
  const others = files.filter((f) => f.kind !== "deleted");
  if (others.length > 0) {
    const add = await gitRun(top, ["add", "-A", "--", ...literal(others.map((f) => f.path))], env);
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || mt("repo.git.addFailed") };
  }
  if (deleted.length > 0) {
    const rm = await gitRun(top, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...literal(deleted.map((f) => f.path))], env);
    if (rm.code !== 0) return { ok: false, error: rm.stderr.trim() || mt("repo.git.rmFailed") };
  }
  const spec = literal(files.map((f) => f.path).concat(files.flatMap((f) => (f.oldPath ? [f.oldPath] : []))));
  const commit = await gitRun(top, ["commit", "-m", msg, "--", ...spec], env);
  if (commit.code !== 0) return { ok: false, error: commit.stderr.trim() || commit.stdout.trim() || mt("repo.git.commitFailed") };
  const hash = (await git(top, ["rev-parse", "--short", "HEAD"], env))?.trim() ?? "";
  return { ok: true, hash, subject: msg.split("\n")[0], files: files.length };
}

/**
 * 렌더러가 준 경로를 현재 `git status` 목록과 대조해 실제 변경 항목으로 바꾼다.
 * 목록에 없는 경로(사라졌거나 레포 밖)는 버리고, 이름 변경은 oldPath 를 같이 돌려준다.
 */
async function resolveChangePaths(top: string, env: NodeJS.ProcessEnv, wanted: string[]): Promise<GitChangeDto[]> {
  const byPath = new Map((await gitChanges(top, env)).map((c) => [c.path, c] as const));
  const out: GitChangeDto[] = [];
  for (const p of wanted) {
    const c = byPath.get(p);
    if (c) out.push(c);
  }
  return out;
}

const DIFF_MAX = 40_000;

/** 고른 파일의 diff(HEAD 기준). 새 파일은 --no-index 로 /dev/null 과 비교해 같은 형식으로 만든다. 길면 자른다. */
export async function gitDiffFor(cwd: string, env: NodeJS.ProcessEnv, paths: string[]): Promise<string> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"], env))?.trim();
  if (!top || paths.length === 0) return "";
  // 커밋과 같은 규칙: 변경 목록에 있는 경로만, 레포 밖은 절대 읽지 않는다.
  const changes = await resolveChangePaths(top, env, paths);
  const wantedPaths = changes.map((c) => c.path).concat(changes.flatMap((c) => (c.oldPath ? [c.oldPath] : [])));
  if (wantedPaths.length === 0) return "";
  // "git 이 아는 경로" = 인덱스에 있거나 HEAD 에 있는 것. `git rm` 으로 스테이징된 삭제는 인덱스에 없어 ls-files 만으로는 빠진다.
  const hasHead = (await gitRun(top, ["rev-parse", "--verify", "-q", "HEAD"], env)).code === 0;
  const inIndex = (await git(top, ["ls-files", "--", ...literal(wantedPaths)], env))?.split("\n").filter(Boolean) ?? [];
  const inHead = hasHead ? ((await git(top, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...literal(wantedPaths)], env))?.split("\n").filter(Boolean) ?? []) : [];
  const tracked = [...new Set([...inIndex, ...inHead])];
  const trackedSet = new Set(tracked);
  const parts: string[] = [];
  if (tracked.length > 0) {
    // 첫 커밋 전(unborn HEAD)에는 HEAD 비교가 불가 — 인덱스 대비 + 작업 트리 대비를 합친다.
    const spec = literal(tracked);
    if (hasHead) {
      const d = await gitRun(top, ["diff", "HEAD", "--", ...spec], env);
      if (d.stdout) parts.push(d.stdout);
    } else {
      for (const args of [["diff", "--cached", "--", ...spec], ["diff", "--", ...spec]]) {
        const d = await gitRun(top, args, env);
        if (d.stdout) parts.push(d.stdout);
      }
    }
  }
  for (const c of changes) {
    if (trackedSet.has(c.path) || c.kind === "deleted") continue;
    // 새 파일: /dev/null 과 비교해 같은 형식으로. 종료 코드 1 = 차이 있음(정상)
    const d = await gitRun(top, ["diff", "--no-index", "--", "/dev/null", c.path], env);
    if (d.stdout) parts.push(d.stdout);
  }
  const all = parts.join("\n");
  return all.length > DIFF_MAX ? `${all.slice(0, DIFF_MAX)}\n${mt("prompt.git.diffTruncated", { count: all.length - DIFF_MAX })}` : all;
}

/** 최근 커밋 제목 — 초안이 레포의 메시지 스타일을 따르게 힌트로 준다. */
export async function gitRecentSubjects(cwd: string, env: NodeJS.ProcessEnv, n = 8): Promise<string[]> {
  const out = await git(cwd, ["log", `-${n}`, "--format=%s"], env);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * 파일 하나의 변경을 버린다(HEAD 상태로). 되돌릴 수 없으므로 UI 가 확인을 받는다.
 *   modified/deleted → checkout HEAD (인덱스·작업 트리 모두)
 *   added: 추적 안 됨 → 파일 삭제, 스테이징된 새 파일 → git rm
 *   renamed → 옛 경로 복원 + 새 경로 제거
 */
export async function gitRevert(
  cwd: string,
  env: NodeJS.ProcessEnv,
  path: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"], env))?.trim();
  if (!top) return { ok: false, error: mt("repo.git.notGitRepo") };
  const [change] = await resolveChangePaths(top, env, [path]);
  if (!change) return { ok: false, error: mt("repo.git.notInChanges") };
  const run = async (args: string[]) => {
    const r = await gitRun(top, args, env);
    return r.code === 0 ? null : r.stderr.trim() || mt("repo.git.commandFailed", { command: args[0] });
  };
  let err: string | null = null;
  switch (change.kind) {
    case "added": {
      const tracked = (await gitRun(top, ["ls-files", "--error-unmatch", "--", ...literal([change.path])], env)).code === 0;
      if (tracked) err = await run(["rm", "-f", "-q", "--", ...literal([change.path])]);
      else {
        try {
          // "?? sub/" 처럼 디렉토리 한 줄(중첩 저장소 등)이면 통째로 지운다 — 사용자가 그 항목의 버리기를 확인한 것이다.
          const isDir = change.path.endsWith("/");
          fs.rmSync(resolve(top, change.path), { force: true, recursive: isDir });
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
      }
      break;
    }
    case "renamed": {
      const old = change.oldPath;
      // 대소문자만 바뀐 이름(APFS 는 대소문자 무시): 두 경로가 같은 파일이라 rm 을 하면 복원한 파일까지 지워진다.
      // → 인덱스에서 새 이름만 빼고, 디스크 이름을 옛 이름으로 바꾼 뒤 HEAD 내용으로 되돌린다.
      if (old && old.toLowerCase() === change.path.toLowerCase()) {
        err = await run(["rm", "--cached", "-q", "--", ...literal([change.path])]);
        if (!err) {
          try {
            fs.renameSync(resolve(top, change.path), resolve(top, old));
          } catch (e) {
            err = e instanceof Error ? e.message : String(e);
          }
        }
        if (!err) err = await run(["checkout", "HEAD", "--", ...literal([old])]);
      } else if (!old) {
        // 옛 경로를 모르면 삭제만 하는 것은 위험하다 — 수정처럼 HEAD 로 되돌리기만 한다.
        err = await run(["checkout", "HEAD", "--", ...literal([change.path])]);
      } else {
        err =
          (await run(["checkout", "HEAD", "--", ...literal([old])])) ??
          (await run(["rm", "-f", "-q", "--", ...literal([change.path])]));
      }
      break;
    }
    default:
      err = await run(["checkout", "HEAD", "--", ...literal([change.path])]);
  }
  return err ? { ok: false, error: err } : { ok: true };
}
