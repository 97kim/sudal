import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_MAX, frequentSites, parseHistory, recordVisit, suggest, type HistoryEntry } from "./browser-history";

const e = (url: string, at: number, visits = 1): HistoryEntry => ({ url, at, visits });

test("recordVisit: 같은 주소는 쌓지 않고 횟수만 올린다", () => {
  let h: HistoryEntry[] = [];
  h = recordVisit(h, "http://localhost:3000/", 1);
  h = recordVisit(h, "http://localhost:5173/", 2);
  h = recordVisit(h, "http://localhost:3000/", 3);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], { url: "http://localhost:3000/", at: 3, visits: 2 });
});

test("recordVisit: http(s) 가 아니면 기록하지 않는다", () => {
  assert.deepEqual(recordVisit([], "about:blank", 1), []);
  assert.deepEqual(recordVisit([], "", 1), []);
  assert.deepEqual(recordVisit([], "file:///tmp/a.html", 1), []);
});

test("recordVisit: 상한을 넘으면 오래된 것부터 버린다", () => {
  let h: HistoryEntry[] = [];
  for (let i = 0; i < HISTORY_MAX + 5; i++) h = recordVisit(h, `http://x/${i}`, i);
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0].url, `http://x/${HISTORY_MAX + 4}`);
});

test("suggest: 호스트 첫머리 일치가 가장 위 — 'loc' 로 localhost 를 찾는다", () => {
  const h = [e("http://example.com/local-news", 3), e("http://localhost:3000/", 1)];
  assert.equal(suggest(h, "loc")[0].url, "http://localhost:3000/");
});

test("suggest: 같은 정도면 자주 간 곳, 그다음 최근 순", () => {
  const h = [e("http://localhost:1/", 10, 1), e("http://localhost:2/", 5, 9)];
  assert.equal(suggest(h, "localhost")[0].url, "http://localhost:2/");
  const same = [e("http://localhost:1/", 10, 3), e("http://localhost:2/", 5, 3)];
  assert.equal(suggest(same, "localhost")[0].url, "http://localhost:1/");
});

test("suggest: 이미 그대로 친 주소는 빼고, 안 맞으면 비운다", () => {
  const h = [e("http://localhost:3000/", 1)];
  assert.deepEqual(suggest(h, "http://localhost:3000/"), []);
  assert.deepEqual(suggest(h, "존재하지않는것"), []);
  // 빈 검색어면 최근 목록을 그대로 보여 준다.
  assert.equal(suggest(h, "").length, 1);
});

test("suggest: 개수를 넘지 않는다", () => {
  const h = Array.from({ length: 30 }, (_, i) => e(`http://localhost/${i}`, i));
  assert.equal(suggest(h, "localhost").length, 8);
  assert.equal(suggest(h, "localhost", 3).length, 3);
});

test("parseHistory: 모양이 틀린 항목은 조용히 버린다", () => {
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory("{not json"), []);
  assert.deepEqual(parseHistory('{"url":"http://a"}'), []); // 배열이 아님
  assert.deepEqual(
    parseHistory('[{"url":"http://a/","at":1,"visits":2},{"url":"javascript:alert(1)","at":1,"visits":1},{"url":"http://b/"}]'),
    [{ url: "http://a/", at: 1, visits: 2 }],
  );
});

test("frequentSites: 출처별로 묶고, 그 안에서 가장 많이 간 주소를 연다", () => {
  const h = [
    e("http://localhost:3000/a", 5, 2),
    e("https://example.com/", 6, 3),
    e("http://localhost:3000/b", 4, 4),
    e("http://localhost:5173/", 1, 1),
  ];
  assert.deepEqual(frequentSites(h), [
    { origin: "http://localhost:3000", url: "http://localhost:3000/b", visits: 6 },
    { origin: "https://example.com", url: "https://example.com/", visits: 3 },
    { origin: "http://localhost:5173", url: "http://localhost:5173/", visits: 1 },
  ]);
  assert.equal(frequentSites(h, 1).length, 1);
});
