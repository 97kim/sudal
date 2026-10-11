import { webSearchUrl } from "@shared/web-search";

/**
 * 주소창 입력을 URL 로. 스킴이 없으면 localhost·IP·포트는 http, 나머지는 https.
 * 공백이 있거나, 점도 포트도 없는 한 단어("react")면 검색어로 본다.
 * "localhost:3000"·"example.com:8080" 의 콜론은 스킴이 아니라 포트다 — 콜론 뒤가 숫자(포트)면 스킴으로 보지 않는다.
 */
export function normalizeUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:(?!\d+([/?#]|$))/i.test(t)) return null; // file:, javascript:, mailto: 등은 열지 않는다
  if (/\s/.test(t)) return webSearchUrl(t);
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(t);
  if (!local && !/^[^/?#]*[.:]/.test(t)) return webSearchUrl(t);
  return `${local ? "http" : "https"}://${t}`;
}
