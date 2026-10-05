// 에디터의 HTML 을 인앱 브라우저(<webview>, http(s) 만 허용)에서 보기 위한 로컬 정적 서버.
// 127.0.0.1 의 임의 포트에 한 번만 뜨고, URL 은 http://127.0.0.1:<port>/p/<token>/<rootId>/<루트 기준 상대 경로>.
// token 은 앱마다 새로 뽑아 다른 프로세스가 주소를 추측할 수 없게 하고, rootId 로 등록된 루트(저장소 최상위) 안의 파일만 준다.
// 상대 경로의 css·js·이미지가 그대로 붙게 파일이 있는 트리째 서비스한다. 캐시는 끈다(저장 → 새로고침이 바로 보이게).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
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

export class PreviewServer {
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private port = 0;
  private readonly token = randomBytes(16).toString("hex");
  /** rootId → 루트의 실제 경로(realpath) */
  private readonly roots = new Map<string, string>();

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
    const rel = relative(realRoot, realFile);
    if (!rel || !isInsideRel(rel)) return null;
    const port = await this.start();
    const rootId = createHash("sha1").update(realRoot).digest("hex").slice(0, 12);
    this.roots.set(rootId, realRoot);
    const relUrl = rel.split(sep).map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${port}/p/${this.token}/${rootId}/${relUrl}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deny = (code: number, msg: string) => {
      res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(msg);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return deny(405, "method not allowed");
    // 브라우저 밖(다른 origin 페이지의 fetch 등)에서 못 읽게: 우리 서버의 페이지가 낸 요청이거나 주소창 직접 이동만.
    const origin = req.headers.origin;
    if (origin && !origin.startsWith(`http://127.0.0.1:${this.port}`)) return deny(403, "forbidden");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    } catch {
      return deny(400, "bad request");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[0] !== "p" || parts[1] !== this.token) return deny(404, "not found");
    const root = this.roots.get(parts[2]);
    if (!root) return deny(404, "not found");
    let rel: string;
    try {
      rel = parts.slice(3).map(decodeURIComponent).join("/");
    } catch {
      return deny(400, "bad request");
    }
    if (rel.includes("\0")) return deny(400, "bad request");
    let target = resolve(root, rel);
    // 심링크를 풀어도 루트 안이어야 한다
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch {
      return deny(404, "not found");
    }
    if (!isWithin(root, real)) return deny(404, "not found");
    let st = await fs.stat(real);
    if (st.isDirectory()) {
      target = join(real, "index.html");
      try {
        real = await fs.realpath(target);
        st = await fs.stat(real);
      } catch {
        return deny(404, "not found");
      }
      if (!isWithin(root, real) || !st.isFile()) return deny(404, "not found");
    }
    if (!st.isFile()) return deny(404, "not found");
    const type = MIME[extname(real).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": st.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(real);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}
