// 에디터의 HTML 을 인앱 브라우저(<webview>, http(s) 만 허용)에서 보기 위한 로컬 정적 서버.
// 127.0.0.1 의 임의 포트에 한 번만 뜨고, URL 은 http://127.0.0.1:<port>/p/<token>/<루트 기준 상대 경로>.
// token 은 루트(저장소 최상위)마다 따로 무작위로 뽑는다 — 미리보기는 모두 같은 origin 이라, 토큰이 하나뿐이거나 경로에서
// 계산되면 한 저장소의 HTML 이 다른 저장소의 파일을 읽어 갈 수 있다. 점으로 시작하는 경로(.env·.git 등)는 주지 않는다.
// 상대 경로의 css·js·이미지가 그대로 붙게 파일이 있는 트리째 서비스한다. 캐시는 끈다(저장 → 새로고침이 바로 보이게).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { constants, createReadStream, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { isInsideRel, isWithin } from "./path-within";
import type { AddressInfo } from "node:net";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
};

/** 점으로 시작하는 조각(.env·.git·.ssh 등)이 있는 경로. 비밀이 들어 있기 쉬워 미리보기로 주지 않는다. */
function hasHiddenSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith("."));
}

type FileIdentity = Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">;
type PreviewScope = { root: string } | { file: string; identity: FileIdentity };
type DirectoryStamp = { path: string; stat: BigIntStats };
const VISUALIZATION_GRANT_ATTEMPTS = 3;

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

async function directoryChain(directory: string): Promise<DirectoryStamp[] | null> {
  const paths: string[] = [];
  for (let path = directory; ; path = dirname(path)) {
    paths.push(path);
    if (dirname(path) === path) break;
  }
  const chain = await Promise.all(paths.map(async path => ({ path, stat: await fs.lstat(path, { bigint: true }) })));
  if (chain.some(({ stat }) => !stat.isDirectory() || stat.ino === 0n)) return null;
  return chain;
}

async function checkDirectoryChain(chain: DirectoryStamp[], root: string): Promise<"stable" | "retry" | "invalid"> {
  const current = await Promise.all(chain.map(({ path }) => fs.lstat(path, { bigint: true })));
  let retry = false;
  for (const [index, { path, stat }] of chain.entries()) {
    const next = current[index];
    if (!next.isDirectory() || !sameFile(next, stat)) return "invalid";
    if (next.ctimeNs === stat.ctimeNs) continue;
    if (isWithin(root, path)) return "invalid";
    retry = true;
  }
  return retry ? "retry" : "stable";
}

async function openVisualization(file: string, expected: FileIdentity): Promise<{ handle: FileHandle; stat: BigIntStats } | null> {
  let handle: FileHandle | undefined;
  try {
    // NOFOLLOW guards the leaf where supported. NONBLOCK avoids waiting on a
    // FIFO if the path changes before open. The identity check covers both.
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFile(stat, expected)) return null;
    if (relative(file, await fs.realpath(file))) return null;
    if (!sameFile(stat, await fs.lstat(file, { bigint: true }))) return null;
    const opened = { handle, stat };
    handle = undefined; // The caller owns the verified handle.
    return opened;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class PreviewServer {
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private port = 0;
  /** token → 제공할 실제 루트 또는 단일 파일 */
  private readonly scopes = new Map<string, PreviewScope>();
  /** 루트 또는 단일 파일 → token. 같은 루트는 같은 토큰이라 상대 경로 자원이 이어진다. */
  private readonly tokens = new Map<string, string>();

  /** 서버를 (아직이면) 띄우고 포트를 돌려준다. */
  start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((res, rej) => {
      const server = createServer((req, r) => void this.handle(req, r));
      server.on("error", rej);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        res(this.port);
      });
    });
    return this.starting;
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
    this.starting = null;
  }

  /**
   * 루트(실제 경로) 아래의 파일을 가리키는 미리보기 URL. 루트 밖이면 null.
   * 루트는 저장소 최상위를 넘기면 된다 — 그 안의 어떤 파일이든 상대 경로 자원이 같은 루트에서 풀린다.
   */
  async urlFor(root: string, filePath: string): Promise<string | null> {
    const realRoot = await fs.realpath(root);
    let realFile: string;
    try {
      realFile = await fs.realpath(filePath);
    } catch {
      return null;
    }
    return this.directoryUrl(realRoot, realFile);
  }

  private directoryUrl(realRoot: string, realFile: string): Promise<string> | null {
    const rel = relative(realRoot, realFile);
    if (!rel || !isInsideRel(rel) || hasHiddenSegment(rel)) return null;
    return this.scopedUrl(realRoot, { root: realRoot }, rel);
  }

  private async scopedUrl(key: string, scope: PreviewScope, rel: string): Promise<string> {
    const port = await this.start();
    let token = this.tokens.get(key);
    if (!token) {
      token = randomBytes(16).toString("hex");
      this.tokens.set(key, token);
      this.scopes.set(token, scope);
    }
    const relUrl = rel.split(sep).map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${port}/p/${token}/${relUrl}`;
  }

  async urlForArtifact(root: string, filePath: string, codexHome: string): Promise<string | null> {
    // Classify and serve the same resolved file, even if its original alias
    // changes before a preview URL is issued.
    const file = await fs.realpath(filePath).catch(() => null);
    if (!file) return null;
    const configuredRoot = join(codexHome, "visualizations");
    const home = await fs.realpath(codexHome).catch(() => null);
    const expectedRoot = home ? join(home, "visualizations") : null;
    const visualization = isWithin(configuredRoot, filePath) ||
      (expectedRoot !== null && (isWithin(expectedRoot, filePath) || isWithin(expectedRoot, file)));
    if (visualization) return expectedRoot ? this.codexVisualizationUrlFor(expectedRoot, file) : null;

    const project = await fs.realpath(root);
    return await this.directoryUrl(project, file) ?? await this.projectArtifactUrlFor(project, file);
  }

  private async codexVisualizationUrlFor(expectedRoot: string, file: string): Promise<string | null> {
    try {
      const rel = relative(expectedRoot, file);
      if (!rel || !isInsideRel(rel) || hasHiddenSegment(rel) || !/\.html?$/i.test(file)) return null;
      // Snapshot the canonical directory chain before selecting an identity.
      // Recheck it after opening so a namespace change cannot authorize a
      // different file through the same path.
      let expected: BigIntStats | undefined;
      for (let attempt = 0; attempt < VISUALIZATION_GRANT_ATTEMPTS; attempt++) {
        const chain = await directoryChain(dirname(file));
        if (!chain) return null;
        expected ??= await fs.lstat(file, { bigint: true });
        if (!expected.isFile()) return null;
        const opened = await openVisualization(file, expected);
        if (!opened) return null;
        let result: "stable" | "retry" | "invalid";
        try {
          result = await checkDirectoryChain(chain, expectedRoot);
        } finally {
          await opened.handle.close();
        }
        if (result === "invalid") return null;
        // Unrelated work can change a shared ancestor, such as the temp root.
        // Recheck with the original file identity instead of accepting the change.
        if (result === "retry") continue;
        const { dev, ino, birthtimeNs } = expected;
        const key = `file\0${file}\0${dev}:${ino}:${birthtimeNs}`;
        return this.scopedUrl(key, { file, identity: { dev, ino, birthtimeNs } }, basename(file));
      }
      return null;
    } catch { return null; }
  }

  /** Explicit preview controls can serve artifacts, scoped to .sudal/previews rather than the hidden project tree. */
  private async projectArtifactUrlFor(project: string, file: string): Promise<string | null> {
    try {
      const directory = await fs.realpath(join(project, ".sudal", "previews"));
      if (relative(project, directory).split(sep).join("/") !== ".sudal/previews") return null;
      if (!isWithin(directory, file) || !/\.html?$/i.test(file) || !(await fs.stat(file)).isFile()) return null;
      return this.directoryUrl(directory, file);
    } catch { return null; }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deny = (code: number, msg: string) => {
      res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(msg);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return deny(405, "method not allowed");
    // 브라우저 밖(다른 origin 페이지의 fetch 등)에서 못 읽게: 우리 서버의 페이지가 낸 요청이거나 주소창 직접 이동만.
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${this.port}`) return deny(403, "forbidden");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    } catch {
      return deny(400, "bad request");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "p") return deny(404, "not found");
    const scope = this.scopes.get(parts[1]);
    if (!scope) return deny(404, "not found");
    let rel: string;
    try {
      rel = parts.slice(2).map(decodeURIComponent).join("/");
    } catch {
      return deny(400, "bad request");
    }
    if (rel.includes("\0")) return deny(400, "bad request");
    if ("file" in scope) {
      if (rel !== basename(scope.file)) return deny(404, "not found");
      const opened = await openVisualization(scope.file, scope.identity);
      if (!opened) return deny(404, "not found");
      try {
        if (res.destroyed) return;
        this.writeFileHeaders(res, scope.file, opened.stat.size.toString(), true);
        if (req.method === "HEAD") res.end();
        else await pipeline(opened.handle.createReadStream(), res);
      } catch {
        res.destroy();
      } finally {
        await opened.handle.close().catch(() => {});
      }
      return;
    }
    const { root } = scope;
    let target = resolve(root, rel);
    // 심링크를 풀어도 루트 안이어야 한다
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch {
      return deny(404, "not found");
    }
    if (!isWithin(root, real) || hasHiddenSegment(relative(root, real))) return deny(404, "not found");
    let st = await fs.stat(real);
    if (st.isDirectory()) {
      target = join(real, "index.html");
      try {
        real = await fs.realpath(target);
        st = await fs.stat(real);
      } catch {
        return deny(404, "not found");
      }
      if (!isWithin(root, real) || hasHiddenSegment(relative(root, real)) || !st.isFile()) return deny(404, "not found");
    }
    if (!st.isFile()) return deny(404, "not found");
    this.sendFile(req, res, real, st.size);
  }

  private writeFileHeaders(res: ServerResponse, file: string, size: number | string, standalone = false): void {
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(standalone ? { "Content-Security-Policy": "sandbox allow-scripts", "Referrer-Policy": "no-referrer" } : {}),
    });
  }

  private sendFile(req: IncomingMessage, res: ServerResponse, file: string, size: number): void {
    this.writeFileHeaders(res, file, size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}
