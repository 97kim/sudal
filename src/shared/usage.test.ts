import { test } from "node:test";
import assert from "node:assert/strict";
import {
  costOf,
  dayKey,
  DEFAULT_PRICING,
  pctChange,
  periodRange,
  resolvePrice,
  summarizeUsage,
  usageCsv,
  type UsageRecord,
} from "./usage";

const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = day(2026, 9, 4, 15);

function rec(o: Partial<UsageRecord>): UsageRecord {
  return {
    ts: NOW,
    provider: "claude",
    model: "claude-opus-5",
    cwd: "/r/a",
    sessionId: "s1",
    input: 100,
    output: 50,
    cacheRead: 1000,
    cacheWrite: 0,
    requests: 1,
    ...o,
  };
}

test("resolvePrice: 부분 문자열 매치, 순서 우선, 모르는 모델은 null", () => {
  assert.equal(resolvePrice("claude-opus-5")?.label, "Claude Opus 5");
  assert.equal(resolvePrice("claude-haiku-4-5-20251001")?.label, "Claude Haiku 4.5");
  assert.equal(resolvePrice("claude-fable-5-1")?.label, "Claude Fable 5.1");
  assert.equal(resolvePrice("claude-fable-5")?.label, "Claude Fable 5");
  assert.equal(resolvePrice("gpt-5.3-codex")?.label, "GPT-5 Codex");
  assert.equal(resolvePrice("gpt-5.5")?.label, "GPT-5.5");
  assert.equal(resolvePrice("gpt-6.1-sol")?.label, "GPT-6.1 Sol");
  assert.equal(resolvePrice("gpt-6-sol")?.label, "GPT-6 Sol");
  assert.equal(resolvePrice("gpt-5.4-mini")?.label, "GPT-5.4 mini", "짧은 이름(gpt-5.4)에 먼저 잡히지 않는다");
  assert.equal(resolvePrice("gpt-6.1-sol")?.estimated, undefined, "공식 가격");
  assert.equal(resolvePrice("<synthetic>"), null);
});

test("costOf: MTok 단가 적용", () => {
  const p = resolvePrice("claude-opus-5")!;
  // 1M 입력 + 1M 출력 + 1M 캐시읽기 = 5 + 25 + 0.5
  assert.equal(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, p), 30.5);
});

test("dayKey / periodRange 는 로컬 시간 기준", () => {
  assert.equal(dayKey(day(2026, 9, 4, 0)), "2026-09-04");
  assert.equal(dayKey(day(2026, 9, 4, 23)), "2026-09-04");
  const r7 = periodRange("7d", NOW);
  assert.equal(dayKey(r7.from), "2026-08-29");
  assert.equal(r7.to, NOW);
  assert.equal(dayKey(periodRange("month", NOW).from), "2026-09-01");
  assert.equal(dayKey(periodRange("today", NOW).from), "2026-09-04");
});

test("summarizeUsage: 합계·일별(빈 날 채움)·모델·워크스페이스·세션·소스·직전기간", () => {
  const records: UsageRecord[] = [
    rec({ ts: day(2026, 9, 4, 10), sessionId: "s1", cwd: "/r/a" }),
    rec({ ts: day(2026, 9, 3, 10), sessionId: "s2", cwd: "/r/b", model: "claude-haiku-4-5", input: 10, output: 10, cacheRead: 0 }),
    rec({ ts: day(2026, 9, 3, 11), sessionId: "s3", cwd: "/r/b", provider: "codex", model: "gpt-5.3-codex", input: 1000, output: 100, cacheRead: 500 }),
    rec({ ts: day(2026, 8, 30, 10), sessionId: "old", cwd: "/r/a" }), // 직전 기간
    rec({ ts: day(2026, 9, 4, 14), sessionId: "s4", model: "mystery-model" }), // 가격 없음
  ];
  const f = periodRange("today", NOW);
  const filter = { from: day(2026, 9, 2, 0), to: NOW, provider: "all" as const };
  const s = summarizeUsage(records, filter, { inAppSessionIds: new Set(["s1"]), now: NOW });

  assert.equal(s.totals.requests, 4);
  assert.equal(s.totals.input, 100 + 10 + 1000 + 100);
  assert.deepEqual(s.totals.unpricedModels, ["mystery-model"]);
  // opus: (100*5 + 50*25 + 1000*0.5)/1e6 = 0.00225 ; haiku: (10*1+10*5)/1e6=0.00006 ; codex: (1000*1.25+100*10+500*0.125)/1e6=0.0023125
  assert.ok(Math.abs(s.totals.costUsd - (0.00225 + 0.00006 + 0.0023125)) < 1e-9);

  assert.deepEqual(s.daily.map((d) => d.day), ["2026-09-02", "2026-09-03", "2026-09-04"]);
  assert.equal(s.daily[0].requests, 0);
  assert.equal(s.daily[1].requests, 2);

  assert.equal(s.byModel[0].model, "gpt-5.3-codex");
  assert.equal(s.byModel[0].estimated, true);
  assert.equal(s.byModel.find((m) => m.model === "mystery-model")?.priced, false);

  assert.equal(s.byWorkspace[0].name, "b");
  assert.equal(s.byWorkspace[0].sessions, 2);
  assert.ok(Math.abs(s.byWorkspace.reduce((a, w) => a + w.share, 0) - 1) < 1e-9);

  assert.equal(s.topSessions[0].sessionId, "s3");
  assert.equal(s.topSessions.find((x) => x.sessionId === "s1")?.inApp, true);
  assert.equal(s.sources.inApp.requests, 1);
  assert.equal(s.sources.terminal.requests, 3);

  // 직전 기간(같은 길이) 에는 8/30 레코드 1개
  assert.equal(s.previous.requests, 1);
  // 최근 5시간: 10시(5시간 전)와 14시 → 15시 기준 10시는 정확히 5h 전이라 포함, 14시 포함
  assert.equal(s.last5h.requests, 2);
  void f;
});

test("summarizeUsage: provider / cwd 필터", () => {
  const records: UsageRecord[] = [
    rec({ sessionId: "a", cwd: "/x" }),
    rec({ sessionId: "b", cwd: "/y", provider: "codex", model: "gpt-5.4" }),
  ];
  const base = { from: day(2026, 9, 4, 0), to: NOW };
  assert.equal(summarizeUsage(records, { ...base, provider: "codex" }, { now: NOW }).totals.requests, 1);
  assert.equal(summarizeUsage(records, { ...base, cwd: "/x" }, { now: NOW }).totals.requests, 1);
  assert.equal(summarizeUsage(records, { ...base, provider: "all" }, { now: NOW }).totals.requests, 2);
});

test("pctChange / usageCsv", () => {
  assert.equal(pctChange(120, 100), 20);
  assert.equal(pctChange(5, 0), null);
  const csv = usageCsv([rec({ cwd: '/a,"b"' })], { from: 0, to: NOW + 1 }, DEFAULT_PRICING);
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^timestamp,provider,model/);
  assert.match(lines[1], /"\/a,""b"""/);
  assert.match(lines[1], /0\.002250$/);
});

test("가격표: 공식 가격표와 같고, 버전이 겹치는 id 는 더 구체적인 쪽이 먼저 잡힌다", () => {
  const p = (id: string) => resolvePrice(id);
  assert.deepEqual([p("claude-opus-5-5")?.label, p("claude-opus-5-5")?.input, p("claude-opus-5-5")?.cacheRead], ["Claude Opus 5.5", 4, 0.2]);
  assert.equal(p("claude-opus-5")?.label, "Claude Opus 5");
  assert.deepEqual([p("claude-fable-5-1")?.cacheRead, p("claude-fable-5")?.cacheRead], [0.25, 1], "Fable 5.1 캐시 읽기는 0.025x");
  assert.deepEqual([p("claude-sonnet-5")?.input, p("claude-sonnet-5")?.output], [2, 10], "Sonnet 5 는 $2/$10 이 정가로 굳었다");
  assert.deepEqual([p("claude-opus-4-8")?.input, p("claude-opus-4-5")?.input, p("claude-opus-4-1")?.input], [5, 5, 15], "Opus 4.5 부터 $5");
});


test("Argon uses official Standard API conversion rates including cached input", () => {
  for (const model of ["gemini-4-argon", "gemini-4-argon-medium", "gemini-4-argon-high"]) {
    const price = resolvePrice(model)!;
    assert.deepEqual([price.input, price.output, price.cacheRead, price.cacheWrite], [2, 10, 0.1, 0]);
    assert.notEqual(price.estimated, true);
    const cost = costOf({ input: 600_000, output: 100_000, cacheRead: 400_000, cacheWrite: 0 }, price);
    assert.ok(Math.abs(cost - 2.24) < 1e-9);
  }
});
