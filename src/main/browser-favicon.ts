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

export async function fetchFavicon(url: string): Promise<string | null> {
  if (!isFetchableFavicon(url)) return null;
  const hit = cache.get(url);
  if (hit !== undefined) return hit;

  let out: string | null = null;
  try {
    // 브라우저 파티션으로 받는다 — 그 페이지를 띄운 곳과 같은 쿠키·캐시를 쓰게.
    const res = await session.fromPartition(BROWSER_PARTITION).fetch(url);
    if (res.ok) {
      const mime = imageMime(res.headers.get("content-type"));
      if (mime) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > 0 && buf.byteLength <= FAVICON_MAX_BYTES) out = `data:${mime};base64,${buf.toString("base64")}`;
      }
    }
  } catch {
    out = null; // 못 받으면 화면은 지구본으로 돌아간다
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(url, out);
  return out;
}
