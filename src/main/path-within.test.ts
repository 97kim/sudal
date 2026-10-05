import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithin } from "./path-within";

test("isWithin: 자기 자신과 그 안은 안쪽이다", () => {
  assert.equal(isWithin("/repo", "/repo"), true);
  assert.equal(isWithin("/repo", "/repo/src/a.ts"), true);
});

test("isWithin: 위로 나가거나 옆 폴더면 바깥이다", () => {
  assert.equal(isWithin("/repo", "/"), false);
  assert.equal(isWithin("/repo", "/repo-b/a.ts"), false);
  assert.equal(isWithin("/repo/src", "/repo/other"), false);
});

test("isWithin: '..' 로 시작하는 이름의 하위 폴더는 안쪽이다", () => {
  assert.equal(isWithin("/repo", "/repo/..cache/a"), true);
  assert.equal(isWithin("/repo", "/repo/...md"), true);
});
