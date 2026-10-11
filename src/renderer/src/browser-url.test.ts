import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "./browser-url";
import { webSearchUrl } from "@shared/web-search";

test("normalizeUrl: 포트가 붙은 호스트는 스킴이 아니라 주소로, 진짜 스킴은 막고, 공백은 검색으로", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("localhost:3000/app?x=1"), "http://localhost:3000/app?x=1");
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeUrl("example.com:8443/path"), "https://example.com:8443/path");
  assert.equal(normalizeUrl("localhost"), "http://localhost");
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://a.b/c"), "http://a.b/c");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  assert.equal(normalizeUrl("chrome://settings"), null);
  assert.equal(normalizeUrl("react hooks 사용법"), webSearchUrl("react hooks 사용법"));
  assert.equal(normalizeUrl("react hooks 사용법"), "https://www.google.com/search?q=react%20hooks%20%EC%82%AC%EC%9A%A9%EB%B2%95");
  // 점도 포트도 없는 한 단어는 검색, 점이 있으면 주소
  assert.equal(normalizeUrl("react"), webSearchUrl("react"));
  assert.equal(normalizeUrl("수달"), webSearchUrl("수달"));
  assert.equal(normalizeUrl("github.com/97kim"), "https://github.com/97kim");
  assert.equal(normalizeUrl("intranet:8080"), "https://intranet:8080");
  assert.equal(normalizeUrl("   "), null);
});
