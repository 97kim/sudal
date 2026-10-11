// 휴대폰에서 이어 쓰기(Tailscale)의 웹 서버. Tailscale 이 이 기기의 주소라고 알려 준 곳에만 열고, 들어온 요청도 Tailscale 주소에서 온 것만 받는다.
// 기기는 짝짓기 때 받은 토큰을 Authorization 헤더로 보낸다. 쿠키를 쓰지 않는다 — 쿠키는 포트를 가리지 않아 같은 Mac 의 다른 포트 서버가
// 받아 갈 수 있고, 다른 사이트의 요청에도 저절로 붙는다. 토큰은 휴대폰 브라우저 저장소(출처=스킴·주소·포트별)에 둔다.
// 화면 파일은 비밀이 없어 인증 없이 준다. 화면과 탭 조작은 routes 로 받는다 — 이 파일은 출입 통제와 짝짓기만 안다.

import http from "node:http";
import { isTailscaleAddress, type MobileDevice, type MobilePairing } from "./mobile-access";

const MAX_BODY = 64 * 1024;

export interface MobileRequest {
  method: string;
  path: string;
  body: unknown;
  device: MobileDevice;
  res: http.ServerResponse;
}
/** 처리했으면 true. 짝지은 기기의 /api 요청만 온다. */
export type MobileRoute = (r: MobileRequest) => Promise<boolean> | boolean;
/** 화면 파일(인증 없음). 처리했으면 true. */
export type MobileStatic = (r: { method: string; path: string; res: http.ServerResponse }) => boolean;

export interface MobileServerOptions {
  pairing: MobilePairing;
  routes: MobileRoute;
  statics: MobileStatic;
  onPaired?: (device: MobileDevice) => void;
  log?: (line: string) => void;
  /** 열 주소·받을 주소인지. 기본은 Tailscale 주소 — 테스트만 바꾼다. */
  trusted?: (ip: string) => boolean;
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function bearer(req: http.IncomingMessage): string | undefined {
  const m = /^Bearer\s+([\w-]{20,200})$/.exec(req.headers.authorization ?? "");
  return m?.[1];
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class MobileServer {
  private servers: http.Server[] = [];
  private listening: string[] = [];
  private readonly trusted: (ip: string) => boolean;

  constructor(private readonly opts: MobileServerOptions) {
    this.trusted = opts.trusted ?? isTailscaleAddress;
  }

  /** 지금 열려 있는 주소들("100.x.y.z:port", "[fd7a:…]:port"). Host 헤더도 이 중 하나여야 한다. */
  get addresses(): string[] {
    return [...this.listening];
  }

  /** 주어진 주소들에 연다. 이미 열려 있으면 닫고 다시 연다. 하나도 못 열면 던진다. */
  async start(addresses: string[], port: number): Promise<void> {
    await this.stop();
    const errors: string[] = [];
    for (const host of addresses.filter(this.trusted)) {
      const server = http.createServer((req, res) => void this.handle(req, res));
      // 인증 전에 본문을 천천히 보내며 연결을 붙잡지 못하게 받는 시간을 짧게, 연결 수도 묶는다.
      // requestTimeout 은 요청을 다 받을 때까지만 잰다 — 응답이 길게 이어지는 스트림은 끊지 않는다.
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.maxConnections = 32;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => resolve());
        });
        const actual = (server.address() as { port: number }).port;
        this.servers.push(server);
        this.listening.push(host.includes(":") ? `[${host}]:${actual}` : `${host}:${actual}`);
      } catch (e) {
        errors.push(`${host}: ${(e as Error).message}`);
      }
    }
    if (this.servers.length === 0) throw new Error(errors.join("; ") || "no tailscale address");
    this.opts.log?.(`[mobile] 열림 ${this.listening.join(", ")}`);
  }

  async stop(): Promise<void> {
    const all = this.servers;
    this.servers = [];
    this.listening = [];
    await Promise.all(
      all.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections?.();
          }),
      ),
    );
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // 서버는 Tailscale 주소에만 열지만, 같은 Mac 의 다른 경로로 들어온 것까지 한 번 더 막는다
      if (!this.trusted(req.socket.remoteAddress ?? "")) return json(res, 403, { error: "forbidden" });
      // DNS 리바인딩 막기: 다른 이름으로 이 서버에 닿은 요청은 받지 않는다
      const host = req.headers.host ?? "";
      if (!this.listening.includes(host)) return json(res, 403, { error: "host" });
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && req.headers.origin !== `http://${host}`) return json(res, 403, { error: "origin" });
      const path = new URL(req.url ?? "/", "http://x").pathname;

      if (path === "/api/pair" && method === "POST") {
        const body = (await readBody(req)) as { code?: unknown; name?: unknown } | null;
        const r = this.opts.pairing.pair(String(body?.code ?? ""), String(body?.name ?? ""));
        if (!r) return json(res, 401, { error: this.opts.pairing.locked() ? "locked" : "code" });
        this.opts.onPaired?.(r.device);
        return json(res, 200, { ok: true, token: r.token, device: r.device });
      }
      if (!path.startsWith("/api/")) {
        if (!this.opts.statics({ method, path, res }) && !res.headersSent) json(res, 404, { error: "not_found" });
        return;
      }

      const token = bearer(req);
      if (!this.opts.pairing.verify(token)) return json(res, 401, { error: "unpaired" });
      const body = method === "POST" ? await readBody(req) : null;
      // 본문을 받는 사이 기기가 끊겼을 수 있다 — 실행 직전에 다시 본다
      const device = this.opts.pairing.verify(token);
      if (!device) return json(res, 401, { error: "unpaired" });
      if (path === "/api/me") return json(res, 200, { device });
      const handled = await this.opts.routes({ method, path, body, device, res });
      if (!handled && !res.headersSent) json(res, 404, { error: "not_found" });
    } catch (e) {
      this.opts.log?.(`[mobile] 요청 실패: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 400, { error: "bad_request" });
    }
  }
}
