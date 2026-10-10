import { test } from "node:test";
import assert from "node:assert/strict";
import { browserErrorKind } from "./browser-error";

test("browserErrorKind: Chromium 오류 이름을 할 일로 묶는다", () => {
  assert.equal(browserErrorKind("ERR_CONNECTION_REFUSED"), "refused");
  assert.equal(browserErrorKind("ERR_NAME_NOT_RESOLVED"), "notFound");
  assert.equal(browserErrorKind("ERR_INTERNET_DISCONNECTED"), "offline");
  assert.equal(browserErrorKind("ERR_CONNECTION_TIMED_OUT"), "timeout");
  assert.equal(browserErrorKind("ERR_CERT_AUTHORITY_INVALID"), "cert");
  assert.equal(browserErrorKind("ERR_UNSAFE_PORT"), "blocked");
  assert.equal(browserErrorKind("ERR_BLOCKED_BY_CLIENT"), "blocked");
  assert.equal(browserErrorKind("ERR_FAILED"), "generic");
});
