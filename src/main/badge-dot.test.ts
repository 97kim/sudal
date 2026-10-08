import { test } from "node:test";
import assert from "node:assert/strict";
import { dotBitmap } from "./badge-dot";

test("dotBitmap: 가운데는 불투명한 빨강(BGRA), 모서리는 투명", () => {
  const b = dotBitmap(16);
  assert.equal(b.length, 16 * 16 * 4);
  const px = (x: number, y: number) => [...b.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
  assert.deepEqual(px(8, 8), [0x30, 0x3b, 0xff, 0xff]);
  assert.deepEqual(px(0, 0), [0, 0, 0, 0]);
});
