// 휴대폰 화면의 API. 출입 통제는 mobile-server.ts 가 끝낸 뒤라 여기 오는 요청은 짝지은 기기의 것이다.
// 할 수 있는 일: 탭 목록 보기, 대화 읽기(실시간), 메시지 보내기, 중단, 권한 요청 답하기. 새 탭·설정 바꾸기는 하지 않는다.
// 앱 상태는 deps 로 받는다 — 테스트는 가짜 deps 로 돈다.

import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Provider } from "@shared/ipc";
import type { ChatEvent } from "@shared/chat-events";
import { json, type MobileRoute, type MobileStatic } from "./mobile-server";

export interface MobileTabDto {
  id: string;
  title: string;
  workspace: string | null;
  /** 탭의 실제 작업 폴더. 권한 요청을 허용하기 전에 어디서 실행되는지 보여 준다. */
  cwd: string | null;
  provider: Provider | null;
  status: string;
  /** 권한 요청이 답을 기다리는 중. */
  waiting: boolean;
}

export interface MobileApiDeps {
  tabs(): MobileTabDto[];
  /** 그 탭의 대화 이벤트. 없는 탭이면 null. */
  events(tabId: string): ChatEvent[] | null;
  send(tabId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  abort(tabId: string): void;
  /** 그 탭에 그 요청이 아직 기다리고 있으면 답하고 true. */
  answer(tabId: string, requestId: string, allow: boolean): boolean;
}

/** 한 번에 보내는 이벤트 수 상한 — 오래된 긴 대화가 휴대폰을 붙잡지 않게 뒤쪽만 준다. */
const MAX_EVENTS = 1500;
const MAX_TEXT = 20_000;

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** 기기 하나가 동시에 열 수 있는 스트림 수, 전체 상한. 넘으면 그 기기의 가장 오래된 연결을 닫는다. */
const STREAMS_PER_DEVICE = 3;
const STREAMS_TOTAL = 12;
/** 읽지 않고 쌓인 바이트가 이만큼이면 연결을 끊는다 — 읽기를 멈춘 연결이 메인 프로세스 메모리를 붙잡지 않게. 다시 붙으면 놓친 것은 다시 받는다. */
const STREAM_BACKLOG = 1024 * 1024;

/** 실시간 스트림(SSE) 구독자. 앱이 화면에 보내는 이벤트를 휴대폰에도 흘린다. */
export class MobileStream {
  /** 연결 → 그 기기 id(넣은 순서 = 오래된 순). 기기를 끊으면 그 기기의 연결도 바로 닫는다. */
  private clients = new Map<http.ServerResponse, string>();
  private beat: ReturnType<typeof setInterval> | null = null;

  /** alive: 그 기기가 아직 등록돼 있는지. 끊기거나 새 기기에 밀려 빠진 기기의 연결은 보내기 전에 닫는다. */
  constructor(private readonly alive: (deviceId: string) => boolean = () => true) {}

  add(res: http.ServerResponse, deviceId: string): void {
    // 넘치면 그 기기의 가장 오래된 연결을 닫는다. 새 연결을 거절하지 않는 건, 휴대폰이 망을 바꾸면 죽은 연결이 남아
    // 다시 붙지 못하게 되기 때문이다. 밀려난 페이지에는 replaced 를 알려, 화면에 다시 보일 때까지 재연결하지 않게 한다.
    const mine = [...this.clients].filter(([, id]) => id === deviceId).map(([c]) => c);
    for (const c of mine.slice(0, Math.max(0, mine.length - STREAMS_PER_DEVICE + 1))) this.replace(c);
    if (this.clients.size >= STREAMS_TOTAL) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    this.clients.set(res, deviceId);
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this.beat) {
        clearInterval(this.beat);
        this.beat = null;
      }
    });
    // 휴대폰·중간 장비가 조용한 연결을 끊지 않게 가끔 빈 줄을 보낸다
    this.beat ??= setInterval(() => this.write(": ping\n\n"), 25_000);
  }

  send(type: string, data: unknown): void {
    if (this.clients.size > 0) this.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** 끊은 기기의 열린 연결을 닫는다. */
  closeDevice(deviceId: string): void {
    for (const [c, id] of this.clients) if (id === deviceId) this.drop(c);
  }

  /** 더는 등록돼 있지 않은 기기의 연결을 닫는다(새 기기가 들어와 오래된 기기가 밀려났을 때). */
  prune(): void {
    for (const [c, id] of this.clients) if (!this.alive(id)) this.drop(c);
  }

  closeAll(): void {
    for (const c of this.clients.keys()) c.end();
    this.clients.clear();
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  get size(): number {
    return this.clients.size;
  }

  /** 목록에서 빼고 바로 끊는다. end 만 하면 읽지 않는 연결은 쌓인 것을 다 보낼 때까지 소켓이 남는다. */
  private drop(c: http.ServerResponse): void {
    this.clients.delete(c);
    c.destroy();
  }

  /** 밀려난 연결: replaced 를 보내고 잠깐 뒤 끊는다(바로 끊으면 알림이 못 갈 수 있다). */
  private replace(c: http.ServerResponse): void {
    this.clients.delete(c);
    c.end("event: replaced\ndata: null\n\n");
    setTimeout(() => c.destroy(), 1000).unref?.();
  }

  private write(chunk: string): void {
    for (const [c, id] of this.clients) {
      if (!this.alive(id) || c.writableLength > STREAM_BACKLOG) {
        this.drop(c);
        continue;
      }
      c.write(chunk);
      if (c.writableLength > STREAM_BACKLOG) this.drop(c);
    }
  }
}

function serveFile(res: http.ServerResponse, file: string): boolean {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  const isHtml = file.endsWith(".html");
  res.writeHead(200, {
    "content-type": isHtml ? "text/html; charset=utf-8" : (TYPES[path.extname(file)] ?? "application/octet-stream"),
    // 화면 파일은 빌드마다 이름이 바뀌어 오래 둬도 된다. html 은 늘 새로.
    "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
    ...(isHtml
      ? {
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        }
      : {}),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

/** 휴대폰 화면 파일(mobile.html·assets/)과 표시 언어. 비밀이 없어 인증 없이 준다. pageDir 은 빌드된 renderer 폴더. */
export function mobileStatics(pageDir: string, language: () => string): MobileStatic {
  return ({ method, path: p, res }) => {
    if (method !== "GET") return false;
    // 표시 언어는 연결 전 화면에도 필요하고 비밀이 아니다
    if (p === "/app-info") {
      json(res, 200, { language: language() });
      return true;
    }
    if (p === "/" || p === "/index.html") return serveFile(res, path.join(pageDir, "mobile.html"));
    // assets/ 의 이름 하나만 — 경로를 거슬러 다른 파일을 꺼내지 못하게
    const asset = /^\/assets\/([\w.-]+)$/.exec(p);
    return asset ? serveFile(res, path.join(pageDir, "assets", asset[1])) : false;
  };
}

export function mobileRoutes(deps: MobileApiDeps, stream: MobileStream): MobileRoute {
  return async ({ method, path: p, body, res, device }) => {
    if (method === "GET" && p === "/api/stream") {
      stream.add(res, device.id);
      return true;
    }
    if (method === "GET" && p === "/api/tabs") {
      json(res, 200, { tabs: deps.tabs() });
      return true;
    }
    const m = /^\/api\/tabs\/([\w-]{1,100})\/(events|send|abort|permission)$/.exec(p);
    if (!m) return false;
    const [, tabId, action] = m;
    if (method === "GET" && action === "events") {
      const events = deps.events(tabId);
      if (!events) {
        json(res, 404, { error: "tab" });
        return true;
      }
      json(res, 200, { events: events.slice(-MAX_EVENTS), truncated: events.length > MAX_EVENTS });
      return true;
    }
    if (method !== "POST") return false;
    const b = (body ?? {}) as Record<string, unknown>;
    if (action === "send") {
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (!text || text.length > MAX_TEXT) {
        json(res, 400, { error: "text" });
        return true;
      }
      const r = await deps.send(tabId, text);
      json(res, r.ok ? 200 : 409, r);
      return true;
    }
    if (action === "abort") {
      deps.abort(tabId);
      json(res, 200, { ok: true });
      return true;
    }
    // permission
    if (typeof b.requestId !== "string" || typeof b.allow !== "boolean") {
      json(res, 400, { error: "permission" });
      return true;
    }
    const ok = deps.answer(tabId, b.requestId, b.allow);
    json(res, ok ? 200 : 409, { ok });
    return true;
  };
}
