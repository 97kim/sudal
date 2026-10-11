// 다른 브라우저(Chrome·Edge)의 로그인(쿠키)을 인앱 브라우저로 가져온다. macOS 만 — Windows 의 Chrome 127+ 은
// 앱 전용 암호화(v20)라 다른 앱이 풀 수 없다.
// 쿠키 DB 는 브라우저가 켜져 있으면 잠겨 있어 임시로 복사해 읽는다. 값은 키체인의 "<브라우저> Safe Storage" 비밀번호로
// 만든 키(PBKDF2)로 AES-128-CBC 를 푼다. 풀어낸 쿠키는 인앱 브라우저 세션으로만 가고 렌더러에는 사이트 이름·개수만 간다.
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { Cookie, CookiesSetDetails, Session } from "electron";

const run = promisify(execFile);

const BROWSERS = [
  { browser: "chrome", name: "Chrome", root: "Google/Chrome", service: "Chrome Safe Storage", account: "Chrome" },
  { browser: "edge", name: "Edge", root: "Microsoft Edge", service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
] as const;

export interface ImportSource {
  /** "chrome:Profile 3" — 렌더러는 이 id 로만 고른다(경로를 받지 않는다). */
  id: string;
  browser: (typeof BROWSERS)[number]["browser"];
  label: string;
  cookies: string;
}

export interface ImportSite {
  host: string;
  count: number;
  /** 옮겨도 쓸 수 없는 사이트 — 고를 수 없다. */
  blocked?: "google";
}

/**
 * Google 로그인은 기기에 묶여 있어 옮긴 쿠키를 거부하거나 곧 만료시킨다.
 * 가져오지도, 교체하며 지우지도 않는다 — Sudal 안에서 직접 로그인한 세션이 유일하게 쓸 수 있는 것이다.
 */
export function isGoogleHost(host: string): boolean {
  const h = host.replace(/^\./, "").toLowerCase();
  return h === "google.com" || h.endsWith(".google.com");
}

export function importSupported(): boolean {
  return process.platform === "darwin";
}

export function cookiesFile(dir: string): string | null {
  for (const p of [join(dir, "Network", "Cookies"), join(dir, "Cookies")]) if (existsSync(p)) return p;
  return null;
}

/** 쿠키 DB 가 있는 프로필들. 이름은 브라우저의 Local State 에 적힌 대로(없으면 폴더 이름). */
// e2e 전용: 가짜 프로필 폴더와 키체인 대신 쓸 비밀번호. 사람이 키체인 창을 눌러 줄 수 없어서 둔다.
const TEST_BASE = process.env.SUDAL_IMPORT_BASE;
const TEST_PASSWORD = process.env.SUDAL_IMPORT_TEST_PASSWORD;

export function listSources(base = TEST_BASE || join(homedir(), "Library", "Application Support")): ImportSource[] {
  const out: ImportSource[] = [];
  for (const b of BROWSERS) {
    const root = join(base, b.root);
    if (!existsSync(root)) continue;
    let names: Record<string, string> = {};
    try {
      const state = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: string }> } };
      names = Object.fromEntries(Object.entries(state.profile?.info_cache ?? {}).map(([dir, v]) => [dir, v.name || dir]));
    } catch {
      /* Local State 가 없으면 Default 만 본다 */
    }
    const dirs = Object.keys(names).length ? Object.keys(names) : ["Default"];
    for (const dir of dirs) {
      const cookies = cookiesFile(join(root, dir));
      if (cookies) out.push({ id: `${b.browser}:${dir}`, browser: b.browser, label: `${b.name} · ${names[dir] ?? dir}`, cookies });
    }
  }
  return out;
}

/** 잠긴 DB 를 복사본으로 연다. 저널(-journal·-wal)도 같이 옮겨야 최근 쓴 것까지 보인다. */
export function withCopy<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sudal-cookies-"));
  try {
    const copy = join(dir, "Cookies");
    copyFileSync(path, copy);
    for (const ext of ["-journal", "-wal"]) if (existsSync(path + ext)) copyFileSync(path + ext, copy + ext);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bare = (host: string) => host.replace(/^\./, "");

/** 사이트(호스트)별 쿠키 수. ".example.com" 과 "example.com" 은 한 줄로 친다. */
export function listSites(cookiesPath: string): ImportSite[] {
  return withCopy(cookiesPath, (db) => {
    const by = new Map<string, number>();
    for (const r of db.prepare("SELECT host_key AS h, COUNT(*) AS n FROM cookies GROUP BY host_key").all() as { h: string; n: number }[])
      by.set(bare(r.h), (by.get(bare(r.h)) ?? 0) + Number(r.n));
    return [...by].map(([host, count]): ImportSite => (isGoogleHost(host) ? { host, count, blocked: "google" } : { host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  });
}

/** 키체인 비밀번호 → AES 키. Chrome macOS 의 고정 값(salt "saltysalt", 1003회). */
export function chromeKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/**
 * encrypted_value 를 푼다. "v10" 이 아니거나 키가 틀리면 null. DB 버전 24 부터는 풀어낸 값 앞에 sha256(host_key) 32바이트가 붙는다.
 */
export function decryptValue(enc: Uint8Array, key: Buffer, hostKey: string, dbVersion: number): string | null {
  const buf = Buffer.from(enc);
  if (buf.length < 4 || buf.subarray(0, 3).toString() !== "v10") return null;
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  // 버전 24+ 는 해시가 반드시 있다 — 없으면 키가 틀린 것(패딩은 우연히 맞기도 해 그것만으론 못 거른다).
  if (dbVersion >= 24) {
    if (plain.length < 32 || !plain.subarray(0, 32).equals(createHash("sha256").update(hostKey).digest())) return null;
    plain = plain.subarray(32);
  }
  // toString 은 깨진 바이트를 U+FFFD 로 바꿔 다른 값을 만든다 — 그럴 바엔 못 푼 것으로 센다.
  // ignoreBOM: 기본값이면 맨 앞의 U+FEFF 를 BOM 으로 보고 지워 값이 달라진다.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
}

/** Chrome 시각(1601-01-01 부터 마이크로초) → 유닉스 초. 0 이면 세션 쿠키. */
export function chromeTimeToUnix(t: number | bigint): number | undefined {
  // 값이 2^53 을 넘어 BigInt 로 읽는다 — 초 단위로 나눈 뒤에 숫자로 바꿔야 정밀도를 잃지 않는다.
  const us = typeof t === "bigint" ? t : BigInt(Math.trunc(t));
  return us > 0n ? Number(us / 1_000_000n) - 11644473600 : undefined;
}

const SAME_SITE: Record<number, CookiesSetDetails["sameSite"]> = { 0: "no_restriction", 1: "lax", 2: "strict" };

export interface Row {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  has_expires: bigint;
  samesite: bigint;
  top_frame_site_key?: string;
}

/** 이미 만료된 쿠키를 쓰면 저장소는 같은 쿠키를 지우고 성공으로 답한다 — 가져온 것으로 치면 안 된다. */
const expired = (c: CookiesSetDetails) => c.expirationDate !== undefined && c.expirationDate <= Date.now() / 1000;

/** 쿠키 DB 의 한 행을 cookies.set 형식으로. value 는 풀어낸 값. */
export function rowToDetails(r: Row, value: string): CookiesSetDetails {
  const secure = Number(r.is_secure) === 1;
  const path = r.path || "/";
  // __Host- 쿠키는 domain 을 주면 거절된다. "." 로 시작하면 하위 도메인까지, 아니면 그 호스트만.
  const domain = r.name.startsWith("__Host-") || !r.host_key.startsWith(".") ? undefined : r.host_key;
  return {
    url: `${secure ? "https" : "http"}://${bare(r.host_key)}${path}`,
    name: r.name,
    value,
    ...(domain ? { domain } : {}),
    path,
    secure,
    httpOnly: Number(r.is_httponly) === 1,
    ...(Number(r.has_expires) === 1 && chromeTimeToUnix(r.expires_utc) ? { expirationDate: chromeTimeToUnix(r.expires_utc) } : {}),
    sameSite: SAME_SITE[Number(r.samesite)] ?? "unspecified",
  };
}

/**
 * 고른 사이트들의 쿠키를 풀어 Electron cookies.set 형식으로. 못 푼 것은 failed, 최상위 사이트별로 나뉜(partitioned)
 * 쿠키는 partitioned 로 센다 — 그 격리를 그대로 옮길 방법이 없어 일반 쿠키로 넣으면 범위가 넓어진다.
 */
export function readCookies(cookiesPath: string, hosts: string[], key: Buffer): { cookies: CookiesSetDetails[]; failed: number; partitioned: number } {
  const want = new Set(hosts.map(bare).filter((h) => !isGoogleHost(h)));
  return withCopy(cookiesPath, (db) => {
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined)?.value ?? 0);
    const cookies: CookiesSetDetails[] = [];
    let failed = 0;
    let partitioned = 0;
    // 옛 DB 엔 top_frame_site_key 칸이 없다.
    const hasPartition = (db.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]).some((c) => c.name === "top_frame_site_key");
    const stmt = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite${hasPartition ? ", top_frame_site_key" : ""} FROM cookies`);
    // expires_utc 는 JS 숫자 범위를 넘는다. 그러면 다른 정수 칸도 BigInt 로 오므로 아래에서 Number() 로 비교한다.
    stmt.setReadBigInts(true);
    const rows = stmt.all() as unknown as Row[];
    for (const r of rows) {
      if (!want.has(bare(r.host_key))) continue;
      if (r.top_frame_site_key) {
        partitioned++;
        continue;
      }
      // 값이 빈 쿠키도 정상이다 — 두 칸이 다 비어 있으면 빈 값 그대로 옮긴다.
      let value: string | null = r.value ?? "";
      if (!value && r.encrypted_value?.length) {
        try {
          value = decryptValue(r.encrypted_value, key, r.host_key, version);
        } catch {
          value = null;
        }
      }
      if (value === null) {
        failed++;
        continue;
      }
      const d = rowToDetails(r, value);
      if (!expired(d)) cookies.push(d);
    }
    return { cookies, failed, partitioned };
  });
}

/** 키체인에서 그 브라우저의 Safe Storage 비밀번호를 읽는다. 사람이 허용해야 한다(macOS 가 창을 띄운다). */
async function keychainPassword(browser: ImportSource["browser"]): Promise<string> {
  if (TEST_PASSWORD) return TEST_PASSWORD;
  const b = BROWSERS.find((x) => x.browser === browser)!;
  const { stdout } = await run("security", ["find-generic-password", "-w", "-s", b.service, "-a", b.account], { timeout: 120_000 });
  return stdout.trim();
}

type CookieJar = Pick<Session["cookies"], "get" | "set">;

/** 쿠키는 이름·도메인·경로로 하나가 정해진다. 도메인은 점 포함 그대로 — 점이 있어야 하위 도메인까지 가는 쿠키다. */
const keyOf = (domain: string, path: string | undefined, name: string) => `${domain}\n${path || "/"}\n${name}`;
const detailsDomain = (c: CookiesSetDetails) => c.domain ?? new URL(c.url).hostname;

/** 같은 이름·도메인·경로를 만료된 값으로 쓸 형식 — 쓰면 그 쿠키 하나만 지워진다. */
function expireDetails(c: Cookie): CookiesSetDetails {
  return {
    url: `${c.secure ? "https" : "http"}://${bare(c.domain ?? "")}${c.path || "/"}`,
    name: c.name,
    value: "",
    ...(c.hostOnly ? {} : { domain: c.domain }),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: 1,
  };
}

/**
 * 가져온 쿠키로 그 사이트들의 쿠키를 바꾼다. 쓰던 쿠키와 섞이면 사이트가 세션을 거부해서, 하나라도 써진 사이트는
 * 가져온 것에 없는 옛 쿠키를 지운다. 하나도 못 쓴 사이트의 로그인은 그대로 둔다.
 * 함정: cookies.remove(url, name) 은 그 주소로 가는 같은 이름 쿠키(상위 도메인·다른 경로)까지 지운다. 그래서 같은
 * 이름·도메인·경로를 만료된 값으로 써서 그 하나만 지운다. 파티션 쿠키엔 이 쓰기가 닿지 않아 그대로 남는다.
 * 지우다 실패해도 되돌리지 않고 센다(staleLeft) — Electron 쿠키엔 파티션 정보가 없어 되살리기가 파티션 쿠키를
 * 일반 쿠키로 복제할 수 있다. 섞여 남은 사이트는 다시 로그인하면 된다.
 */
export async function replaceCookies(jar: CookieJar, cookies: CookiesSetDetails[]): Promise<{ imported: number; rejected: number; staleLeft: number }> {
  const before = await jar.get({});
  const written = new Set<string>();
  const sites = new Set<string>();
  let rejected = 0;
  for (const c of cookies) {
    if (expired(c)) continue;
    try {
      await jar.set(c);
    } catch {
      rejected++;
      continue;
    }
    written.add(keyOf(detailsDomain(c), c.path, c.name ?? ""));
    sites.add(bare(detailsDomain(c)));
  }
  let staleLeft = 0;
  for (const c of before) {
    if (!sites.has(bare(c.domain ?? "")) || written.has(keyOf(c.domain ?? "", c.path, c.name))) continue;
    await jar.set(expireDetails(c)).catch(() => staleLeft++);
  }
  return { imported: written.size, rejected, staleLeft };
}

/** 고른 사이트의 로그인을 세션으로 가져온다. 키체인을 거절하면 던진다. */
export async function importCookies(
  source: ImportSource,
  hosts: string[],
  ses: Session,
): Promise<{ imported: number; failed: number; rejected: number; partitioned: number; staleLeft: number }> {
  const key = chromeKey(await keychainPassword(source.browser));
  const { cookies, failed, partitioned } = readCookies(source.cookies, hosts, key);
  return { ...(await replaceCookies(ses.cookies, cookies)), failed, partitioned };
}
