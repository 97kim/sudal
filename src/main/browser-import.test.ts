import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Cookie, CookiesSetDetails } from "electron";
import { chromeKey, chromeTimeToUnix, decryptValue, listSites, listSources, readCookies, replaceCookies } from "./browser-import";

const key = chromeKey("test-password");
// Chrome macOS 와 같은 방식으로 암호화: v10 + AES-128-CBC(IV 공백 16개), 버전 24 는 sha256(host_key) 를 앞에 붙인다.
const enc = (host: string, value: string | Buffer, withHash = true) => {
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([withHash ? createHash("sha256").update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
};
// 2030-01-01 의 Chrome 시각(1601 부터 마이크로초)
const T2030 = (1893456000 + 11644473600) * 1e6;

function fixture(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "wb-import-"));
  const db = join(dir, "Cookies");
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('version','24');");
  d.exec("CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER, top_frame_site_key TEXT DEFAULT '')");
  const ins = d.prepare("INSERT INTO cookies(host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite) VALUES(?,?,?,?,?,?,?,?,?,?)");
  ins.run(".staging.myapp.com", "sid", "", enc(".staging.myapp.com", "abc123"), "/", T2030, 1, 1, 1, 1);
  ins.run("staging.myapp.com", "__Host-csrf", "", enc("staging.myapp.com", "tok"), "/", 0, 1, 0, 0, 2);
  ins.run("admin.myapp.com", "pref", "plain", Buffer.alloc(0), "/app", 0, 0, 0, 0, -1);
  ins.run("github.com", "user", "", enc("github.com", "nope"), "/", 0, 1, 1, 0, 0);
  ins.run("broken.example", "x", "", Buffer.from("v10garbage"), "/", 0, 0, 0, 0, 0);
  ins.run("admin.myapp.com", "empty", "", Buffer.alloc(0), "/", 0, 0, 0, 0, 0);
  ins.run("admin.myapp.com", "latin", "", enc("admin.myapp.com", Buffer.from([0xff, 0xfe])), "/", 0, 0, 0, 0, 0);
  ins.run(".google.com", "SID", "", enc(".google.com", "g"), "/", 0, 1, 1, 0, 0);
  // 최상위 사이트별로 나뉜 쿠키 — 격리를 옮길 수 없어 가져오지 않는다
  d.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("staging.myapp.com", "embed", "z", Buffer.alloc(0), "/", 0, 1, 0, 0, 0, "https://other.example");
  d.close();
  return { dir, db };
}

test("decryptValue: 버전 24 는 호스트 해시를 떼고, 옛 버전은 그대로", () => {
  assert.equal(decryptValue(enc(".a.com", "hello"), key, ".a.com", 24), "hello");
  assert.equal(decryptValue(enc(".a.com", "\uFEFFtok"), key, ".a.com", 24), "\uFEFFtok", "맨 앞 U+FEFF 도 값이다");
  assert.equal(decryptValue(enc(".a.com", "hello", false), key, ".a.com", 23), "hello");
  assert.equal(decryptValue(Buffer.from("plain"), key, ".a.com", 24), null);
  // 버전 24 인데 해시가 안 맞으면(키가 틀림·다른 호스트) 실패로 본다
  assert.equal(decryptValue(enc(".a.com", "hello"), key, ".b.com", 24), null);
  assert.equal(decryptValue(enc(".a.com", "hello", false), key, ".a.com", 24), null);
});

test("chromeTimeToUnix: 1601 기준 마이크로초 → 유닉스 초, 0 은 세션 쿠키", () => {
  assert.equal(chromeTimeToUnix(T2030), 1893456000);
  assert.equal(chromeTimeToUnix(0), undefined);
});

test("listSites: 앞의 점을 떼고 사이트별로 센다", () => {
  const { dir, db } = fixture();
  try {
    assert.deepEqual(listSites(db), [
      { host: "admin.myapp.com", count: 3 },
      { host: "staging.myapp.com", count: 3 },
      { host: "broken.example", count: 1 },
      { host: "github.com", count: 1 },
      { host: "google.com", count: 1, blocked: "google" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCookies: 고른 사이트만, __Host- 는 domain 없이, 만료·SameSite 를 옮기고, 못 푼 것은 센다", () => {
  const { dir, db } = fixture();
  try {
    const { cookies, failed, partitioned } = readCookies(db, ["staging.myapp.com", "admin.myapp.com", "broken.example", "google.com"], key);
    assert.equal(failed, 2, "깨진 암호문과 UTF-8 이 아닌 값");
    assert.equal(cookies.some((c) => c.name === "SID"), false, "Google 은 골라도 가져오지 않는다");
    assert.equal(cookies.find((c) => c.name === "empty")?.value, "", "빈 값도 정상 쿠키다");
    assert.equal(partitioned, 1);
    assert.equal(cookies.some((c) => c.name === "embed"), false, "partitioned 쿠키는 빠진다");
    assert.equal(cookies.some((c) => c.name === "user"), false, "고르지 않은 github.com 은 빠진다");
    const sid = cookies.find((c) => c.name === "sid")!;
    assert.deepEqual(sid, { url: "https://staging.myapp.com/", name: "sid", value: "abc123", domain: ".staging.myapp.com", path: "/", secure: true, httpOnly: true, expirationDate: 1893456000, sameSite: "lax" });
    const csrf = cookies.find((c) => c.name === "__Host-csrf")!;
    assert.equal(csrf.domain, undefined);
    assert.equal(csrf.value, "tok");
    assert.equal(csrf.sameSite, "strict");
    const pref = cookies.find((c) => c.name === "pref")!;
    assert.deepEqual([pref.url, pref.value, pref.domain, pref.sameSite], ["http://admin.myapp.com/app", "plain", undefined, "unspecified"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSources: Local State 의 프로필 이름을 쓰고, 쿠키 DB 가 있는 프로필만", () => {
  const base = mkdtempSync(join(tmpdir(), "wb-sources-"));
  try {
    const root = join(base, "Google/Chrome");
    mkdirSync(join(root, "Profile 3", "Network"), { recursive: true });
    mkdirSync(join(root, "Profile 9"), { recursive: true });
    writeFileSync(join(root, "Profile 3", "Network", "Cookies"), "");
    writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 3": { name: "직장" }, "Profile 9": { name: "빈 것" } } } }));
    const s = listSources(base);
    assert.equal(s.length, 1);
    assert.equal(s[0].id, "chrome:Profile 3");
    assert.equal(s[0].label, "Chrome · 직장");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Electron 쿠키 저장소처럼 이름·도메인·경로(+파티션)로 하나를 정하고, 만료된 값을 쓰면 그 하나를 지운다.
 * cookies.set 은 파티션을 줄 수 없어 일반 쿠키에만 닿는다 — partition 이 있는 초기 쿠키는 쓰기로 바뀌지 않는다.
 */
type FakeCookie = Partial<Cookie> & { partition?: string };
function fakeJar(init: FakeCookie[], fail?: (d: CookiesSetDetails) => boolean) {
  const m = new Map<string, FakeCookie>();
  const put = (c: FakeCookie) => m.set(`${c.domain}|${c.path}|${c.name}|${c.partition ?? ""}`, c);
  for (const c of init) put({ path: "/", hostOnly: !c.domain?.startsWith("."), secure: false, httpOnly: false, session: true, sameSite: "unspecified", ...c });
  const jar = {
    // Electron 처럼 매번 복사본을 준다 — 저장된 객체를 그대로 주면 호출한 쪽의 스냅샷이 함께 바뀐다.
    get: async () => [...m.values()].map((c) => ({ ...c })),
    set: async (d: CookiesSetDetails) => {
      if (fail?.(d)) throw new Error("rejected");
      const c = { domain: d.domain ?? new URL(d.url).hostname, hostOnly: !d.domain, path: d.path || "/", name: d.name!, value: d.value!, secure: !!d.secure, httpOnly: !!d.httpOnly, session: d.expirationDate === undefined, expirationDate: d.expirationDate, sameSite: d.sameSite ?? "unspecified" } as Cookie;
      if (d.expirationDate !== undefined && d.expirationDate < Date.now() / 1000) m.delete(`${c.domain}|${c.path}|${c.name}|`);
      else put(c);
    },
  };
  const dump = () => [...m.values()].map((c) => `${c.partition ? "[p]" : ""}${c.domain}${c.path}${c.name}=${c.value}`).sort();
  return { jar: jar as unknown as Parameters<typeof replaceCookies>[0], dump };
}

const START = [
  { domain: "a.com", name: "sid", value: "old" },
  { domain: "a.com", name: "stale", value: "old" },
  { domain: ".a.com", name: "pref", value: "old" },
  { domain: "x.a.com", name: "sub", value: "keep" },
  { domain: "b.com", name: "sid", value: "keep" },
];

test("replaceCookies: 써진 사이트는 옛 쿠키를 지우고, 하위·다른 사이트와 하나도 못 쓴 사이트는 그대로", async () => {
  const { jar, dump } = fakeJar(START, (d) => d.url.includes("b.com"));
  const r = await replaceCookies(jar, [
    { url: "http://a.com/", name: "sid", value: "new" },
    { url: "http://b.com/", name: "sid", value: "new" },
  ]);
  assert.deepEqual(r, { imported: 1, rejected: 1, staleLeft: 0 });
  assert.deepEqual(dump(), ["a.com/sid=new", "b.com/sid=keep", "x.a.com/sub=keep"]);
});

test("replaceCookies: 옛 쿠키를 지우다 실패하면 되돌리지 않고 세고, 나머지는 계속 지운다", async () => {
  const { jar, dump } = fakeJar(START, (d) => d.name === "pref" && d.value === "");
  const r = await replaceCookies(jar, [{ url: "http://a.com/", name: "sid", value: "new" }]);
  assert.deepEqual(r, { imported: 1, rejected: 0, staleLeft: 1 });
  assert.deepEqual(dump(), [".a.com/pref=old", "a.com/sid=new", "b.com/sid=keep", "x.a.com/sub=keep"]);
});

test("replaceCookies: 이미 만료된 쿠키는 쓰지 않고, 그 사이트의 로그인도 지우지 않는다", async () => {
  const { jar, dump } = fakeJar(START);
  const r = await replaceCookies(jar, [{ url: "http://a.com/", name: "sid", value: "gone", expirationDate: 1000 }]);
  assert.deepEqual(r, { imported: 0, rejected: 0, staleLeft: 0 });
  assert.deepEqual(dump(), [".a.com/pref=old", "a.com/sid=old", "a.com/stale=old", "b.com/sid=keep", "x.a.com/sub=keep"]);
});

test("replaceCookies: 파티션 쿠키는 건드리지 않고 일반 쿠키로 복제하지도 않는다", async () => {
  const { jar, dump } = fakeJar([...START, { domain: "a.com", name: "chip", value: "c", partition: "https://top.example" }, { domain: "a.com", name: "sid", value: "p", partition: "https://top.example" }]);
  await replaceCookies(jar, [{ url: "http://a.com/", name: "sid", value: "new" }]);
  assert.deepEqual(dump(), ["[p]a.com/chip=c", "[p]a.com/sid=p", "a.com/sid=new", "b.com/sid=keep", "x.a.com/sub=keep"]);
});
