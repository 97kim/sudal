import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CookiesSetDetails, Session } from "electron";
import { cookieFilePath, cookieUrl, encryptPlaintextCookies, legacyCookieFilePath, parseSaved, restoreSessionCookies, saveSessionCookies, toSetDetails, type SavedCookie } from "./browser-cookies";

const c = (o: Partial<SavedCookie>): SavedCookie => ({
  name: "sid", value: "v", domain: "example.com", path: "/", secure: true, httpOnly: true, hostOnly: true, ...o,
});

test("다시 심을 주소: 도메인 앞의 점은 URL 에 넣을 수 없다", () => {
  assert.equal(cookieUrl(c({ domain: ".example.com", path: "/app", secure: true })), "https://example.com/app");
  assert.equal(cookieUrl(c({ domain: "example.com", path: "/", secure: false })), "http://example.com/");
  // path 가 비어도 루트로 본다
  assert.equal(cookieUrl(c({ domain: "a.io", path: "", secure: true })), "https://a.io/");
});

test("호스트 한정 쿠키는 domain 을 주지 않는다 — 주면 하위 도메인까지 퍼진다", () => {
  assert.equal("domain" in toSetDetails(c({ hostOnly: true })), false);
  assert.equal(toSetDetails(c({ hostOnly: false, domain: ".example.com" })).domain, ".example.com");
});

test("만료를 붙이지 않는다 — 붙이면 원래보다 오래 사는 쿠키가 된다", () => {
  assert.equal("expirationDate" in toSetDetails(c({})), false);
});

test("디스크의 값은 믿지 않는다", () => {
  assert.deepEqual(parseSaved("{not json"), []);
  assert.deepEqual(parseSaved('{"name":"a"}'), []);
  const ok = parseSaved('[{"name":"s","value":"v","domain":"a.io","path":"/"},{"name":1},{"value":"x"}]');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, "s");
});

test("저장 파일은 암호문 enc, 예전 평문은 json", () => {
  assert.match(cookieFilePath("/u"), /browser-session-cookies\.enc$/);
  assert.match(legacyCookieFilePath("/u"), /browser-session-cookies\.json$/);
});

test("평문 쿠키 행만 다시 쓰고(파티션 제외), 다 되면 완료 표시를 남겨 다음엔 읽지 않는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-enc-"));
  try {
    const db = new DatabaseSync(path.join(dir, "Cookies"));
    db.exec("CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER, top_frame_site_key TEXT)");
    const ins = db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    ins.run("a.com", "plain", "P", Buffer.alloc(0), "/", 0, 0, 0, 0, 1, "");
    ins.run("a.com", "enc", "", Buffer.from("v10xx"), "/", 0, 0, 0, 0, 1, "");
    ins.run("a.com", "chip", "C", Buffer.alloc(0), "/", 0, 1, 0, 0, 0, "https://top.example");
    db.close();
    const done = path.join(dir, "done");
    const sets: CookiesSetDetails[] = [];
    let fail = true;
    let flushWrites = false;
    const pending: string[] = [];
    // 실제 저장소처럼 set 은 메모리에만, flushStore 때 디스크(DB)를 암호문으로 바꾼다.
    const ses = {
      cookies: {
        set: async (d: CookiesSetDetails) => {
          if (fail) throw new Error("no");
          sets.push(d);
          pending.push(d.name!);
        },
        flushStore: async () => {
          if (!flushWrites) return;
          const w = new DatabaseSync(path.join(dir, "Cookies"));
          for (const n of pending.splice(0)) w.prepare("UPDATE cookies SET value = '', encrypted_value = x'763130' WHERE name = ?").run(n);
          w.close();
        },
      },
    } as unknown as Session;
    assert.equal(await encryptPlaintextCookies(ses, dir, done), 0);
    assert.equal(fs.existsSync(done), false, "실패하면 다음 실행에서 다시 한다");
    fail = false;
    assert.equal(await encryptPlaintextCookies(ses, dir, done), 1);
    assert.equal(fs.existsSync(done), false, "디스크에 아직 평문이 있으면 표시를 남기지 않는다");
    flushWrites = true;
    assert.equal(await encryptPlaintextCookies(ses, dir, done), 1);
    assert.deepEqual(sets.map((d) => `${d.name}=${d.value}`), ["plain=P", "plain=P"]);
    assert.equal(fs.existsSync(done), true);
    assert.equal(await encryptPlaintextCookies(ses, dir, done), 0, "완료 표시가 있으면 읽지 않는다");
    assert.equal(sets.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 모듈 상태(keepBackup)를 바꾸므로 이 파일의 마지막에 둔다.
test("예전 평문 파일을 암호문으로 옮기지 못하면 종료할 때도 지우지 않는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-legacy-"));
  try {
    fs.writeFileSync(legacyCookieFilePath(dir), JSON.stringify([c({})]));
    const ses = { cookies: { set: async () => { throw new Error("no"); }, get: async () => [] } } as unknown as Session;
    assert.equal(await restoreSessionCookies(ses, dir), 0);
    assert.equal(await saveSessionCookies(ses, dir), 0);
    assert.equal(fs.existsSync(legacyCookieFilePath(dir)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
