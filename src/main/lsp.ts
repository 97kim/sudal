// 언어 서버 프로세스 관리. (서버 종류, 저장소 루트) 쌍마다 하나. 렌더러의 CodeMirror LSP 클라이언트가
// JSON-RPC 본문(문자열)을 IPC 로 보내면 여기서 Content-Length 프레임을 씌워 stdin 에 쓰고, stdout 을 프레임 단위로 잘라 돌려준다.
// 서버 종류(TypeScript, Python …)는 shared/lsp-servers.ts 의 명세를 따른다.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { mt } from "./i18n";
import { cmdQuote, killProcessTree, needsCmdShell } from "./win-proc";
import { LSP_SERVERS, lspServerSpec, type LspServerId, type LspServerSpec } from "@shared/lsp-servers";

export interface LspServerStatus {
  serverId: LspServerId;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** TypeScript 서버만: 전역/서버 동봉 typescript 를 찾았으면 그 lib 경로(프로젝트별 node_modules 는 실행 시점에 다시 찾는다). */
  typescriptLib: string | null;
  /** 사용자가 설정에서 지정한 경로(없으면 null). */
  override: string | null;
  running: string[];
  hint: string;
}

export interface LspManagerDeps {
  env(): Promise<NodeJS.ProcessEnv>;
  /** 탭 cwd → 서버 루트(저장소 최상위, 없으면 cwd 의 실제 경로). 렌더러가 루트를 정하지 않게 main 이 푼다. */
  resolveRoot(cwd: string): Promise<string>;
  loadOverride(serverId: LspServerId): string | null;
  saveOverride(serverId: LspServerId, path: string | null): void;
  onMessage(id: string, message: string): void;
  onExit(id: string, code: number | null): void;
  log?(line: string): void;
  /** 열린 문서가 하나도 없는 상태가 이만큼 이어지면 서버를 끈다(기본 3분). 테스트용. */
  idleMs?: number;
}

export const LSP_IDLE_MS = 3 * 60 * 1000;

interface Server {
  id: string;
  spec: LspServerSpec;
  root: string;
  proc: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  /** initialize 요청에 끼워 넣을 typescript/lib 경로(TypeScript 서버만, 없으면 서버가 스스로 찾게 둔다). */
  tsLib: string | null;
  /** didOpen 으로 열려 didClose 가 아직 안 온 문서 URI. 비어 있는 채로 idleMs 가 지나면 서버를 끈다. */
  openDocs: Set<string>;
  idleTimer: NodeJS.Timeout | null;
}

/** didOpen/didClose 알림이면 문서 URI 와 방향을 돌려준다. 다른 메시지는 null. 파싱은 두 메서드 이름이 보일 때만 한다. */
export function documentLifecycle(message: string): { uri: string; open: boolean } | null {
  const isOpen = message.includes('"textDocument/didOpen"');
  if (!isOpen && !message.includes('"textDocument/didClose"')) return null;
  try {
    const m = JSON.parse(message) as { method?: string; params?: { textDocument?: { uri?: string } } };
    const uri = m.params?.textDocument?.uri;
    if (typeof uri !== "string") return null;
    if (m.method === "textDocument/didOpen") return { uri, open: true };
    if (m.method === "textDocument/didClose") return { uri, open: false };
    return null;
  } catch {
    return null;
  }
}

/**
 * typescript-language-server 는 typescript 패키지를 따로 찾아야 한다: 서버 자신의 node_modules → PATH 의 tsserver(전역 설치) →
 * 프로젝트 node_modules 순으로 `typescript/lib` 를 찾는다. 못 찾으면 null(서버가 "valid TypeScript installation" 오류를 낸다).
 * 프로젝트 것은 저장소가 심어 둔 코드(tsserver.js)를 그대로 실행하는 셈이라 맨 뒤에 둔다 — VS Code 도 기본은 동봉 버전이다.
 */
export function resolveTypescriptLib(root: string, serverBin: string, env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = [];
  try {
    let dir = dirname(fs.realpathSync(serverBin));
    for (let i = 0; i < 6; i++) {
      candidates.push(join(dir, "node_modules", "typescript", "lib"), join(dir, "typescript", "lib"));
      dir = dirname(dir);
    }
  } catch {
    /* 서버 경로를 못 풀면 건너뜀 */
  }
  for (const d of pathDirs(env)) {
    const ts = join(d, "tsserver");
    if (fs.existsSync(ts)) {
      try {
        candidates.push(join(dirname(dirname(fs.realpathSync(ts))), "lib"));
      } catch {
        /* 무시 */
      }
    }
  }
  candidates.push(join(root, "node_modules", "typescript", "lib"));
  return candidates.find((c) => fs.existsSync(join(c, "tsserver.js"))) ?? null;
}

/** PATH 의 절대 경로 항목만 (`.` 이나 `node_modules/.bin` 같은 상대 항목은 main 의 cwd 기준으로 풀리므로 뺀다). */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, "PATH") ?? "").split(delimiter).filter((d) => d && isAbsolute(d));
}

/** Windows 는 env 이름이 대소문자를 가리지 않는다("Path") — 복사한 env 객체에서는 직접 찾아야 한다. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (process.platform !== "win32" || env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key);
  return k ? env[k] : undefined;
}

/** PATH 의 한 폴더에서 볼 파일 이름들. Windows 는 확장자 없이 깔리지 않으니 PATHEXT 의 확장자를 붙여 본다(npm 은 .cmd). */
export function binFileNames(bin: string, platform: NodeJS.Platform, pathext?: string): string[] {
  if (platform !== "win32") return [bin];
  const exts = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return exts.map((e) => bin + e.toLowerCase());
}

/** .cmd 는 cmd.exe 를 거쳐야 뜬다 — 그때는 명령 줄로 합쳐지니 경로를 감싼다. */
function spawnTarget(path: string): { file: string; shell: boolean } {
  return needsCmdShell(path) ? { file: cmdQuote(path), shell: true } : { file: path, shell: false };
}

/** 실행할 수 있는 보통 파일인지. 디렉토리·실행 비트 없는 파일은 spawn 이 실패하거나 엉뚱한 것을 띄운다. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 언어 서버 자식에 주는 env — 로그인 셸 env 전체(API 키 등)가 아니라 실행에 필요한 것만. */
export function lspChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "NODE_PATH", "VIRTUAL_ENV", "PYTHONPATH"]) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  // Windows 는 이것들이 없으면 cmd.exe·node 가 제대로 뜨지 않는다(SystemRoot·PATHEXT·ComSpec 등).
  if (process.platform === "win32") {
    for (const k of ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "windir", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERNAME", "ProgramFiles", "ProgramData"]) {
      const v = envValue(env, k.toUpperCase()) ?? env[k];
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/** initialize 요청이면 initializationOptions.tsserver.path 를 채운다(이미 있으면 그대로). 다른 메시지는 손대지 않는다. */
export function injectTsserverPath(message: string, tsLib: string | null): string {
  if (!tsLib || !message.includes('"initialize"')) return message;
  try {
    const m = JSON.parse(message) as { method?: string; params?: Record<string, unknown> };
    if (m.method !== "initialize" || !m.params) return message;
    const init = (m.params.initializationOptions ?? {}) as Record<string, unknown>;
    const ts = (init.tsserver ?? {}) as Record<string, unknown>;
    if (ts.path) return message;
    m.params.initializationOptions = { ...init, tsserver: { ...ts, path: tsLib } };
    return JSON.stringify(m);
  } catch {
    return message;
  }
}

type StartResult = { ok: true; id: string; root: string } | { ok: false; error: string };

export class LspManager {
  private readonly servers = new Map<string, Server>();
  /** (서버, 루트)별로 띄우는 중인 start — 같은 쌍으로 동시에 들어와도 서버는 하나만 뜬다. */
  private readonly starting = new Map<string, Promise<StartResult>>();
  private readonly versions = new Map<string, Promise<string | null>>();
  private seq = 0;
  /** stopAll 뒤 — 띄우는 중이던 서버도 뜨자마자 끈다. */
  private closing = false;

  constructor(private readonly deps: LspManagerDeps) {}

  /** PATH(로그인 셸 env) 에서 서버 실행 파일을 찾는다. override 가 있으면 그것만 본다. */
  async resolve(serverId: LspServerId): Promise<{ path: string | null; version: string | null; override: string | null }> {
    const spec = lspServerSpec(serverId);
    if (!spec) return { path: null, version: null, override: null };
    const override = this.deps.loadOverride(serverId);
    const env = await this.deps.env();
    let path: string | null = null;
    if (override) {
      path = isExecutableFile(override) ? override : null;
    } else {
      const names = binFileNames(spec.bin, process.platform, envValue(env, "PATHEXT"));
      search: for (const dir of pathDirs(env)) {
        for (const name of names) {
          const p = join(dir, name);
          if (isExecutableFile(p)) {
            path = p;
            break search;
          }
        }
      }
    }
    const version = path ? await this.version(path, env) : null;
    return { path, version, override };
  }

  /** `--version` 은 실행 파일 경로별로 한 번만 돈다(첫 파일 열기 지연을 줄인다). */
  private version(path: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    let p = this.versions.get(path);
    if (!p) {
      p = new Promise((resolve) => {
        const t = spawnTarget(path);
        execFile(t.file, ["--version"], { env, timeout: 5000, shell: t.shell, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.toString().trim() || null));
      });
      this.versions.set(path, p);
      void p.then((v) => v === null && this.versions.delete(path));
    }
    return p;
  }

  async status(): Promise<LspServerStatus[]> {
    const env = await this.deps.env();
    const out: LspServerStatus[] = [];
    for (const spec of LSP_SERVERS) {
      const r = await this.resolve(spec.id);
      out.push({
        serverId: spec.id,
        label: spec.label,
        installed: r.path !== null,
        path: r.path,
        version: r.version,
        typescriptLib: spec.id === "typescript" && r.path ? resolveTypescriptLib("/nonexistent-root", r.path, env) : null,
        override: r.override,
        running: [...this.servers.values()].filter((s) => s.spec.id === spec.id).map((s) => s.root),
        hint: spec.hint,
      });
    }
    return out;
  }

  setOverride(serverId: LspServerId, path: string | null): { ok: true } | { ok: false; error: string } {
    if (!lspServerSpec(serverId)) return { ok: false, error: mt("repo.lsp.unknownServer") };
    const p = path?.trim() || null;
    if (p && !isAbsolute(p)) return { ok: false, error: mt("repo.lsp.needAbsolute") };
    if (p && !isExecutableFile(p)) return { ok: false, error: mt("repo.lsp.notExecutable", { path: p }) };
    this.deps.saveOverride(serverId, p);
    return { ok: true };
  }

  /** 탭 cwd 의 저장소 루트에 서버를 띄운다(이미 있으면 그 id). 루트와 id 를 함께 돌려준다. */
  async start(cwd: string, serverId: LspServerId): Promise<StartResult> {
    const spec = lspServerSpec(serverId);
    if (!spec) return { ok: false, error: mt("repo.lsp.unknownServer") };
    const root = await this.deps.resolveRoot(cwd);
    for (const s of this.servers.values()) if (s.spec.id === spec.id && s.root === root) return { ok: true, id: s.id, root };
    const key = `${spec.id} ${root}`;
    let p = this.starting.get(key);
    if (!p) {
      p = this.startRoot(spec, root).finally(() => this.starting.delete(key));
      this.starting.set(key, p);
    }
    return p;
  }

  private async startRoot(spec: LspServerSpec, root: string): Promise<StartResult> {
    const r = await this.resolve(spec.id);
    if (!r.path) return { ok: false, error: mt("repo.lsp.notFound", { bin: spec.bin, hint: spec.hint }) };
    const env = await this.deps.env();
    const id = `lsp-${++this.seq}`;
    let proc: ChildProcessWithoutNullStreams;
    try {
      const t = spawnTarget(r.path);
      proc = spawn(t.file, spec.args, { cwd: root, env: lspChildEnv(env), stdio: ["pipe", "pipe", "pipe"], shell: t.shell, windowsHide: true });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (this.closing) {
      try {
        proc.kill();
      } catch {
        /* 무시 */
      }
      return { ok: false, error: mt("repo.lsp.closing") };
    }
    const server: Server = {
      id,
      spec,
      root,
      proc,
      buffer: Buffer.alloc(0),
      tsLib: spec.id === "typescript" ? resolveTypescriptLib(root, r.path, env) : null,
      openDocs: new Set(),
      idleTimer: null,
    };
    if (spec.id === "typescript") this.deps.log?.(`[lsp ${id}] typescript/lib: ${server.tsLib ?? "(서버 자체 탐색)"}`);
    this.servers.set(id, server);
    this.armIdle(server); // 문서를 하나도 안 열고 끝나면(예: 클라이언트 초기화 실패) 그대로 두지 않는다
    // spawn 실패(ENOENT·EACCES)는 exit 없이 error 만 온다 — 어느 쪽이든 한 번만 정리하고 렌더러에 알린다.
    let ended = false;
    const end = (code: number | null, why: string) => {
      if (ended) return;
      ended = true;
      if (server.idleTimer) clearTimeout(server.idleTimer);
      this.servers.delete(id);
      this.deps.log?.(`[lsp ${id}] ${why}`);
      this.deps.onExit(id, code);
    };
    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(server, chunk));
    proc.stderr.on("data", (chunk: Buffer) => this.deps.log?.(`[lsp ${id}] ${chunk.toString().trim().slice(0, 300)}`));
    // 서버가 죽은 뒤 stdin 에 쓰면 EPIPE 가 스트림 error 로 온다 — 리스너가 없으면 main 이 죽는다.
    proc.stdin.on("error", (e) => this.deps.log?.(`[lsp ${id}] stdin ${e.message}`));
    proc.on("exit", (code) => end(code, `exit ${code}`));
    proc.on("error", (e) => end(null, `error ${e.message}`));
    this.deps.log?.(`[lsp ${id}] start ${spec.id} ${r.path} cwd=${root}`);
    return { ok: true, id, root };
  }

  send(id: string, rawMessage: string): boolean {
    const s = this.servers.get(id);
    if (!s) return false;
    if (s.proc.stdin.destroyed || !s.proc.stdin.writable) return false;
    const life = documentLifecycle(rawMessage);
    if (life) {
      if (life.open) s.openDocs.add(life.uri);
      else s.openDocs.delete(life.uri);
      this.armIdle(s);
    }
    const message = injectTsserverPath(rawMessage, s.tsLib);
    const body = Buffer.from(message, "utf8");
    if (process.env.SUDAL_DEBUG_LSP) this.deps.log?.(`[lsp ${id}] → ${message.slice(0, 160)}`);
    s.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    s.proc.stdin.write(body);
    return true;
  }

  /** 열린 문서가 없으면 idleMs 뒤에 끄는 타이머를 걸고, 있으면 푼다. */
  private armIdle(s: Server) {
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    if (s.openDocs.size > 0) return;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (this.servers.get(s.id) !== s || s.openDocs.size > 0) return;
      this.deps.log?.(`[lsp ${s.id}] idle ${this.deps.idleMs ?? LSP_IDLE_MS}ms — stop`);
      this.stop(s.id);
    }, this.deps.idleMs ?? LSP_IDLE_MS);
    s.idleTimer.unref?.();
  }

  /** 서버를 끈다. 목록에서는 바로 빼고(상태 표시·재시작이 즉시 반영), onExit 통지는 exit 이벤트가 맡는다. */
  stop(id: string): void {
    const s = this.servers.get(id);
    if (!s) return;
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    this.servers.delete(id);
    // Windows 의 .cmd 서버는 cmd.exe 아래 node 로 뜬다 — cmd.exe 만 끄면 서버가 남으니 트리째.
    if (process.platform === "win32" && s.proc.pid !== undefined) return killProcessTree(s.proc.pid);
    try {
      s.proc.kill();
    } catch {
      /* 이미 죽음 */
    }
  }

  stopAll(): void {
    this.closing = true;
    for (const id of [...this.servers.keys()]) this.stop(id);
    // resolve()/spawn 도중이던 start 는 끝나는 대로 끈다(startRoot 의 closing 검사가 못 잡는 경계까지)
    for (const p of this.starting.values()) void p.then((r) => r.ok && this.stop(r.id));
  }

  /** Content-Length 프레임 파서. 헤더 끝(\r\n\r\n)을 찾고 본문이 다 오면 넘긴다. */
  private onStdout(s: Server, chunk: Buffer) {
    s.buffer = Buffer.concat([s.buffer, chunk]);
    for (;;) {
      const headerEnd = s.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = s.buffer.subarray(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // 깨진 헤더 — 그 줄을 버리고 계속
        s.buffer = s.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (s.buffer.length < start + len) return;
      const body = s.buffer.subarray(start, start + len).toString("utf8");
      s.buffer = s.buffer.subarray(start + len);
      if (process.env.SUDAL_DEBUG_LSP) this.deps.log?.(`[lsp ${s.id}] ← ${body.slice(0, 160)}`);
      this.deps.onMessage(s.id, body);
    }
  }
}

/** 테스트용: 프레임 파서만 따로. */
export function parseLspFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let buf = buffer;
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const m = buf.subarray(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    messages.push(buf.subarray(start, start + len).toString("utf8"));
    buf = buf.subarray(start + len);
  }
  return { messages, rest: buf };
}
