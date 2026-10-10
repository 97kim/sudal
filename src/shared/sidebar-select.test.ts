import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SELECTION, pruneSelection, rangeSelection, toggleSelection } from "./sidebar-select";

const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();
const order = ["a", "b", "c", "d", "e"];

test("⌘(Ctrl)+클릭은 하나씩 넣고 빼며, 처음엔 보고 있던 탭도 함께 고른다", () => {
  let s = toggleSelection(EMPTY_SELECTION, "c", "a");
  assert.deepEqual(ids(s), ["a", "c"]);
  s = toggleSelection(s, "d", "a");
  assert.deepEqual(ids(s), ["a", "c", "d"]);
  s = toggleSelection(s, "a", "a");
  assert.deepEqual(ids(s), ["c", "d"]);
  // 보고 있던 탭 자신을 ⌘+클릭하면 그것만 고른다
  assert.deepEqual(ids(toggleSelection(EMPTY_SELECTION, "a", "a")), ["a"]);
});

test("Shift+클릭은 기준점부터 범위를 고르고, 다시 Shift+클릭하면 범위를 바꾼다", () => {
  let s = toggleSelection(EMPTY_SELECTION, "b", null);
  s = rangeSelection(s, "d", order, null);
  assert.deepEqual(ids(s), ["b", "c", "d"]);
  s = rangeSelection(s, "a", order, null);
  assert.deepEqual(ids(s), ["a", "b"]);
  // 기준점이 없으면 보고 있던 탭부터
  assert.deepEqual(ids(rangeSelection(EMPTY_SELECTION, "c", order, "e")), ["c", "d", "e"]);
  // 기준점도 보던 탭도 목록에 없으면 그것 하나만
  assert.deepEqual(ids(rangeSelection(EMPTY_SELECTION, "c", order, "zz")), ["c"]);
});

test("지워지거나 안 보이게 된 탭은 선택에서 빠진다", () => {
  const s = rangeSelection(toggleSelection(EMPTY_SELECTION, "a", null), "c", order, null);
  const p = pruneSelection(s, ["b", "c", "d"]);
  assert.deepEqual(ids(p), ["b", "c"]);
  assert.equal(p.anchor, null);
  assert.equal(pruneSelection(p, ["b", "c"]), p, "바뀐 게 없으면 같은 값");
});
