import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./persistence";
import { SearchIndex } from "./search-index";

test("SearchIndex: 안 바뀐 파일은 다시 읽지 않고, 바뀌면 다시 파싱하며, 지워지면 캐시를 버린다", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-sidx-"));
  const store = new Store(dir);
  const idx = new SearchIndex(store);
  const user = (id: string, text: string, ts: number) => ({ type: "user_message" as const, id, ts, text }) as never;
  store.appendEvent("t1", user("u1", "첫 번째 질문 Hello", 1));
  store.appendEvent("t1", { type: "text_delta", blockId: "b1", ts: 2, text: "World " } as never);
  store.appendEvent("t1", { type: "text_delta", blockId: "b1", ts: 2, text: "wide" } as never);
  // 버퍼만 있고 파일이 없어도 threadStat 이 먼저 내린다
  assert.deepEqual(idx.search("t1", "hello").map((h) => h.blockId), ["u1"]);
  assert.equal(idx.parses, 1);
  assert.deepEqual(idx.search("t1", "WORLD WIDE").map((h) => h.blockId), ["b1"], "스트리밍 조각은 합쳐서 맞춘다");
  assert.equal(idx.parses, 1, "파일이 그대로면 다시 읽지 않는다");
  store.appendEvent("t1", user("u2", "두 번째", 3));
  assert.deepEqual(idx.search("t1", "두 번째").map((h) => h.blockId), ["u2"]);
  assert.equal(idx.parses, 2, "append 뒤에는 한 번 다시 읽는다");
  idx.search("t1", "x");
  assert.equal(idx.parses, 2);
  assert.deepEqual(idx.search("t2", "hello"), [], "없는 스레드는 빈 결과");
  assert.equal(idx.size, 1);
  store.deleteThread("t1");
  assert.deepEqual(idx.search("t1", "hello"), []);
  assert.equal(idx.size, 0, "파일이 사라지면 캐시도 버린다");
  rmSync(dir, { recursive: true, force: true });
});

test("SearchIndex: 예산을 넘으면 오래 안 쓴 탭부터 비우고, retain 은 모델에 없는 탭을 버린다", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-sidx2-"));
  const store = new Store(dir);
  const big = "x".repeat(1000);
  for (const t of ["a", "b", "c"]) store.appendEvent(t, { type: "user_message", id: `u-${t}`, ts: 1, text: `${t} ${big}` } as never);
  const idx = new SearchIndex(store, 2500); // 탭 하나가 ~2000 문자(원문+소문자)
  idx.search("a", "a");
  idx.search("b", "b");
  assert.equal(idx.size, 1, "둘째를 넣으면 첫째가 밀려난다");
  assert.ok(idx.cachedChars <= 2500 || idx.size === 1);
  idx.search("a", "a"); // a 다시 읽음(parses 증가), b 밀려남
  assert.equal(idx.parses, 3);
  idx.retain(["b"]);
  assert.equal(idx.size, 0);
  assert.equal(idx.cachedChars, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("SearchIndex: oversized tabs remain searchable without retaining their index", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wb-sidx-large-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.appendEvent("small", { type: "user_message", id: "small-1", ts: 1, text: "another tab" });
  for (let i = 0; i < 6; i++) {
    store.appendEvent("large", { type: "tool_result", toolUseId: `tool-${i}`, ts: i, output: "x".repeat(2 * 1024 * 1024), isError: false });
  }
  store.appendEvent("large", { type: "user_message", id: "large-last", ts: 8, text: "last search target" });
  const idx = new SearchIndex(store, 2000);
  assert.equal(idx.search("small", "another")[0]?.blockId, "small-1");
  const smallChars = idx.cachedChars;
  assert.equal(idx.search("large", "last search target")[0]?.blockId, "large-last");
  assert.equal(idx.cachedChars, smallChars);
  assert.equal(idx.size, 1);
  assert.equal(idx.search("large", "last search target")[0]?.blockId, "large-last");
  assert.equal(idx.parses, 3);
});
