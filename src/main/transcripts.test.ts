import { test } from "node:test";
import assert from "node:assert/strict";
import { codexRateLimitFromAppServer, compactRecords, parseClaudeLines, parseCodexLines } from "./transcripts";

const claudeLine = (o: { id: string; model?: string; ts: string; usage: Record<string, number>; cwd?: string; sessionId?: string }) =>
  JSON.stringify({
    type: "assistant",
    cwd: o.cwd ?? "/repo",
    sessionId: o.sessionId ?? "sess-1",
    timestamp: o.ts,
    message: { id: o.id, model: o.model ?? "claude-opus-5", role: "assistant", usage: o.usage },
  });

test("parseClaudeLines: usage 합산, 같은 message.id 는 최종본 하나만, synthetic 제외, 깨진 줄 무시", () => {
  const lines = [
    claudeLine({ id: "m1", ts: "2026-09-04T01:00:00Z", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } }),
    claudeLine({ id: "m1", ts: "2026-09-04T01:00:01Z", usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } }),
    claudeLine({ id: "m2", ts: "2026-09-04T01:10:00Z", usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    claudeLine({ id: "m3", model: "<synthetic>", ts: "2026-09-04T01:11:00Z", usage: { input_tokens: 0, output_tokens: 0 } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    "{broken json",
  ];
  const { records } = parseClaudeLines(lines);
  assert.equal(records.length, 1); // 같은 시간 버킷 → 1개로 압축
  const r = records[0];
  assert.equal(r.provider, "claude");
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.requests, 2);
  assert.equal(r.input, 13);
  assert.equal(r.output, 57); // m1 최종본 50 + m2 7
  assert.equal(r.cacheRead, 100);
  assert.equal(r.cacheWrite, 20);
  assert.equal(r.cwd, "/repo");
  assert.equal(r.sessionId, "sess-1");
});

test("parseClaudeLines: 다른 시간 버킷/모델은 따로", () => {
  const lines = [
    claudeLine({ id: "a", ts: "2026-09-04T01:00:00Z", usage: { input_tokens: 1, output_tokens: 1 } }),
    claudeLine({ id: "b", ts: "2026-09-04T02:00:00Z", usage: { input_tokens: 1, output_tokens: 1 } }),
    claudeLine({ id: "c", ts: "2026-09-04T02:30:00Z", model: "claude-haiku-4-5", usage: { input_tokens: 1, output_tokens: 1 } }),
  ];
  assert.equal(parseClaudeLines(lines).records.length, 3);
});

const codexTc = (ts: string, total: { input_tokens: number; cached_input_tokens: number; output_tokens: number }, usedPercent?: number) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { ...total, reasoning_output_tokens: 0, total_tokens: 0 }, last_token_usage: {}, model_context_window: 258400 },
      rate_limits:
        usedPercent === undefined
          ? null
          : {
              primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1782125337 },
              secondary: { used_percent: usedPercent * 2, window_minutes: 10080, resets_at: 1782600000 },
            },
    },
  });

test("parseCodexLines: 누적값 차분, 캐시 분리, 반복 이벤트 무시, 모델/cwd/session, rate limit", () => {
  const lines = [
    JSON.stringify({ timestamp: "2026-09-04T01:00:00Z", type: "session_meta", payload: { id: "th-1", cwd: "/work" } }),
    JSON.stringify({ timestamp: "2026-09-04T01:00:01Z", type: "turn_context", payload: { model: "gpt-5.5", cwd: "/work" } }),
    codexTc("2026-09-04T01:00:10Z", { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 }, 3),
    codexTc("2026-09-04T01:00:20Z", { input_tokens: 3000, cached_input_tokens: 1200, output_tokens: 80 }, 4),
    codexTc("2026-09-04T01:00:21Z", { input_tokens: 3000, cached_input_tokens: 1200, output_tokens: 80 }, 5), // 반복
    JSON.stringify({ timestamp: "2026-09-04T01:00:30Z", type: "response_item", payload: { type: "message" } }),
  ];
  const { records, rateLimit } = parseCodexLines(lines);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.provider, "codex");
  assert.equal(r.model, "gpt-5.5");
  assert.equal(r.cwd, "/work");
  assert.equal(r.sessionId, "th-1");
  assert.equal(r.requests, 2);
  // 1차: input 1000-200=800, cached 200, out 50 / 2차: input 2000-1000=1000, cached 1000, out 30
  assert.equal(r.input, 1800);
  assert.equal(r.cacheRead, 1200);
  assert.equal(r.output, 80);
  assert.deepEqual(rateLimit, {
    session: { usedPercent: 5, windowMinutes: 300, resetsAt: 1782125337 },
    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: 1782600000 },
    modelWeekly: null,
    observedAt: Date.parse("2026-09-04T01:00:21Z"),
  });
});

test("parseCodexLines: turn_context 없이 오면 모델은 codex-unknown", () => {
  const lines = [codexTc("2026-09-04T01:00:10Z", { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 })];
  assert.equal(parseCodexLines(lines).records[0].model, "codex-unknown");
});

test("compactRecords: 같은 세션·모델·시간 버킷을 합친다", () => {
  const base = { provider: "claude" as const, model: "m", cwd: "/", sessionId: "s", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 };
  const t = Date.parse("2026-09-04T05:00:00Z");
  const out = compactRecords([
    { ...base, ts: t + 1000 },
    { ...base, ts: t + 2000 },
    { ...base, ts: t + 3_600_000 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].requests, 2);
  assert.equal(out[0].ts, t);
});

test("codexRateLimitFromAppServer: app-server 한도 응답을 창 길이로 세션·주간에 나누고, codex 한도를 먼저 쓴다", () => {
  const snap = (p: number, s: number) => ({
    primary: { usedPercent: p, windowDurationMins: 300, resetsAt: 1700000000 },
    secondary: { usedPercent: s, windowDurationMins: 10080, resetsAt: 1700500000 },
  });
  const r = codexRateLimitFromAppServer({ rateLimits: snap(1, 2), rateLimitsByLimitId: { codex: snap(12, 34) } }, 99);
  assert.deepEqual(r, {
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: 1700000000 },
    weekly: { usedPercent: 34, windowMinutes: 10080, resetsAt: 1700500000 },
    modelWeekly: null,
    observedAt: 99,
  });
  // 여러 한도가 없으면 예전 단일 값, 주간 창만 있는 플랜은 primary 가 주간
  const old = codexRateLimitFromAppServer({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: null }, secondary: null }, rateLimitsByLimitId: null }, 1);
  assert.deepEqual([old?.session, old?.weekly?.usedPercent, old?.weekly?.resetsAt], [null, 5, 0]);
  assert.equal(codexRateLimitFromAppServer({ rateLimits: { primary: null, secondary: null } }, 1), null);
  assert.equal(codexRateLimitFromAppServer(null, 1), null);
});
