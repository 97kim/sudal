import { test } from "node:test";
import assert from "node:assert/strict";
import { cellRangeFor, createLocateCache, pickCandidate, type CellLike } from "./terminal-links";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 문자열을 셀 배열로. 한글·이모지는 2칸(이모지는 서러게이트 쌍이라 2글자). */
function cells(s: string): CellLike[] {
  const out: CellLike[] = [];
  for (const ch of s) {
    const wide = /[ᄀ-ᇿ㄰-㆏가-힯\u{1f300}-\u{1faff}]/u.test(ch);
    out.push({ chars: ch, width: wide ? 2 : 1 });
    if (wide) out.push({ chars: "", width: 0 });
  }
  return out;
}

test("cellRangeFor: 앞에 한글·이모지가 있어도 셀 좌표가 맞는다", () => {
  const text = "오류 📄 src/a.ts:3 끝";
  const start = text.indexOf("src/a.ts:3");
  const end = start + "src/a.ts:3".length;
  // "오"(1-2) "류"(3-4) " "(5) "📄"(6-7) " "(8) → s 는 9번째 셀
  assert.deepEqual(cellRangeFor(cells(text), start, end), { x1: 9, x2: 9 + "src/a.ts:3".length - 1 });
  assert.deepEqual(cellRangeFor(cells("abc"), 0, 3), { x1: 1, x2: 3 });
  assert.equal(cellRangeFor(cells("abc"), 2, 2), null, "빈 범위");
  assert.equal(cellRangeFor(cells("abc"), 1, 10), null, "줄 밖으로 나가면 없음");
  assert.deepEqual(cellRangeFor(cells("가나"), 1, 2), { x1: 3, x2: 4 }, "넓은 글자 하나는 두 칸");
});

test("createLocateCache: 같은 참조는 한 번만 묻고, 못 찾은 것은 TTL 뒤에 다시 묻는다", async () => {
  const calls: string[] = [];
  const locate = createLocateCache(
    async (ref) => {
      calls.push(ref);
      return ref === "yes.ts" ? ["/r/yes.ts"] : [];
    },
    { missTtlMs: 30 },
  );
  assert.deepEqual(await locate("/r", "yes.ts"), ["/r/yes.ts"]);
  assert.deepEqual(await locate("/r", "yes.ts"), ["/r/yes.ts"]);
  assert.deepEqual(await locate("/r", "no.ts"), []);
  await locate("/r", "no.ts");
  assert.deepEqual(calls, ["yes.ts", "no.ts"], "둘 다 한 번씩");
  await wait(60);
  await locate("/r", "no.ts");
  await locate("/r", "yes.ts");
  assert.deepEqual(calls, ["yes.ts", "no.ts", "no.ts"], "못 찾은 것만 다시 묻는다");
  assert.deepEqual(await locate("/other", "yes.ts"), ["/r/yes.ts"]);
  assert.equal(calls.length, 4, "cwd 가 다르면 따로");
});

test("pickCandidate: 꼬리가 정확히 맞는 후보를, 없으면 첫 후보를", () => {
  assert.equal(pickCandidate([], "a.ts"), null);
  assert.equal(pickCandidate(["/r/x/b/a.ts", "/r/b/a.ts"], "b/a.ts"), "/r/x/b/a.ts", "둘 다 맞으면 첫 후보");
  assert.equal(pickCandidate(["/r/x/a.ts", "/r/src/a.ts"], "./src/a.ts"), "/r/src/a.ts");
  assert.equal(pickCandidate(["/r/x/a.ts", "/r/src/a.ts"], "zzz/a.ts"), "/r/x/a.ts");
});

test("pickCandidate: Windows 경로(\\ 구분)도 꼬리를 맞춘다", () => {
  assert.equal(pickCandidate(["C:\\r\\x\\a.ts", "C:\\r\\src\\a.ts"], "./src/a.ts"), "C:\\r\\src\\a.ts");
  assert.equal(pickCandidate(["C:\\r\\x\\a.ts", "C:\\r\\src\\a.ts"], "src\\a.ts"), "C:\\r\\src\\a.ts");
});
