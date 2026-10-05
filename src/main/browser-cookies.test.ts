import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieFilePath, cookieUrl, encryptedCookieFilePath, parseSaved, toSetDetails, type SavedCookie } from "./browser-cookies";

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

test("저장 파일은 평문 json, 암호화하던 시절 파일은 이름이 달라 따로 지울 수 있다", () => {
  assert.match(cookieFilePath("/u"), /browser-session-cookies\.json$/);
  assert.match(encryptedCookieFilePath("/u"), /browser-session-cookies\.enc$/);
  assert.notEqual(cookieFilePath("/u"), encryptedCookieFilePath("/u"));
});
