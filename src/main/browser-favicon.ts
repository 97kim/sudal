// 브라우저 탭의 파비콘. 렌더러의 CSP 가 img-src 'self' data: 라 원격 주소를 그대로 <img> 에 넣을 수 없다
// (그러라고 CSP 를 푸는 건 앱 화면이 임의의 원격 이미지를 받게 만드는 일이다).
// 그래서 main 이 브라우저 파티션으로 받아 data URL 로 바꿔 넘긴다 — 화면은 data: 만 보게 된다.

import { session } from "electron";
import { BROWSER_PARTITION } from "./browser-net";

/** 파비콘 하나의 상한. 이보다 크면 파비콘이 아니라고 본다. */
export const FAVICON_MAX_BYTES = 128 * 1024;
/** 기억해 둘 개수. 탭을 오갈 때마다 다시 받지 않게. */
const CACHE_MAX = 200;

/** url → data URL(못 받았으면 null). null 도 기억해 같은 주소를 반복해서 두드리지 않는다. */
const cache = new Map<string, string | null>();

/** 주소가 받아올 만한 것인가. http(s) 만 — file:·data: 는 여기서 받을 이유가 없다. */
export function isFetchableFavicon(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** 이미지가 맞나. svg 는 <img> 로 그려도 스크립트가 돌지 않지만, 굳이 받지 않는다(용도가 아이콘이다). */
function imageMime(contentType: string | null): string | null {
  const t = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!t.startsWith("image/")) return null;
  return t;
}

export function fetchFavicon(url: string): Promise<string | null> {
  // 브라우저 파티션으로 받는다 — 그 페이지를 띄운 곳과 같은 쿠키·캐시를 쓰게. localhost 개발 서버의 파비콘도 받는다.
  return cached(`fav\0${url}`, () => fetchImage(url, FAVICON_MAX_BYTES, session.fromPartition(BROWSER_PARTITION), false));
}

/** 문서 미리보기 속 원격 이미지(README 배지·스크린샷) 하나의 상한. */
export const DOC_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** 문서 이미지는 쿠키 없는 메모리 세션으로 받는다(persist: 가 아니라 디스크에 안 남는다). */
const DOC_IMAGE_PARTITION = "sudal-doc-images";

/**
 * README 속 원격 이미지. 문서는 남이 쓴 것일 수 있어, 열기만 해도 로그인된 사이트나 내부 서비스로 요청이 나가면 안 된다 —
 * 쿠키 없는 세션으로 받고, 이 PC·사설망 주소는 리다이렉트 단계마다 막는다.
 */
export function fetchDocImage(url: string): Promise<string | null> {
  return cached(`doc\0${url}`, () => fetchImage(url, DOC_IMAGE_MAX_BYTES, session.fromPartition(DOC_IMAGE_PARTITION), true));
}

/** 이 PC·사설망·링크 로컬을 가리키는 호스트인가(주소 문자열만 본다 — 이름이 사설 IP 로 풀리는 경우까지는 못 막는다). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  // 점 없는 이름(intranet, router 등)은 내부망 이름이다
  return !h.includes(".");
}

async function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = await load();
  // 큰 이미지까지 담으면 200개 × 수 MB 가 된다. 파비콘 크기까지만 기억한다.
  if (out && out.length > FAVICON_MAX_BYTES * 2) return out;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

const MAX_REDIRECTS = 5;

async function fetchImage(url: string, maxBytes: number, ses: Electron.Session, publicOnly: boolean): Promise<string | null> {
  try {
    let at = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isFetchableFavicon(at)) return null;
      if (publicOnly && isPrivateHost(new URL(at).hostname)) return null;
      // 문서 이미지는 리다이렉트를 직접 따라가며 단계마다 주소를 다시 본다
      const res = await ses.fetch(at, { redirect: publicOnly ? "manual" : "follow", credentials: publicOnly ? "omit" : "include" });
      if (publicOnly && res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        at = new URL(loc, at).toString();
        continue;
      }
      if (!res.ok) return null;
      const mime = imageMime(res.headers.get("content-type"));
      if (!mime) return null;
      const buf = await readCapped(res, maxBytes);
      return buf && buf.byteLength > 0 ? `data:${mime};base64,${buf.toString("base64")}` : null;
    }
    return null;
  } catch {
    return null; // 못 받으면 화면은 지구본(문서는 대체 글)으로 돌아간다
  }
}

/** 상한을 넘는 순간 끊는다 — 다 받은 뒤에 재면 끝없는 응답이 main 메모리를 채운다. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    void res.body?.cancel();
    return null;
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
