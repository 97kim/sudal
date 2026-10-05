// 코드 뷰어용 파일 읽기 — 현재 내용과 HEAD 버전을 함께 돌려준다. git 이 없으면 HEAD 는 null.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isInsideRel, isWithin } from "./path-within";
import type { DirEntryDto, FileViewDto } from "@shared/ipc";
import { mt } from "./i18n";

/** 이 크기를 넘으면 내용을 보내지 않는다 (렌더러 하이라이트 비용·IPC 페이로드 제한). */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 이미지 미리보기 상한. data URL 로 IPC 를 타므로 너무 크면 렌더러가 버벅인다. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** 확장자로 본 이미지 MIME. 이미지가 아니면 null. */
export function imageMimeOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? null;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Buffer | null> {
  return new Promise((r) => {
    execFile(
      "git",
      args,
      { cwd, env, timeout: 5000, maxBuffer: MAX_FILE_BYTES * 2, encoding: "buffer" },
      (err, stdout) => r(err ? null : stdout),
    );
  });
}

/** 앞 8KB 에 NUL 이 있으면 바이너리로 본다 (git 과 같은 휴리스틱). */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 존재하지 않는 경로도 실제 경로로: 가장 가까운 존재하는 상위 디렉토리를 realpath 로 풀고 나머지를 붙인다. */
async function realishDeep(p: string): Promise<string> {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      missing.push(basename(cur));
      cur = parent;
    }
  }
}

/** 심링크를 푼 절대 경로. 파일이 없으면(삭제된 파일) 부모 디렉토리만 푼다 — git 루트는 realpath 로 오므로 맞춰야 상대 경로가 나온다. */
async function realish(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    try {
      return join(await fs.realpath(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/** 세션 cwd 의 저장소 최상위(실제 경로). git 저장소가 아니면 cwd 의 실제 경로. 파일 조작·언어 서버의 경계가 된다. */
export async function repoRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], env))?.toString().trim() || null;
  return realish(root ?? cwd);
}

export async function readFileView(cwd: string, requested: string, env: NodeJS.ProcessEnv): Promise<FileViewDto> {
  const path = await realish(isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested));
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], env))?.toString().trim() || null;
  const base = root ?? (await realish(cwd));
  const relPath = relative(base, path) || path;

  const out: FileViewDto = {
    path,
    relPath,
    content: null,
    headContent: null,
    size: 0,
    missing: false,
    binary: false,
    tooLarge: false,
    mtimeMs: null,
  };

  try {
    const stat = await fs.stat(path);
    out.size = stat.size;
    out.mtimeMs = stat.mtimeMs;
    const imageMime = imageMimeOf(path);
    if (imageMime) {
      // 이미지는 텍스트로 열지 않고 미리보기 data URL 만 준다(SVG 도 <img> 로만 그리므로 스크립트가 돌지 않는다).
      out.binary = true;
      if (stat.size > MAX_IMAGE_BYTES) out.tooLarge = true;
      else out.image = { mime: imageMime, dataUrl: `data:${imageMime};base64,${(await fs.readFile(path)).toString("base64")}` };
    } else if (stat.size > MAX_FILE_BYTES) {
      out.tooLarge = true;
    } else {
      const buf = await fs.readFile(path);
      if (looksBinary(buf)) out.binary = true;
      else out.content = buf.toString("utf8");
    }
  } catch {
    out.missing = true;
  }

  // HEAD 버전: 레포 안의 경로만. 추적 안 하는 새 파일이면 git show 가 실패해 null. 이미지는 diff 를 안 보여 주므로 생략.
  if (root && !out.image && !imageMimeOf(path) && isInsideRel(relPath)) {
    const head = await git(root, ["show", `HEAD:${relPath.split("\\").join("/")}`], env);
    if (head && head.length <= MAX_FILE_BYTES && !looksBinary(head)) out.headContent = head.toString("utf8");
  }
  return out;
}

/** 파일 탐색기용 디렉토리 목록. 폴더 먼저, 대소문자 무시 이름순. .git 은 뺀다. 심링크는 대상 종류로. */
export async function listDirectory(dir: string): Promise<DirEntryDto[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const out: DirEntryDto[] = [];
  for (const d of dirents) {
    if (d.name === ".git") continue;
    const path = join(dir, d.name);
    let isDir = d.isDirectory();
    let size = 0;
    try {
      const st = await fs.stat(path); // 심링크는 대상 기준
      isDir = st.isDirectory();
      size = st.size;
    } catch {
      if (d.isSymbolicLink()) continue; // 깨진 링크
    }
    out.push({ name: d.name, path, kind: isDir ? "dir" : "file", size });
  }
  return out.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, "en", { sensitivity: "base" })));
}

/**
 * 에디터 저장. 디스크의 mtime 이 읽었을 때와 다르면(에이전트가 그 사이 고쳤을 수 있다) force 없이는 conflict 로 거부한다.
 * 파일이 없던 경우(삭제된 파일 복원, 새 파일)는 expectedMtimeMs null 로 온다.
 */
export async function writeFileView(
  cwd: string,
  requested: string,
  content: string,
  opts: { expectedMtimeMs: number | null; expectedSize?: number | null; force?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; mtimeMs: number } | { ok: false; error: string; conflict?: boolean }> {
  const path = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  // 쓰기는 세션의 저장소(없으면 cwd) 안으로만. 심링크를 푼 실제 경로로 비교한다.
  const base = await repoRoot(cwd, env);
  const realTarget = await realishDeep(path);
  if (!isWithin(base, realTarget))
    return { ok: false, error: mt("repo.files.outsideRepo", { base }) };
  if (!opts.force) {
    let current: { mtimeMs: number; size: number } | null = null;
    try {
      const st = await fs.stat(path);
      current = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      current = null;
    }
    const expected = opts.expectedMtimeMs;
    if (current !== null && expected !== null && Math.abs(current.mtimeMs - expected) > 1)
      return { ok: false, conflict: true, error: mt("repo.files.changedOutside") };
    // 같은 밀리초 안에 바뀐 경우(mtime 이 같음)는 크기로 한 번 더 걸러 낸다
    if (current !== null && typeof opts.expectedSize === "number" && current.size !== opts.expectedSize)
      return { ok: false, conflict: true, error: mt("repo.files.changedOutside") };
    if (current !== null && expected === null)
      return { ok: false, conflict: true, error: mt("repo.files.createdMeanwhile") };
  }
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, "utf8");
    return { ok: true, mtimeMs: (await fs.stat(path)).mtimeMs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type FileOpResult = { ok: true; path: string } | { ok: false; error: string };

function outside(base: string, p: string): boolean {
  return !isWithin(base, p);
}

/**
 * 세션 저장소(없으면 cwd) 안인지 확인한다. 밖이면 null.
 * `path` 는 조작에 쓸 경로 — 상위 디렉토리만 realpath 로 풀고 마지막 이름은 그대로 둔다. 그래야 항목이 심링크일 때
 * 링크 자체를 옮기거나 지우지, 링크가 가리키는 원본을 건드리지 않는다. 판정도 이 경로로 한다: 저장소 안의 링크는 어디를
 * 가리키든 이름을 바꾸거나 휴지통에 보낼 수 있다(원본은 그대로). `real` 은 끝까지 푼 경로(저장소 루트 자체인지 볼 때 쓴다).
 */
async function insideBase(
  cwd: string,
  requested: string,
  env: NodeJS.ProcessEnv,
): Promise<{ base: string; path: string; real: string } | null> {
  const target = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const base = await repoRoot(cwd, env);
  const path = join(await realishDeep(dirname(target)), basename(target));
  const real = await realishDeep(target);
  if (outside(base, path)) return null;
  return { base, path, real };
}

/** 같은 파일(같은 inode)인지 — 대소문자를 무시하는 볼륨에서 이름의 대소문자만 바꾸는 경우를 가려낸다. */
async function sameInode(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

const BAD_NAME = /[\\/:\0]|^\.\.?$/;

/** 새 파일(빈 내용) 또는 폴더. 이미 있으면 거부. */
export async function createPath(
  cwd: string,
  requested: string,
  kind: "file" | "dir",
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileOpResult> {
  if (BAD_NAME.test(basename(requested))) return { ok: false, error: mt("repo.files.badName") };
  const t = await insideBase(cwd, requested, env);
  if (!t) return { ok: false, error: mt("repo.files.cannotCreateOutside") };
  try {
    await fs.access(t.path);
    return { ok: false, error: mt("repo.files.nameExists") };
  } catch {
    /* 없어야 정상 */
  }
  try {
    if (kind === "dir") await fs.mkdir(t.path, { recursive: true });
    else {
      await fs.mkdir(dirname(t.path), { recursive: true });
      await fs.writeFile(t.path, "", { flag: "wx" });
    }
    return { ok: true, path: t.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 이름 변경/이동. 대상이 이미 있으면 거부(덮어쓰기 없음). */
export async function renamePath(
  cwd: string,
  from: string,
  to: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileOpResult> {
  if (BAD_NAME.test(basename(to))) return { ok: false, error: mt("repo.files.badName") };
  const a = await insideBase(cwd, from, env);
  const b = await insideBase(cwd, to, env);
  if (!a || !b) return { ok: false, error: mt("repo.files.cannotMoveOutside") };
  if (a.path === b.path) return { ok: true, path: b.path };
  try {
    await fs.lstat(b.path);
    // 대소문자만 다른 이름은 대소문자 무시 볼륨(APFS 기본)에서 같은 파일로 보인다 — inode 가 같을 때만 허용.
    // 대소문자 구분 볼륨에서는 다른 파일이므로 덮어쓰지 않는다.
    if (!(await sameInode(a.path, b.path))) return { ok: false, error: mt("repo.files.nameExists") };
  } catch {
    /* 없어야 정상 */
  }
  try {
    await fs.mkdir(dirname(b.path), { recursive: true });
    await fs.rename(a.path, b.path);
    return { ok: true, path: b.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 삭제 대상 검증만 한다 — 실제 삭제는 main 이 shell.trashItem 으로 휴지통에 보낸다(되돌릴 수 있게). */
export async function resolveDeletable(cwd: string, requested: string, env: NodeJS.ProcessEnv = process.env): Promise<FileOpResult> {
  const t = await insideBase(cwd, requested, env);
  if (!t) return { ok: false, error: mt("repo.files.cannotDeleteOutside") };
  if (t.path === t.base || t.real === t.base) return { ok: false, error: mt("repo.files.cannotDeleteRoot") };
  try {
    await fs.lstat(t.path);
  } catch {
    return { ok: false, error: mt("repo.files.pathGone") };
  }
  return { ok: true, path: t.path };
}

// ===== 답변 속 파일 참조 → 실제 경로 (file:locate) =====

/** 걷기 상한. git 이 없는 디렉토리에서만 쓰며, 큰 트리를 통째로 훑지 않게 한다. */
const LOCATE_MAX_FILES = 30_000;
const LOCATE_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".venv", "venv", "__pycache__", "coverage", ".gradle", ".idea", ".turbo", ".cache", "release"]);
const LOCATE_CACHE_MS = 10_000;
const LOCATE_MAX_RESULTS = 20;
const listCache = new Map<string, { at: number; files: Promise<string[]> }>();

/** 루트 아래 파일 목록(루트 기준 상대 경로, / 구분). git 이면 추적+미추적(ignore 제외), 아니면 상한 안에서 걷는다. 10초 캐시. */
function listRepoFiles(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const hit = listCache.get(root);
  if (hit && Date.now() - hit.at < LOCATE_CACHE_MS) return hit.files;
  const files = (async () => {
    const out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], env);
    if (out) return out.toString("utf8").split("\0").filter(Boolean);
    const acc: string[] = [];
    const walk = async (dir: string, rel: string, depth: number) => {
      if (depth > 12 || acc.length >= LOCATE_MAX_FILES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (acc.length >= LOCATE_MAX_FILES) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!LOCATE_SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), r, depth + 1);
        } else if (e.isFile()) acc.push(r);
      }
    };
    await walk(root, "", 0);
    return acc;
  })();
  listCache.set(root, { at: Date.now(), files });
  return files;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 답변에 적힌 경로("Foo.kt", "src/a/b.ts", "/abs/x.yml", "../y.py")에 맞는 실제 파일들(절대 경로). 못 찾으면 [].
 * 순서: 절대 경로·cwd 기준 상대 경로가 그대로 있으면 그것 하나 → 저장소 파일 목록에서 뒤쪽 경로가 일치하는 것(긴 꼬리부터,
 * 대소문자 그대로 → 무시). 여러 개면 루트에 가까운 것부터 최대 20개.
 */
export async function locateFiles(cwd: string, requested: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let raw = requested.trim().split("\\").join("/");
  if (raw.startsWith("~/")) raw = join(homedir(), raw.slice(2));
  if (!raw || raw.includes("\0")) return [];
  if (isAbsolute(raw)) {
    const p = resolve(raw);
    if (await isFile(p)) return [await realish(p)];
  } else {
    const p = resolve(cwd, raw);
    if (await isFile(p)) return [await realish(p)];
  }
  // 꼬리 후보: "a/b/c.ts" → ["a/b/c.ts", "b/c.ts", "c.ts"] (./ ../ 는 뗀다)
  const segs = raw.replace(/^(\.\.?\/)+/, "").replace(/^\/+/, "").split("/").filter((s) => s && s !== "." && s !== "..");
  if (segs.length === 0) return [];
  const root = await repoRoot(cwd, env);
  const files = await listRepoFiles(root, env);
  const pick = (tail: string, fold: boolean) => {
    const t = fold ? tail.toLowerCase() : tail;
    return files.filter((f) => {
      const g = fold ? f.toLowerCase() : f;
      return g === t || g.endsWith("/" + t);
    });
  };
  for (const fold of [false, true]) {
    for (let i = 0; i < segs.length; i++) {
      const tail = segs.slice(i).join("/");
      const found = pick(tail, fold);
      if (found.length > 0) {
        found.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
        return found.slice(0, LOCATE_MAX_RESULTS).map((f) => join(root, f));
      }
    }
  }
  return [];
}
