import { test } from "node:test";
import assert from "node:assert/strict";
import { FAVICON_MAX_BYTES, isFetchableFavicon } from "./browser-favicon";

test("파비콘 주소는 http(s) 만 받는다", () => {
  assert.equal(isFetchableFavicon("https://a.com/favicon.ico"), true);
  assert.equal(isFetchableFavicon("http://127.0.0.1:3000/favicon.png"), true);
  // 이 경로로 받을 이유가 없는 것들 — 화면에서 쓰지 않거나 위험하다.
  assert.equal(isFetchableFavicon("file:///etc/passwd"), false);
  assert.equal(isFetchableFavicon("data:image/png;base64,AAAA"), false);
  assert.equal(isFetchableFavicon("javascript:alert(1)"), false);
  assert.equal(isFetchableFavicon("chrome://favicon/x"), false);
  assert.equal(isFetchableFavicon(""), false);
  assert.equal(isFetchableFavicon("주소아님"), false);
});

test("상한은 아이콘에 맞는 크기다", () => {
  // 파비콘이 128KB 를 넘으면 아이콘이 아니다 — 화면에 그대로 실어 나르는 값이라 상한을 둔다.
  assert.equal(FAVICON_MAX_BYTES, 128 * 1024);
});

test("문서 이미지는 이 PC·사설망 주소를 받지 않는다", async () => {
  const { isPrivateHost } = await import("./browser-favicon");
  for (const h of ["localhost", "a.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.10", "169.254.169.254", "0.0.0.0", "100.64.0.1", "[::1]", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "intranet", "printer.local"])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ["img.shields.io", "raw.githubusercontent.com", "172.32.0.1", "8.8.8.8", "[2606:4700::1111]"])
    assert.equal(isPrivateHost(h), false, h);
});
