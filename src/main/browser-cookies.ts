// 인앱 브라우저의 "로그인 유지". 파티션이 persist: 라 만료가 있는 쿠키는 디스크에 남지만,
// 로그인 세션은 대개 만료 없는 세션 쿠키라 Chromium 이 종료할 때 버린다(메모리에만 둔다).
// 크롬의 "이전 세션 계속하기" 와 같은 일을 한다 — 끌 때 받아 적고 켤 때 되돌려 놓는다.
//
// 이건 사실상 로그인 증표를 디스크에 두는 일이다. 그래서 설정으로 끌 수 있고, 끄면 적어 둔 것을 지운다.
//
// 암호화하지 않고 소유자만 읽는 권한(600)으로 둔다. 한때 safeStorage(키체인)로 암호화했지만 되돌렸다:
// 키체인을 쓰면 macOS 가 접근 허용을 묻고, 이 앱은 ad-hoc 서명이라 빌드가 바뀔 때마다 다시 묻는다.
// 이 파일을 읽을 수 있는 주체에게 세션 인증정보가 노출되는 위험은 받아들인 것이다 —
// 보호가 같아서가 아니라, 혼자 쓰는 로컬 도구에서 그 위험보다 프롬프트 부담이 크다고 판단했다.
// 옆의 Chromium 쿠키 DB 도 평문이지만(퓨즈 EnableCookieEncryption 꺼짐) 그건 근거가 아니라 정황이다.

import fs from "node:fs";
import path from "node:path";
import type { Cookie, CookiesSetDetails, Session } from "electron";

/** 적어 둘 쿠키의 최소 정보. Electron 의 Cookie 를 그대로 쓰지 않는 이유는 되돌릴 때 필요한 것만 남기려고. */
export interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  /** 도메인 쿠키(.example.com)인지 호스트 한정인지 — 되돌릴 때 domain 을 줄지 말지가 갈린다. */
  hostOnly: boolean;
}

/** 너무 많이 쌓이지 않게. 로그인 증표는 사이트당 몇 개다. */
export const SESSION_COOKIE_MAX = 500;

/** 쿠키를 다시 심을 때 쓸 주소. domain 앞의 점은 URL 에 넣을 수 없다. */
export function cookieUrl(c: Pick<SavedCookie, "domain" | "path" | "secure">): string {
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  return `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`;
}

/** Electron 의 Cookie → 적어 둘 모양. 세션 쿠키가 아니면 null(그건 이미 디스크에 있다). */
export function toSaved(c: Cookie): SavedCookie | null {
  if (!c.session) return null;
  if (!c.domain || !c.name) return null;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite,
    hostOnly: !c.domain.startsWith("."),
  };
}

/**
 * 되돌릴 때 넘길 값. expirationDate 를 주지 않아야 다시 세션 쿠키가 된다 —
 * 만료를 붙이면 원래보다 오래 사는 쿠키로 성질이 바뀐다.
 */
export function toSetDetails(c: SavedCookie): CookiesSetDetails {
  return {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    // 호스트 한정이면 domain 을 주지 않는다 — 주면 하위 도메인까지 퍼지는 쿠키가 된다.
    ...(c.hostOnly ? {} : { domain: c.domain }),
  };
}

/** 디스크의 값은 믿지 않는다 — 모양이 틀린 항목은 조용히 버린다. */
export function parseSaved(raw: string): SavedCookie[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (c): c is SavedCookie =>
          !!c && typeof c.name === "string" && typeof c.value === "string" && typeof c.domain === "string" && typeof c.path === "string",
      )
      .slice(0, SESSION_COOKIE_MAX);
  } catch {
    return [];
  }
}

export function cookieFilePath(userData: string): string {
  return path.join(userData, "browser-session-cookies.json");
}

/** 종료 직전에 부른다. 실패해도 종료를 막지 않는다. */
export async function saveSessionCookies(ses: Session, userData: string): Promise<number> {
  const file = cookieFilePath(userData);
  try {
    const all = await ses.cookies.get({});
    const saved = all.map(toSaved).filter((c): c is SavedCookie => c !== null).slice(0, SESSION_COOKIE_MAX);
    if (saved.length === 0) {
      forgetSessionCookies(userData);
      return 0;
    }
    fs.writeFileSync(file, JSON.stringify(saved), { encoding: "utf8", mode: 0o600 });
    return saved.length;
  } catch (e) {
    console.error("[browser] 세션 쿠키 저장 실패:", e);
    return 0;
  }
}

/** 저장해 둔 목록을 읽는다. 못 읽으면 빈 목록 — 로그인만 풀린다. */
function readSaved(userData: string): SavedCookie[] {
  try {
    return parseSaved(fs.readFileSync(cookieFilePath(userData), "utf8"));
  } catch {
    return [];
  }
}

/** 창을 띄우기 전에 부른다. 하나씩 심고, 실패한 것은 건너뛴다(사이트 하나 때문에 전부 날리지 않게). */
export async function restoreSessionCookies(ses: Session, userData: string): Promise<number> {
  const list = readSaved(userData);
  if (list.length === 0) return 0;
  let ok = 0;
  for (const c of list) {
    try {
      await ses.cookies.set(toSetDetails(c));
      ok += 1;
    } catch {
      /* 그 사이트만 로그인이 풀린다 */
    }
  }
  return ok;
}

/** 설정을 끄거나 사용자가 지울 때. */
export function forgetSessionCookies(userData: string): void {
  try {
    fs.rmSync(cookieFilePath(userData), { force: true });
  } catch {
    /* 없으면 그만 */
  }
}
