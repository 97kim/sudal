import type { TFunction } from "i18next";

// 브라우저 탭의 "이 화면을 진단해 줘" 첨부. 주소·시각·콘솔 오류·실패한 요청을 한 덩어리로 묶는다.
// 모으는 곳은 둘로 나뉜다 — 콘솔은 렌더러의 <webview> console-message, 요청 실패는 main 의 session.webRequest.
// 여기서는 형식과 다듬기(정렬·중복 제거·상한)만 맡아 양쪽에서 같은 규칙을 쓴다.

/** 페이지가 콘솔에 남긴 줄. level 은 Electron 의 console-message 등급(0=verbose,1=info,2=warning,3=error). */
export interface ConsoleLine {
  ts: number;
  level: number;
  text: string;
  source?: string;
  line?: number;
}

/** 실패한 요청. 통신 자체가 깨진 것(error)과 응답은 왔지만 4xx·5xx 인 것(status)을 나눠 담는다. */
export interface NetFailure {
  ts: number;
  url: string;
  method: string;
  /** 통신 오류면 Chromium 의 오류 문자열, 아니면 null. */
  error: string | null;
  /** HTTP 상태. 통신 오류면 0. */
  status: number;
  resourceType?: string;
}

export const DIAG_MAX_CONSOLE = 40;
export const DIAG_MAX_NET = 30;
/** 한 줄이 이보다 길면 자른다(로그 한 줄에 base64 나 거대한 JSON 이 통째로 오는 일이 흔하다). */
export const DIAG_MAX_LINE = 500;

const clip = (t: TFunction, s: string, max = DIAG_MAX_LINE) => (s.length <= max ? s : t("promptDoc.attach.diag.clipped", { text: s.slice(0, max), n: s.length }));
export const levelName = (l: number) => (l >= 3 ? "error" : l === 2 ? "warn" : l === 1 ? "info" : "log");

/** 링 버퍼에 넣는다. 바로 앞과 같은 내용이면 세기만 늘리지 않고 그냥 버린다(같은 오류가 초당 수십 번 나는 경우). */
export function pushCapped<T>(buf: T[], item: T, max: number): T[] {
  const next = buf.length >= max ? buf.slice(buf.length - max + 1) : buf.slice();
  next.push(item);
  return next;
}

/** 연달아 같은 텍스트면 하나로 접고 "(n번)" 을 붙인다. */
function dedupe(t: TFunction, lines: string[]): string[] {
  const out: string[] = [];
  let last = "";
  let n = 0;
  const flush = () => {
    if (!last) return;
    out.push(n > 1 ? t("promptDoc.attach.diag.repeat", { line: last, n }) : last);
  };
  for (const l of lines) {
    if (l === last) {
      n += 1;
      continue;
    }
    flush();
    last = l;
    n = 1;
  }
  flush();
  return out;
}

const hhmmss = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

export interface DiagnosticsInput {
  url: string;
  title?: string;
  at: number;
  /** 보이는 영역 크기(캡처 범위를 읽는 사람이 알 수 있게). */
  viewport?: { width: number; height: number };
  console: ConsoleLine[];
  net: NetFailure[];
  /** 화면 캡처를 첨부했는지. 이미지는 별도 경로로 붙으므로 여기선 언급만 한다. */
  hasScreenshot: boolean;
}

/**
 * 채팅 입력창에 붙일 텍스트. 오류가 하나도 없으면 "없음" 이라고 분명히 적는다 —
 * 모델이 "로그를 못 봤다" 와 "봤는데 깨끗했다" 를 구분할 수 있어야 한다.
 */
export function formatDiagnostics(t: TFunction, d: DiagnosticsInput): string {
  const count = (n: number) => (n === 0 ? t("promptDoc.attach.diag.none") : t("promptDoc.attach.diag.count", { n }));
  const errors = d.console.filter((c) => c.level >= 2);
  const conLines = dedupe(
    t,
    errors.map((c) => {
      const where = c.source ? ` — ${c.source}${c.line ? `:${c.line}` : ""}` : "";
      return `[${hhmmss(c.ts)}] ${levelName(c.level)}: ${clip(t, c.text)}${where}`;
    }),
  ).slice(-DIAG_MAX_CONSOLE);
  const netLines = dedupe(
    t,
    d.net.map((n) => {
      const what = n.error ? n.error : `HTTP ${n.status}`;
      return `[${hhmmss(n.ts)}] ${what} — ${n.method} ${clip(t, n.url, 200)}${n.resourceType ? ` (${n.resourceType})` : ""}`;
    }),
  ).slice(-DIAG_MAX_NET);

  const head = [
    "```text",
    t("promptDoc.attach.diag.head", { url: d.url }),
    d.title ? t("promptDoc.attach.diag.title", { title: clip(t, d.title, 120) }) : null,
    d.viewport
      ? t("promptDoc.attach.diag.atViewport", { at: d.at, w: d.viewport.width, h: d.viewport.height })
      : t("promptDoc.attach.diag.at", { at: d.at }),
    "",
    t("promptDoc.attach.diag.console", { summary: count(conLines.length) }),
    ...(conLines.length === 0 ? [] : conLines.map((l) => `  ${l}`)),
    "",
    t("promptDoc.attach.diag.net", { summary: count(netLines.length) }),
    ...(netLines.length === 0 ? [] : netLines.map((l) => `  ${l}`)),
    "```",
  ].filter((l): l is string => l !== null);
  if (d.hasScreenshot) head.push(t("promptDoc.attach.diag.screenshot"));
  return head.join("\n");
}
