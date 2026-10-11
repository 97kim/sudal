// 인앱 브라우저의 "로그인 유지". 파티션이 persist: 라 만료가 있는 쿠키는 디스크에 남지만,
// 로그인 세션은 대개 만료 없는 세션 쿠키라 Chromium 이 종료할 때 버린다(메모리에만 둔다).
// 크롬의 "이전 세션 계속하기" 와 같은 일을 한다 — 끌 때 받아 적고 켤 때 되돌려 놓는다.
//
// 이건 사실상 로그인 증표를 디스크에 두는 일이다. 그래서 설정으로 끌 수 있고, 끄면 적어 둔 것을 지운다.
//
// 값은 safeStorage(macOS 키체인·Windows DPAPI)로 암호화해 둔다 — Chromium 쿠키 DB 와 같은 키다(퓨즈 EnableCookieEncryption).
// 평문이면 같은 계정의 프로그램(에이전트 포함)이 로그인 증표를 그대로 읽는다. macOS 는 ad-hoc 서명이라 업데이트마다
// 키체인 허용을 다시 묻는다 — 2026-09 에는 그 부담 때문에 평문으로 되돌렸지만, 다른 브라우저 로그인 가져오기가 생겨 다시 켰다.

import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import { cookiesFile, rowToDetails, withCopy, type Row } from "./browser-import";

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
  return path.join(userData, "browser-session-cookies.enc");
}

/** 암호화하지 않던 시절의 평문 파일. 있으면 한 번 옮겨 담고 지운다. */
export function legacyCookieFilePath(userData: string): string {
  return path.join(userData, "browser-session-cookies.json");
}

/**
 * 이번 실행에서 저장분을 읽거나 옮기지 못했으면 그 파일을 남겨 둔다 — 암호문을 풀지 못했거나(키체인 허용 거절 등)
 * 예전 평문 파일을 암호문으로 옮기지 못한 경우다. 다음 실행에서 다시 해 볼 수 있게, 종료할 때 지우지 않는다.
 */
let keepBackup = false;

/**
 * 종료 직전에 부른다. 실패해도 종료를 막지 않는다.
 * 암호화를 못 쓰면 쓰지 않는다 — 있던 파일은 그대로 둔다.
 */
export async function saveSessionCookies(ses: Session, userData: string): Promise<number> {
  const file = cookieFilePath(userData);
  try {
    const all = await ses.cookies.get({});
    const saved = all.map(toSaved).filter((c): c is SavedCookie => c !== null).slice(0, SESSION_COOKIE_MAX);
    if (saved.length === 0) {
      if (!keepBackup) forgetSessionCookies(userData);
      return 0;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.error("[browser] 암호화를 쓸 수 없어 세션 쿠키를 저장하지 않습니다(로그인이 유지되지 않습니다).");
      return 0;
    }
    writeEncrypted(file, saved);
    if (!keepBackup) fs.rmSync(legacyCookieFilePath(userData), { force: true });
    return saved.length;
  } catch (e) {
    console.error("[browser] 세션 쿠키 저장 실패:", e);
    return 0;
  }
}

/**
 * 임시 파일에 다 쓴 뒤 이름을 바꾼다 — 쓰다 실패해 반쯤 쓴 .enc 가 남으면 다음 실행이 그걸 풀려다 실패하고,
 * 옆의 멀쩡한 예전 평문 파일을 다시 보지 않는다.
 */
function writeEncrypted(file: string, list: SavedCookie[]): void {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(list)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * 암호문 또는 (예전) 평문에서 목록을 읽는다. 못 읽으면 빈 목록 — 로그인만 풀린다.
 * 예전 평문 파일은 읽자마자 그 내용 그대로 암호문으로 옮기고 지운다 — 심기에 성공했는지와 상관없이 평문을 바로 없애고,
 * 못 심은 쿠키도 암호문에 있던 것과 똑같이 다룬다. 옮기지 못하면(암호화 불가·키체인 거절) 평문을 남겨 둔다.
 */
function readSaved(userData: string): SavedCookie[] {
  const enc = cookieFilePath(userData);
  if (fs.existsSync(enc)) {
    try {
      return parseSaved(safeStorage.decryptString(fs.readFileSync(enc)));
    } catch (e) {
      // 키체인 허용을 거절했거나 다른 기기에서 옮겨 온 파일. 지우지 않는다 — 거절은 다음 실행에서 바뀔 수 있다.
      console.error("[browser] 세션 쿠키를 풀지 못했습니다(파일은 남겨 둡니다):", e);
      keepBackup = true;
      return [];
    }
  }
  const legacy = legacyCookieFilePath(userData);
  let list: SavedCookie[];
  try {
    list = parseSaved(fs.readFileSync(legacy, "utf8"));
  } catch {
    return [];
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("암호화를 쓸 수 없음");
    writeEncrypted(enc, list);
    fs.rmSync(legacy, { force: true });
    if (list.length > 0) console.log(`[browser] 평문 세션 쿠키 ${list.length}개를 암호문으로 옮겼습니다`);
  } catch (e) {
    console.error("[browser] 평문 세션 쿠키를 암호문으로 옮기지 못했습니다(파일은 남겨 둡니다):", e);
    keepBackup = true;
  }
  return list;
}

/** 창을 띄우기 전에 부른다. 하나씩 심고, 실패한 것은 건너뛴다(사이트 하나 때문에 전부 날리지 않게). */
export async function restoreSessionCookies(ses: Session, userData: string): Promise<number> {
  // 키체인 키는 쿠키 저장소(Chromium)와 여기(safeStorage)가 따로 받아 온다. 동시에 물으면 업데이트 뒤 허용 창이 두 개
  // 뜬다 — 쿠키 저장소가 키를 받아 올 때까지 기다렸다가 물으면, 첫 창에서 "항상 허용" 한 뒤라 창 없이 통과한다.
  await ses.cookies.get({ domain: "sudal.invalid" }).catch(() => {});
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

/**
 * 암호화를 켜기 전에 쓴 쿠키는 DB 에 평문으로 남는다. Chromium 은 그걸 읽기만 하고 다시 암호화하지 않으니,
 * 같은 쿠키를 다시 써서 암호문으로 바꾼다. 페이지가 쿠키를 바꾸기 전에 끝나야 한다 — 늦으면 새 값을 옛 값으로 덮는다.
 * 최상위 사이트별로 나뉜 쿠키는 다시 쓸 때 그 구분을 줄 방법이 없어 그대로 둔다.
 * 다 옮기면 doneFile 을 남겨 다음부터는 DB 를 읽지 않는다(새로 쓰는 쿠키는 처음부터 암호문이다).
 */
export async function encryptPlaintextCookies(ses: Session, partitionDir: string, doneFile: string): Promise<number> {
  if (fs.existsSync(doneFile)) return 0;
  const file = cookiesFile(partitionDir);
  if (!file) {
    fs.writeFileSync(doneFile, "");
    return 0;
  }
  const rows = plaintextRows(file);
  let ok = 0;
  for (const r of rows) {
    try {
      await ses.cookies.set(rowToDetails(r, r.value));
      ok += 1;
    } catch {
      /* 그 쿠키만 평문으로 남는다 — 다음 실행에서 다시 해 본다 */
    }
  }
  // set 은 메모리에만 반영하고 디스크엔 나중에 쓴다. 다 쓴 뒤 DB 에 평문이 정말 없을 때만 표시를 남긴다 —
  // 먼저 남기고 꺼지면 평문 행이 남은 채 다시는 옮기지 않는다.
  await ses.cookies.flushStore();
  if (plaintextRows(file).length === 0) fs.writeFileSync(doneFile, "");
  return ok;
}

/** 쿠키 DB 의 평문 행. 최상위 사이트별로 나뉜 쿠키는 다시 쓸 수 없어 빼고 센다. */
function plaintextRows(file: string): Row[] {
  return withCopy(file, (db) => {
    const hasPartition = (db.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]).some((c) => c.name === "top_frame_site_key");
    const stmt = db.prepare(
      `SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, has_expires, samesite FROM cookies WHERE value <> ''${hasPartition ? " AND top_frame_site_key = ''" : ""}`,
    );
    stmt.setReadBigInts(true);
    return stmt.all() as unknown as Row[];
  });
}

/** 설정을 끄거나 사용자가 지울 때. 평문으로 쓰던 시절의 파일도 같이 지운다. */
export function forgetSessionCookies(userData: string): void {
  for (const f of [cookieFilePath(userData), legacyCookieFilePath(userData)]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 없으면 그만 */
    }
  }
}
