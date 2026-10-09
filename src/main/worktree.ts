// 세션별 git worktree: 같은 저장소에서 세션 여러 개가 서로 파일을 건드리지 않게 탭마다 브랜치+작업 트리를 따로 준다.
// worktree 는 저장소 밖(<worktree 폴더>/<repo>/<slug>, 기본 ~/sudal/worktrees)에 만들어 원본에 untracked 파일로 보이지 않게 한다.
import { execFile } from "node:child_process";
import { runGit, type GitRun } from "./git-run";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { isWithin } from "./path-within";
import type { WorktreeMeta } from "@shared/workspace-model";
import type { GitChangeDto } from "@shared/ipc";
import { mt } from "./i18n";

type Run = GitRun;

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return runGit(cwd, args, env, { timeout: 30000 });
}

const ok = (r: Run) => (r.code === 0 ? r.stdout.trim() : null);

/** 브랜치·디렉토리 이름으로 쓸 수 있게: 소문자, 영숫자·한글·-·_ 만, 24자. */
export function worktreeSlug(raw: string, now = Date.now()): string {
  const base = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const stamp = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base || "session"}-${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
}

export async function worktreeCreate(
  repoCwd: string,
  env: NodeJS.ProcessEnv,
  opts: { rootDir: string; slug: string },
): Promise<{ ok: true; worktree: WorktreeMeta } | { ok: false; error: string }> {
  const top = ok(await run(repoCwd, ["rev-parse", "--show-toplevel"], env));
  if (!top) return { ok: false, error: mt("repo.worktree.notGitRepo") };
  const head = ok(await run(top, ["rev-parse", "--verify", "-q", "HEAD"], env));
  if (!head) return { ok: false, error: mt("repo.worktree.needFirstCommit") };
  const baseRef = ok(await run(top, ["rev-parse", "--abbrev-ref", "HEAD"], env));
  if (!baseRef || baseRef === "HEAD")
    return { ok: false, error: mt("repo.worktree.detachedHead") };
  const base = baseRef;
  // worktree 폴더를 저장소 안에 두면 만든 worktree 가 원본에 untracked 로 잡힌다(위치는 설정에서 고른다)
  if (isWithin(resolve(top), resolve(opts.rootDir)))
    return { ok: false, error: mt("repo.worktree.insideRepo", { dir: opts.rootDir }) };
  const dir = join(opts.rootDir, basename(top));
  fs.mkdirSync(dir, { recursive: true });
  // 이름 충돌 회피
  let slug = opts.slug;
  for (let i = 2; fs.existsSync(join(dir, slug)) || (await run(top, ["rev-parse", "--verify", "-q", `refs/heads/sudal/${slug}`], env)).code === 0; i++)
    slug = `${opts.slug}-${i}`;
  const path = join(dir, slug);
  const branch = `sudal/${slug}`;
  const r = await run(top, ["worktree", "add", "-b", branch, path, "HEAD"], env);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || mt("repo.worktree.createFailed") };
  return { ok: true, worktree: { repo: top, path, branch, base } };
}

export interface WorktreeStatus {
  exists: boolean;
  /** base 브랜치가 사라졌으면 true — 가져오기를 막는다. */
  baseMissing: boolean;
  /** base 에 없는 이 브랜치의 커밋 수. */
  ahead: number;
  /** 이 브랜치에 없는 base 의 커밋 수. */
  behind: number;
  /** 커밋되지 않은 변경 파일 수. */
  dirty: number;
}

export async function worktreeStatus(env: NodeJS.ProcessEnv, wt: WorktreeMeta): Promise<WorktreeStatus> {
  if (!fs.existsSync(wt.path)) return { exists: false, baseMissing: false, ahead: 0, behind: 0, dirty: 0 };
  const baseMissing = (await run(wt.repo, ["rev-parse", "--verify", "-q", `refs/heads/${wt.base}`], env)).code !== 0;
  const count = async (range: string) => Number(ok(await run(wt.repo, ["rev-list", "--count", range], env)) ?? 0);
  const status = ok(await run(wt.path, ["status", "--porcelain", "-z", "--untracked-files=all"], env)) ?? "";
  // -z 는 rename 의 옛 경로를 별도 필드로 내보낸다 — 그 필드는 파일로 세지 않는다.
  let dirty = 0;
  const fields = status ? status.split("\0") : [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    dirty++;
    if (/[RC]/.test(f.slice(0, 2))) i++;
  }
  return {
    exists: true,
    baseMissing,
    ahead: baseMissing ? 0 : await count(`${wt.base}..${wt.branch}`),
    behind: baseMissing ? 0 : await count(`${wt.branch}..${wt.base}`),
    dirty,
  };
}

/**
 * 이 세션의 커밋을 base 로 가져온다(원본 저장소에서 merge). 원본이 base 브랜치에 있어야 하고 worktree 에 미커밋 변경이 없어야 한다.
 * 충돌이 나면 merge 를 되돌리고 오류로 알린다.
 */
export async function worktreeMerge(
  env: NodeJS.ProcessEnv,
  wt: WorktreeMeta,
): Promise<{ ok: true; merged: number } | { ok: false; error: string }> {
  const st = await worktreeStatus(env, wt);
  if (!st.exists) return { ok: false, error: mt("repo.worktree.notFound") };
  if (st.baseMissing) return { ok: false, error: mt("repo.worktree.baseMissing", { base: wt.base }) };
  if (st.dirty > 0) return { ok: false, error: mt("repo.worktree.dirty", { count: st.dirty }) };
  if (st.ahead === 0) return { ok: true, merged: 0 };
  const cur = ok(await run(wt.repo, ["rev-parse", "--abbrev-ref", "HEAD"], env));
  if (cur !== wt.base) return { ok: false, error: mt("repo.worktree.wrongBranch", { current: cur ?? mt("repo.worktree.unknownBranch"), base: wt.base }) };
  const repoDirty = ok(await run(wt.repo, ["status", "--porcelain", "--untracked-files=no"], env)) ?? "";
  if (repoDirty) return { ok: false, error: mt("repo.worktree.repoDirty") };
  const m = await run(wt.repo, ["merge", "--no-edit", wt.branch], env);
  if (m.code !== 0) {
    await run(wt.repo, ["merge", "--abort"], env);
    return { ok: false, error: mt("repo.worktree.mergeFailed", { detail: (m.stdout + m.stderr).trim().split("\n").slice(-3).join(" ") }) };
  }
  return { ok: true, merged: st.ahead };
}

/** worktree 를 지운다. 미커밋 변경이 있으면 force 없이는 거부. 브랜치는 base 에 합쳐졌을 때만 지운다(-d). */
export async function worktreeRemove(
  env: NodeJS.ProcessEnv,
  wt: WorktreeMeta,
  opts: { force?: boolean } = {},
): Promise<{ ok: true; branchDeleted: boolean } | { ok: false; error: string }> {
  if (fs.existsSync(wt.path)) {
    const st = await worktreeStatus(env, wt);
    if (st.dirty > 0 && !opts.force)
      return { ok: false, error: mt("repo.worktree.removeDirty", { count: st.dirty }) };
    const r = await run(wt.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt.path], env);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || mt("repo.worktree.removeFailed") };
  } else {
    await run(wt.repo, ["worktree", "prune"], env);
  }
  const del = await run(wt.repo, ["branch", "-d", wt.branch], env);
  return { ok: true, branchDeleted: del.code === 0 };
}

/** 앱이 만든 worktree 하나(설정의 정리 목록용). */
export interface ManagedWorktree {
  path: string;
  /** 원본 저장소(메인 작업 트리) 경로. */
  repo: string;
  branch: string;
  dirty: number;
  /** 디스크 사용량(KB). 너무 커서 제때 못 셌으면 null. */
  sizeKb: number | null;
}

/**
 * worktree 폴더들(<root>/<repo>/<slug>) 에서 git worktree 를 모은다. `.git` 이 파일("gitdir: …/.git/worktrees/<name>")인 폴더만.
 * 원본 저장소는 그 gitdir 에서 거꾸로 찾는다 — 앱이 탭에 적어 둔 정보가 없어도(탭을 지웠어도) 정리할 수 있게.
 */
export async function listManagedWorktrees(env: NodeJS.ProcessEnv, roots: string[]): Promise<ManagedWorktree[]> {
  const out: ManagedWorktree[] = [];
  const seen = new Set<string>();
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name));
    } catch {
      return [];
    }
  };
  for (const root of roots)
    for (const repoDir of dirs(root))
      for (const path of dirs(repoDir)) {
        const real = (() => {
          try {
            return fs.realpathSync(path);
          } catch {
            return path;
          }
        })();
        if (seen.has(real)) continue;
        let gitdir: string;
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(join(path, ".git"), "utf8"));
          if (!m) continue;
          gitdir = resolve(path, m[1].trim());
        } catch {
          continue;
        }
        seen.add(real);
        // <repo>/.git/worktrees/<name> → <repo>
        const repo = resolve(gitdir, "..", "..", "..");
        const branch = ok(await run(path, ["rev-parse", "--abbrev-ref", "HEAD"], env)) ?? "";
        const status = ok(await run(path, ["status", "--porcelain", "--untracked-files=all"], env)) ?? "";
        out.push({ path, repo, branch, dirty: status ? status.split("\n").filter(Boolean).length : 0, sizeKb: await diskUsageKb(path) });
      }
  return out;
}

function diskUsageKb(path: string): Promise<number | null> {
  // Windows 에는 du 가 없어 직접 훑는다
  if (process.platform === "win32") return walkSizeKb(path, Date.now() + 10_000);
  return new Promise((done) => {
    execFile("du", ["-sk", path], { timeout: 10_000 }, (err, stdout) => {
      const n = err ? NaN : Number(String(stdout).split(/\s+/)[0]);
      done(Number.isFinite(n) ? n : null);
    });
  });
}

/**
 * 폴더 아래 파일 크기의 합(KB, 올림). 링크·정션은 따라가지 않는다(worktree 밖을 셀 수 있다).
 * du -sk 는 디스크에 잡힌 공간이고 이것은 파일 크기의 합이라 값이 조금 다르다 — 정리 화면에서 "대략 이만큼" 을 보이는 데는 충분하다.
 * du 처럼 시간 제한을 둔다: deadline 을 넘기면 null(크기를 보이지 않는다). 파일을 읽는 도중에도 확인한다.
 * 지워지는 중인 파일(ENOENT)은 건너뛰지만, 읽지 못한 폴더·파일(권한 등)이 있으면 null — 작은 값으로 보이면 오해한다.
 */
export async function walkSizeKb(root: string, deadline: number): Promise<number | null> {
  const BATCH = 64;
  let bytes = 0;
  const stack = [root];
  const gone = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
  try {
    while (stack.length > 0) {
      if (Date.now() > deadline) return null;
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (gone(e)) continue;
        throw e;
      }
      const files: string[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) files.push(p);
      }
      for (let i = 0; i < files.length; i += BATCH) {
        if (Date.now() > deadline) return null;
        const sizes = await Promise.all(
          files.slice(i, i + BATCH).map((f) =>
            fs.promises.lstat(f).then(
              (st) => st.size,
              (e) => {
                if (gone(e)) return 0;
                throw e;
              },
            ),
          ),
        );
        for (const n of sizes) bytes += n;
      }
    }
  } catch {
    return null;
  }
  return Date.now() > deadline ? null : Math.ceil(bytes / 1024);
}

function runInput(cwd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<Run> {
  return runGit(cwd, args, env, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, input });
}

/** base 브랜치와 갈라진 지점(merge-base). base 가 없으면 null. */
export async function worktreeBase(env: NodeJS.ProcessEnv, wt: WorktreeMeta): Promise<string | null> {
  return ok(await run(wt.repo, ["merge-base", wt.base, wt.branch], env)) ?? ok(await run(wt.repo, ["rev-parse", wt.base], env));
}

/**
 * 임시 인덱스(GIT_INDEX_FILE)에 HEAD + 작업 트리 전부(add -A, 새 파일 포함)를 올리고 fn 을 돌린다.
 * 실제 인덱스는 건드리지 않는다 — 세션이 일부만 스테이징해 둔 상태를 잃지 않게.
 */
async function withStagedSnapshot<T>(env: NodeJS.ProcessEnv, wt: WorktreeMeta, fn: (env2: NodeJS.ProcessEnv) => Promise<T>): Promise<T | { ok: false; error: string }> {
  const tmp = join(tmpdir(), `sudal-index-${process.pid}-${randomUUID()}`);
  const env2 = { ...env, GIT_INDEX_FILE: tmp };
  try {
    const rt = await run(wt.path, ["read-tree", "HEAD"], env2);
    if (rt.code !== 0) return { ok: false, error: rt.stderr.trim() || mt("repo.worktree.baseCommitReadFailed") };
    const add = await run(wt.path, ["add", "-A"], env2);
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || mt("repo.worktree.tempIndexFailed") };
    return await fn(env2);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface WorktreeSnapshot {
  ok: true;
  base: string;
  /** base 이후의 모든 변경(커밋 + 작업 트리 + 새 파일), 경로별 +/- 줄 수. */
  changes: GitChangeDto[];
  /** 경로별 unified diff(요청했을 때만). */
  diffs: Record<string, string>;
}

/**
 * 세션의 변경 전체를 base(merge-base) 기준으로 본다 — 카드 통계·비교 화면·채택 패치가 모두 이 한 기준을 쓴다.
 * (HEAD 기준 작업 트리만 보면 세션이 커밋해 버린 변경이 빠진다.)
 */
export async function worktreeSnapshot(env: NodeJS.ProcessEnv, wt: WorktreeMeta, opts: { diffs?: boolean; maxDiffFiles?: number } = {}): Promise<WorktreeSnapshot | { ok: false; error: string }> {
  if (!fs.existsSync(wt.path)) return { ok: false, error: mt("repo.worktree.notFound") };
  const base = await worktreeBase(env, wt);
  if (!base) return { ok: false, error: mt("repo.worktree.compareBaseMissing", { base: wt.base }) };
  return withStagedSnapshot(env, wt, async (env2) => {
    const ns = await run(wt.path, ["diff", "--cached", "--numstat", "-z", "-M", base], env2);
    if (ns.code !== 0) return { ok: false as const, error: ns.stderr.trim() || mt("repo.worktree.diffReadFailed") };
    const st = await run(wt.path, ["diff", "--cached", "--name-status", "-z", "-M", base], env2);
    const kinds = new Map<string, { kind: GitChangeDto["kind"]; oldPath?: string }>();
    const sf = st.stdout.split("\0");
    for (let i = 0; i < sf.length; i++) {
      const code = sf[i];
      if (!code) continue;
      if (/^[RC]/.test(code)) {
        const oldPath = sf[i + 1] ?? "";
        const path = sf[i + 2] ?? "";
        kinds.set(path, { kind: "renamed", oldPath });
        i += 2;
      } else {
        const path = sf[i + 1] ?? "";
        kinds.set(path, { kind: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
        i += 1;
      }
    }
    const changes: GitChangeDto[] = [];
    const nf = ns.stdout.split("\0");
    for (let i = 0; i < nf.length; i++) {
      const m = nf[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      let path = m[3];
      if (path === "") {
        // 이름 변경: 뒤에 old, new 가 별도 필드
        path = nf[i + 2] ?? "";
        i += 2;
      }
      const k = kinds.get(path) ?? { kind: "modified" as const };
      changes.push({ path, kind: k.kind, ...(k.oldPath ? { oldPath: k.oldPath } : {}), added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const diffs: Record<string, string> = {};
    if (opts.diffs) {
      for (const c of changes.slice(0, opts.maxDiffFiles ?? 60)) {
        const d = await run(wt.path, ["diff", "--cached", "--no-color", "-M", base, "--", `:(literal)${c.path}`, ...(c.oldPath ? [`:(literal)${c.oldPath}`] : [])], env2);
        diffs[c.path] = d.stdout.length > 40_000 ? `${d.stdout.slice(0, 40_000)}\n${mt("repo.worktree.diffTruncated")}` : d.stdout;
      }
    }
    return { ok: true as const, base, changes, diffs };
  });
}

/** worktree 의 모든 변경(커밋한 것 + 작업 트리 + 새 파일)을 base 기준 패치 하나로(팬아웃 채택용). 실제 인덱스는 보존된다. */
export async function worktreePatch(env: NodeJS.ProcessEnv, wt: WorktreeMeta): Promise<{ ok: true; patch: string; base: string } | { ok: false; error: string }> {
  if (!fs.existsSync(wt.path)) return { ok: false, error: mt("repo.worktree.notFound") };
  const base = await worktreeBase(env, wt);
  if (!base) return { ok: false, error: mt("repo.worktree.compareBaseMissing", { base: wt.base }) };
  return withStagedSnapshot(env, wt, async (env2) => {
    const d = await run(wt.path, ["diff", "--cached", "--binary", "--no-color", base], env2);
    if (d.code !== 0) return { ok: false as const, error: d.stderr.trim() || mt("repo.worktree.diffReadFailed") };
    return { ok: true as const, patch: d.stdout, base };
  });
}

/** 패치를 저장소 작업 트리에 적용한다(인덱스는 건드리지 않음). 먼저 --check 로 깨끗이 들어가는지 본다. */
export async function applyPatch(env: NodeJS.ProcessEnv, cwd: string, patch: string): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  if (!patch.trim()) return { ok: true, files: [] };
  const top = ok(await run(cwd, ["rev-parse", "--show-toplevel"], env));
  if (!top) return { ok: false, error: mt("repo.worktree.notGitRepo") };
  const check = await runInput(top, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], env, patch);
  if (check.code !== 0) return { ok: false, error: mt("repo.worktree.patchCheckFailed", { detail: check.stderr.trim().split("\n").slice(0, 3).join(" ") }) };
  const stat = await runInput(top, ["apply", "--numstat", "--binary", "-"], env, patch);
  const files = stat.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[2]).filter((f): f is string => !!f);
  const a = await runInput(top, ["apply", "--binary", "--whitespace=nowarn", "-"], env, patch);
  if (a.code !== 0) return { ok: false, error: a.stderr.trim() || mt("repo.worktree.patchApplyFailed") };
  return { ok: true, files };
}
