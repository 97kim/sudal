import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { codexRateLimitFromAppServer, compactRecords, parseSudalAgyLines, UsageScanner, parseClaudeLines, parseCodexLines } from "./transcripts";
import { summarizeUsage, usageCsv, type PricingEntry } from "@shared/usage";

const claudeLine = (o: { id: string; model?: string; ts: string; usage: Record<string, unknown>; cwd?: string; sessionId?: string }) =>
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

test("Haiku 5.5 charges each prompt at its own tier after hourly compaction", () => {
  const ts = "2026-11-24T01:00:00Z";
  const lines = [20_000, 20_000, 20_200].map((input_tokens, index) =>
    claudeLine({ id: String(index), model: "claude-haiku-5-5", ts, usage: {
      input_tokens, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 10_000, output_tokens: 1_000,
    } }),
  );
  const { records } = parseClaudeLines(lines);
  assert.deepEqual(records.map(r => [r.longContext, r.requests]), [[false, 2], [true, 1]]);
  const now = Date.parse(ts);
  const filter = { from: now, to: now };
  const summary = summarizeUsage(records, filter, { now });
  assert.equal(summary.byModel[0].label, "Claude Haiku 5.5");
  assert.equal(summary.totals.requests, 3);
  assert.ok(Math.abs(summary.totals.costUsd - (0.0089 + 0.02235)) < 1e-12);
  assert.deepEqual(usageCsv(records, filter).split("\n").slice(1).map(line => line.split(",").at(-1)), ["0.008900", "0.022350"]);
});

test("Claude cache writes keep the one-hour portion through compaction and CSV", () => {
  const ts = "2026-11-24T01:00:00Z";
  const { records } = parseClaudeLines([
    claudeLine({ id: "1h", model: "claude-fable-5-2", ts, usage: {
      cache_creation_input_tokens: 40_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 30_000 },
    } }),
    claudeLine({ id: "legacy", model: "claude-fable-5-2", ts, usage: { cache_creation_input_tokens: 20_000 } }),
  ]);
  const now = Date.parse(ts);
  const filter = { from: now, to: now };
  assert.equal(records.length, 1);
  assert.deepEqual([records[0].cacheWrite, records[0].cacheWrite1h], [60_000, 30_000]);
  assert.equal(summarizeUsage(records, filter, { now }).totals.costUsd, 0.78);
  assert.match(usageCsv(records, filter), /,60000,2,0\.780000$/);
});

const codexTc = (ts: string, total: { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens?: number; output_tokens: number }, usedPercent?: number) =>
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

test("GPT-6.2 applies long-context pricing using each token-count delta including cache hits", () => {
  const ts = "2026-11-24T01:00:00Z";
  const { records } = parseCodexLines([
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.2-astra" } }),
    codexTc(ts, { input_tokens: 272_000, cached_input_tokens: 270_000, output_tokens: 1_000 }),
    codexTc(ts, { input_tokens: 545_000, cached_input_tokens: 540_000, output_tokens: 2_000 }),
  ]);
  assert.deepEqual(records.map(r => [r.longContext, r.input, r.cacheRead]), [[false, 2_000, 270_000], [true, 3_000, 270_000]]);
  const now = Date.parse(ts);
  const filter = { from: now, to: now };
  const summary = summarizeUsage(records, filter, { now });
  assert.equal(summary.byModel[0].label, "GPT-6.2 Astra");
  assert.ok(Math.abs(summary.totals.costUsd - (0.164 + 0.324)) < 1e-12);
  assert.deepEqual(usageCsv(records, filter).split("\n").slice(1).map(line => line.split(",").at(-1)), ["0.164000", "0.324000"]);
});

test("Codex cache writes are billed at the write rate and still count toward context length", () => {
  const ts = "2026-11-24T01:00:00Z";
  const short = { input_tokens: 100_000, cached_input_tokens: 20_000, cache_write_input_tokens: 60_000, output_tokens: 1_000 };
  const { records } = parseCodexLines([
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.2-astra" } }),
    codexTc(ts, short),
    codexTc(ts, short),
    codexTc(ts, { input_tokens: 373_000, cached_input_tokens: 90_000, cache_write_input_tokens: 260_000, output_tokens: 2_000 }),
  ]);
  assert.deepEqual(records.map(r => [r.longContext, r.input, r.cacheRead, r.cacheWrite, r.requests]),
    [[false, 20_000, 20_000, 60_000, 1], [true, 3_000, 70_000, 200_000, 1]]);
  const now = Date.parse(ts);
  const filter = { from: now, to: now };
  assert.equal(summarizeUsage(records, filter, { now }).totals.costUsd, 0.808 + 4.164);
  assert.deepEqual(usageCsv(records, filter).split("\n").slice(1).map(line => line.split(",").at(-1)), ["0.808000", "4.164000"]);
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


test("Antigravity usage reads normalized turns and excludes other providers and zero-usage turns", () => {
  const session = (provider: string) => ({ type: "session", provider, sessionId: "s", cwd: "/repo" });
  const usage = { input: 100, output: 20, cacheRead: 40, cacheWrite: 0 };
  const turn = { type: "turn_result", ts: 1000, numTurns: 1, usage, modelUsage: { argon: usage } };
  const result = parseSudalAgyLines([session("agy"), turn, { ...turn, ts: 2000 }, session("codex"), turn,
    session("agy"), { ...turn, modelUsage: {}, usage: { input: 0 } }].map((value) => JSON.stringify(value)));
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], { ts: 0, provider: "agy", sessionId: "s", cwd: "/repo", model: "argon", input: 120, output: 40, cacheRead: 80, cacheWrite: 0, requests: 2 });
});

test("UsageScanner includes persisted Antigravity history and does not duplicate a rescan", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-agy-usage-"));
  try {
    const threads = path.join(dir, "threads");
    fs.mkdirSync(threads);
    fs.writeFileSync(path.join(threads, "tab.jsonl"), [
      { type: "session", ts: 1, provider: "agy", sessionId: "agy-session", cwd: "/repo" },
      { type: "turn_result", ts: 1000, usage: { input: 100, output: 20 }, modelUsage: {}, numTurns: 1 },
    ].map((value) => JSON.stringify(value)).join("\n"));
    const scanner = new UsageScanner({ claudeDir: path.join(dir, "claude"), codexDir: path.join(dir, "codex"), sudalThreadsDir: threads, cachePath: path.join(dir, "cache.json") });
    await scanner.scan();
    await scanner.scan();
    assert.equal(scanner.records().length, 1);
    assert.equal(scanner.records()[0].input, 100);
    assert.equal(scanner.records()[0].provider, "agy");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner resumes Codex byte ranges across restart, partial lines, and read failures", async t => {
  const { default: fs } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = fs.mkdtempSync(join(tmpdir(), "sudal-codex-usage-resume-"));
  try {
    const codexDir = join(dir, "codex");
    fs.mkdirSync(codexDir);
    const file = join(codexDir, "rollout.jsonl");
    const options = { codexDir, claudeDir: join(dir, "claude"), cachePath: join(dir, "cache.json") };
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "s", cwd: "/원본" } });
    const context = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } });
    const first = codexTc("2026-11-24T01:00:00Z", { input_tokens: 100, cached_input_tokens: 30, output_tokens: 10 }, 4);
    const nextContext = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5", cwd: "/변경" } });
    const next = codexTc("2026-11-24T01:00:01Z", { input_tokens: 155, cached_input_tokens: 45, cache_write_input_tokens: 10, output_tokens: 17 }, 5);
    const repeated = codexTc("2026-11-24T01:00:02Z", { input_tokens: 155, cached_input_tokens: 45, cache_write_input_tokens: 10, output_tokens: 17 }, 6);
    const padding = (JSON.stringify({ type: "tool_result", text: "x".repeat(1024) }) + "\n").repeat(2048);
    fs.writeFileSync(file, [meta, context, first].join("\r\n") + "\r\n" + padding);
    const originalOpen = fs.promises.open;
    let bytes = 0;
    let failAt: number | undefined;
    const tracked = t.mock.method(fs.promises, "open", async (name: string, flags: string) => {
      const handle = await originalOpen(name, flags);
      if (name !== file) return handle;
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (position === failAt) throw new Error("temporary fixture read failure");
        const result = await read(buffer, offset, length, position);
        bytes += result.bytesRead;
        return result;
      });
      return handle;
    });
    const warn = t.mock.method(console, "warn", () => {});
    let scanner = new UsageScanner(options);
    await scanner.scan();
    const boundary = fs.statSync(file).size;
    assert.ok(bytes >= boundary, "initial scan reads the full log");
    assert.deepEqual(scanner.records(), parseCodexLines([meta, context, first]).records);

    const unicode = Buffer.from(nextContext);
    const split = unicode.indexOf(Buffer.from("변")) + 1;
    fs.appendFileSync(file, unicode.subarray(0, split));
    bytes = 0;
    await scanner.scan();
    assert.ok(bytes < 20 * 1024);
    assert.deepEqual(scanner.records(), parseCodexLines([meta, context, first]).records);

    fs.appendFileSync(file, Buffer.concat([unicode.subarray(split), Buffer.from(`\r\n${next}`)]));
    scanner = new UsageScanner(options);
    bytes = 0;
    failAt = boundary;
    await scanner.scan();
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(scanner.records(), parseCodexLines([meta, context, first]).records);
    failAt = undefined;
    bytes = 0;
    await scanner.scan();
    assert.ok(bytes < 20 * 1024, "resuming after restart reads the append plus bounded samples");
    assert.deepEqual(scanner.records(), parseCodexLines([meta, context, first, nextContext, next]).records);

    fs.appendFileSync(file, `\r\n${repeated}\r\n`);
    bytes = 0;
    await scanner.scan();
    const expected = parseCodexLines([meta, context, first, nextContext, next, repeated]);
    assert.ok(bytes < 20 * 1024);
    assert.deepEqual(scanner.records(), expected.records, "a previously unterminated record is counted only once");
    assert.deepEqual(scanner.getStatus().codexRateLimit, expected.rateLimit);
    const filter = { from: Date.parse("2026-11-24T00:00:00Z"), to: Date.parse("2026-11-24T23:59:59Z") };
    assert.equal(usageCsv(scanner.records(), filter), usageCsv(expected.records, filter));
    const opens = tracked.mock.callCount();
    await scanner.scan();
    assert.equal(tracked.mock.callCount(), opens, "unchanged files are not reopened");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner rebuilds replaced, shortened, and rewritten Codex files", async () => {
  const { default: fs } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = fs.mkdtempSync(join(tmpdir(), "sudal-codex-usage-rewritten-"));
  try {
    const codexDir = join(dir, "codex");
    fs.mkdirSync(codexDir);
    const file = join(codexDir, "rollout.jsonl");
    const scanner = new UsageScanner({ codexDir, claudeDir: join(dir, "claude"), cachePath: join(dir, "cache.json") });
    const log = (id: string, tokens: number) => [
      JSON.stringify({ type: "session_meta", payload: { id } }),
      codexTc("2026-11-24T01:00:00Z", { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 1 }, 4),
    ].join("\n") + "\n";
    fs.writeFileSync(file, log("old", 500));
    await scanner.scan();
    fs.renameSync(file, `${file}.old`);
    fs.writeFileSync(file, log("new", 650) + "\n".repeat(512));
    await scanner.scan();
    assert.deepEqual(scanner.records().map(r => [r.sessionId, r.input]), [["new", 650]]);
    fs.writeFileSync(file, log("cut", 90));
    await scanner.scan();
    assert.deepEqual(scanner.records().map(r => [r.sessionId, r.input]), [["cut", 90]]);
    fs.writeFileSync(file, log("regrown", 450) + "\n".repeat(8192));
    await scanner.scan();
    assert.deepEqual(scanner.records().map(r => [r.sessionId, r.input]), [["regrown", 450]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner commits a consistent Codex snapshot when an append or rewrite races with reading", async t => {
  const { default: fs } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = fs.mkdtempSync(join(tmpdir(), "sudal-codex-usage-race-"));
  try {
    const codexDir = join(dir, "codex");
    fs.mkdirSync(codexDir);
    const file = join(codexDir, "rollout.jsonl");
    const cachePath = join(dir, "cache.json");
    const scanner = new UsageScanner({ codexDir, claudeDir: join(dir, "claude"), cachePath });
    const header = (id: string) => JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
    const turn = (tokens: number) => codexTc("2026-11-24T01:00:00Z", { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 5 }, 4) + "\n";
    const rows = () => scanner.records().map(r => [r.sessionId, r.input]);
    const open = fs.promises.open;
    let boundary = 0;
    let update: (() => void) | undefined;
    t.mock.method(fs.promises, "open", async (name: string, flags: string) => {
      const handle = await open(name, flags);
      if (name !== file) return handle;
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (position === boundary && update) {
          const apply = update;
          update = undefined;
          apply();
        }
        return result;
      });
      return handle;
    });
    const warn = t.mock.method(console, "warn", () => {});

    fs.writeFileSync(file, header("original") + turn(100));
    await scanner.scan();
    boundary = fs.statSync(file).size;
    fs.appendFileSync(file, turn(150));
    update = () => fs.appendFileSync(file, turn(200));
    await scanner.scan();
    assert.equal(update, undefined);
    assert.deepEqual(rows(), [["original", 150]], "a safe concurrent append is excluded from this snapshot");
    await scanner.scan();
    assert.deepEqual(rows(), [["original", 200]]);

    const previousCache = fs.readFileSync(cachePath, "utf8");
    const stat = fs.statSync(file, { bigint: true });
    assert.equal(JSON.parse(previousCache).files[file].codex.identity, `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
    boundary = Number(stat.size);
    fs.appendFileSync(file, turn(250));
    update = () => fs.writeFileSync(file, header("replacement") + turn(900) + "\n".repeat(1024));
    await scanner.scan();
    assert.equal(update, undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(rows(), [["original", 200]], "a raced rewrite keeps the last complete aggregate");
    assert.equal(fs.readFileSync(cachePath, "utf8"), previousCache, "the corrupted snapshot cannot seed later scans");
    await scanner.scan();
    assert.deepEqual(rows(), [["replacement", 900]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner upgrades a Codex v5 cache and preserves pricing tiers through append and reclassification", async t => {
  const { default: fs } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = fs.mkdtempSync(join(tmpdir(), "sudal-codex-usage-pricing-"));
  try {
    const codexDir = join(dir, "codex");
    fs.mkdirSync(codexDir);
    const file = join(codexDir, "rollout.jsonl");
    const cachePath = join(dir, "cache.json");
    const cutoff = Date.parse("2026-11-24T01:30:00Z");
    const flat = { match: "gpt-6.2-astra", label: "fixture", input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
    const table: PricingEntry[] = [
      { ...flat, effectiveFrom: cutoff, input: 2, longContext: { inputThreshold: 100_000, input: 4, output: 0, cacheRead: 0, cacheWrite: 0 } },
      flat,
    ];
    const options = { codexDir, claudeDir: join(dir, "claude"), cachePath, pricing: () => table };
    const turn = (ts: number, tokens: number) => codexTc(new Date(ts).toISOString(), { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0 }, 4) + "\n";
    fs.writeFileSync(file, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.2-astra" } }) + "\n" + turn(cutoff - 1, 90_000));
    await new UsageScanner(options).scan();
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    delete cache.files[file].codex;
    cache.files[file].mtimeMs = fs.statSync(file).mtimeMs;
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    const scanner = new UsageScanner(options);
    const open = fs.promises.open;
    const opened = t.mock.method(fs.promises, "open", (name: string, flags: string) => open(name, flags));
    const filter = { from: cutoff - 3_600_000, to: cutoff + 3_600_000 };
    const cost = () => summarizeUsage(scanner.records(), filter, { now: cutoff, pricing: scanner.getPricing().entries }).totals.costUsd.toFixed(6);
    await scanner.scan();
    assert.equal(opened.mock.callCount(), 0, "existing v5 rows remain usable for an unchanged file");
    fs.appendFileSync(file, turn(cutoff, 210_000));
    await scanner.scan();
    assert.equal(cost(), "0.570000");
    assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).files[file].codex.offset, fs.statSync(file).size);
    fs.appendFileSync(file, turn(cutoff + 1, 250_000));
    await scanner.scan();
    assert.equal(cost(), "0.650000");
    table[0].longContext!.inputThreshold = 130_000;
    await scanner.scan();
    assert.equal(cost(), "0.410000");
    assert.deepEqual(usageCsv(scanner.records(), filter, scanner.getPricing().entries).split("\n").slice(1).map(line => line.split(",").at(-1)), ["0.090000", "0.320000"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner retains old totals on read failure and refreshes them later without discarding unaffected files", async t => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-usage-pricing-cache-"));
  try {
    const claude = path.join(dir, "claude");
    const cachePath = path.join(dir, "cache.json");
    fs.mkdirSync(claude);
    const newFile = path.join(claude, "tiered.jsonl");
    const oldFile = path.join(claude, "flat.jsonl");
    const ts = "2026-11-24T01:00:00Z";
    fs.writeFileSync(newFile, [90_000, 110_000].map((input_tokens, index) =>
      claudeLine({ id: String(index), model: "claude-haiku-5-5", ts, usage: { input_tokens } }),
    ).join("\n"));
    fs.writeFileSync(oldFile, "");
    const cached = (file: string, model: string, input: number, requests: number) => {
      const { mtimeMs, size } = fs.statSync(file);
      return { mtimeMs, size, records: [{ ts: Date.parse(ts), provider: "claude", model, cwd: "/repo",
        sessionId: "sess-1", input, output: 0, cacheRead: 0, cacheWrite: 0, requests }] };
    };
    fs.writeFileSync(cachePath, JSON.stringify({ version: 5, files: {
      [newFile]: cached(newFile, "claude-haiku-5-5", 200_000, 2),
      [oldFile]: cached(oldFile, "claude-sonnet-5", 20, 1),
    } }));

    const pricing: PricingEntry[] = [{
      match: "haiku-5-5", label: "custom", input: 1, output: 0, cacheRead: 0, cacheWrite: 0,
      longContext: { inputThreshold: 95_000, input: 4, output: 0, cacheRead: 0, cacheWrite: 0 },
    }];
    const scan = async (custom: boolean) => {
      const scanner = new UsageScanner({ claudeDir: claude, codexDir: path.join(dir, "codex"), cachePath, pricing: () => pricing });
      await scanner.scan();
      assert.equal(scanner.getPricing().custom, custom);
      return scanner.records().map(r => [r.model, r.longContext, r.input]).sort();
    };
    const originalRead = fs.default.createReadStream;
    const failRead = t.mock.method(fs.default, "createReadStream", (file: string, options: Parameters<typeof originalRead>[1]) => {
      if (file !== newFile) return originalRead(file, options);
      return Readable.from((async function* () { throw new Error("temporarily unreadable"); })());
    });
    const warn = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await scan(false), [
      ["claude-haiku-5-5", undefined, 200_000],
      ["claude-sonnet-5", undefined, 20],
    ]);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).pricing, undefined, "failed migration must not publish the new price table");
    failRead.mock.restore();
    const expected = [
      ["claude-haiku-5-5", false, 90_000],
      ["claude-haiku-5-5", true, 110_000],
      ["claude-sonnet-5", undefined, 20],
    ];
    assert.deepEqual(await scan(true), expected);
    assert.deepEqual(await scan(true), expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner publishes usage and changed pricing together for existing logs", async t => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-usage-custom-pricing-"));
  try {
    const claudeDir = path.join(dir, "claude");
    fs.mkdirSync(claudeDir);
    const ts = "2026-11-24T01:00:00Z";
    const file = path.join(claudeDir, "source.jsonl");
    fs.writeFileSync(file, [20_000, 75_000].map((input_tokens, index) =>
      claudeLine({ id: String(index), model: "claude-haiku-5-5", ts, usage: { input_tokens } }),
    ).join("\n"));
    const table: PricingEntry[] = [{
      match: "haiku-5-5", label: "custom", input: 1, output: 0, cacheRead: 0, cacheWrite: 0,
      longContext: { inputThreshold: 100_000, input: 4, output: 0, cacheRead: 0, cacheWrite: 0 },
    }];
    const options = { claudeDir, codexDir: path.join(dir, "codex"), cachePath: path.join(dir, "cache.json"), pricing: () => table };
    const scanner = new UsageScanner(options);
    const now = Date.parse(ts);
    const filter = { from: now, to: now };
    const cost = (view = scanner) => summarizeUsage(view.records(), filter, { now, pricing: view.getPricing().entries }).totals.costUsd;
    const firstScan = scanner.scan();
    table[0].longContext!.inputThreshold = 50_000;
    await scanner.scan(); // Joins the scan in progress at the old threshold.
    await firstScan;
    assert.equal(cost(), 0.095);
    assert.equal(cost(new UsageScanner(options)), 0.095, "restart keeps the price table that produced the cache");

    const originalRead = fs.default.createReadStream;
    const failRead = t.mock.method(fs.default, "createReadStream", (name: string, streamOptions: Parameters<typeof originalRead>[1]) => {
      if (name !== file) return originalRead(name, streamOptions);
      return Readable.from((async function* () { throw new Error("temporarily unreadable"); })());
    });
    t.mock.method(console, "warn", () => {});
    await scanner.scan();
    assert.equal(cost(), 0.095, "failed reclassification keeps the previous amount");
    failRead.mock.restore();

    const refresh = scanner.scan();
    assert.equal(cost(), 0.095, "the current view stays consistent during a scan");
    await refresh;
    assert.equal(cost(), 0.32);
    assert.deepEqual(usageCsv(scanner.records(), filter, scanner.getPricing().entries).split("\n").slice(1).map(line => line.split(",").at(-1)), ["0.020000", "0.300000"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner falls back to default rates when a custom price entry is invalid", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-usage-invalid-pricing-"));
  try {
    const claudeDir = path.join(dir, "claude");
    fs.mkdirSync(claudeDir);
    const ts = "2026-11-24T01:00:00Z";
    fs.writeFileSync(path.join(claudeDir, "source.jsonl"), claudeLine({
      id: "test", model: "claude-haiku-5-5", ts, usage: { input_tokens: 120_000 },
    }));
    const scanner = new UsageScanner({ claudeDir, codexDir: path.join(dir, "codex"), cachePath: path.join(dir, "cache.json"), pricing: () => [{}] });
    await scanner.scan();
    await scanner.scan(); // Exercise the fast path for already cached records too.
    const now = Date.parse(ts);
    assert.equal(scanner.getStatus().scanning, false);
    assert.equal(scanner.getPricing().custom, false);
    assert.equal(summarizeUsage(scanner.records(), { from: now, to: now }, { now, pricing: scanner.getPricing().entries }).totals.costUsd, 0.06);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hourly compaction preserves a custom pricing change within the hour", () => {
  const cutoff = "2026-11-24T01:30:00Z";
  const table: PricingEntry[] = [
    { match: "haiku-5-5", label: "custom", effectiveFrom: Date.parse(cutoff), input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
    { match: "haiku-5-5", label: "custom", input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  const { records } = parseClaudeLines(["2026-11-24T01:29:59Z", cutoff].map((ts, index) =>
    claudeLine({ id: String(index), model: "claude-haiku-5-5", ts, usage: { input_tokens: 20_000 } }),
  ), table);
  const now = Date.parse(cutoff);
  assert.equal(summarizeUsage(records, { from: now - 3_600_000, to: now }, { now, pricing: table }).totals.costUsd, 0.06);
});

test("UsageScanner streams all providers with a heap smaller than the transcript", { timeout: 60_000 }, async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-stream-usage-"));
  try {
    const transcript = path.join(dir, "source.jsonl");
    const fd = fs.openSync(transcript, "w");
    try {
      // CRLF, Korean paths, state separated by many stream chunks, and an EOF
      // without a newline must preserve each provider's accounting rules.
      const head = [
        claudeLine({ id: "message", ts: "2026-09-04T01:00:00Z", cwd: "/한글", usage: { input_tokens: 10, output_tokens: 2 } }),
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd: "/한글" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
        codexTc("2026-09-04T01:00:00Z", { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }, 3),
        JSON.stringify({ type: "session", provider: "agy", sessionId: "agy-session", cwd: "/한글", model: "argon" }),
      ];
      fs.writeSync(fd, head.join("\r\n") + "\r\n");
      const padding = JSON.stringify({ type: "user", content: "가".repeat(22_000) }) + "\r\n";
      const chunk = Buffer.from(padding);
      // 96 MB of history cannot fit in the child's 64 MB V8 heap. Streaming
      // keeps only the current line and usage state, even for the JSON parser.
      for (let bytes = 0; bytes < 96 * 1024 * 1024; bytes += chunk.length) fs.writeSync(fd, chunk);
      fs.writeSync(fd, [
        "{broken json",
        claudeLine({ id: "message", ts: "2026-09-04T01:00:01Z", cwd: "/한글", usage: { input_tokens: 10, output_tokens: 8 } }),
        claudeLine({ id: "message", ts: "2026-09-04T01:00:02Z", cwd: "/한글", usage: { input_tokens: 1, output_tokens: 1 } }),
        codexTc("2026-09-04T01:00:01Z", { input_tokens: 150, cached_input_tokens: 30, output_tokens: 15 }, 4),
        codexTc("2026-09-04T01:00:02Z", { input_tokens: 150, cached_input_tokens: 30, output_tokens: 15 }, 5),
        JSON.stringify({ type: "turn_result", ts: Date.parse("2026-09-04T01:00:02Z"), numTurns: 2, usage: { input: 100, output: 20, cacheRead: 40 }, modelUsage: {} }),
      ].join("\r\n"));
    } finally { fs.closeSync(fd); }
    for (const root of ["claude", "codex", "threads"]) {
      fs.mkdirSync(path.join(dir, root));
      fs.linkSync(transcript, path.join(dir, root, "history.jsonl"));
    }
    const script = `
      import { UsageScanner } from ${JSON.stringify(new URL("./transcripts.ts", import.meta.url).href)};
      import path from 'node:path';
      const dir = process.argv[1];
      const scanner = new UsageScanner({ claudeDir: path.join(dir, 'claude'), codexDir: path.join(dir, 'codex'), sudalThreadsDir: path.join(dir, 'threads'), cachePath: path.join(dir, 'cache.json') });
      await scanner.scan();
      await scanner.scan();
      console.log(JSON.stringify({ records: scanner.records(), rateLimit: scanner.getStatus().codexRateLimit }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--max-old-space-size=64", "--import", "tsx", "--input-type=module", "--eval", script, dir],
      { timeout: 55_000, maxBuffer: 64 * 1024 });
    const { records, rateLimit } = JSON.parse(stdout);
    assert.equal(records.length, 3);
    const usage = (provider: string) => records.find((r: { provider: string }) => r.provider === provider);
    assert.deepEqual(usage("claude"), { ts: Date.parse("2026-09-04T01:00:00Z"), provider: "claude", model: "claude-opus-5", cwd: "/한글", sessionId: "sess-1", input: 10, output: 8, cacheRead: 0, cacheWrite: 0, requests: 1 });
    assert.deepEqual(usage("codex"), { ts: Date.parse("2026-09-04T01:00:00Z"), provider: "codex", model: "gpt-5.5", cwd: "/한글", sessionId: "codex-session", input: 120, output: 15, cacheRead: 30, cacheWrite: 0, requests: 2 });
    assert.deepEqual(usage("agy"), { ts: Date.parse("2026-09-04T01:00:00Z"), provider: "agy", model: "argon", cwd: "/한글", sessionId: "agy-session", input: 60, output: 20, cacheRead: 40, cacheWrite: 0, requests: 2 });
    assert.equal(rateLimit.session.usedPercent, 5, "반복 token_count 도 최신 한도는 갱신한다");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner watches the first Antigravity conversation in a new profile", { timeout: 8000 }, async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-first-usage-"));
  const threads = path.join(dir, "threads");
  let changed!: () => void;
  const scanned = new Promise<void>((resolve) => { changed = resolve; });
  const scanner = new UsageScanner({ claudeDir: path.join(dir, "claude"), codexDir: path.join(dir, "codex"), sudalThreadsDir: threads, cachePath: path.join(dir, "cache.json"), pollIntervalMs: 100, onChange: () => changed() });
  try {
    scanner.watch();
    fs.writeFileSync(path.join(threads, "first.jsonl"), [
      { type: "session", ts: 1, provider: "agy", sessionId: "first", cwd: "/repo" },
      { type: "turn_result", ts: 1000, usage: { input: 100, output: 20 }, numTurns: 1 },
    ].map((value) => JSON.stringify(value)).join("\n"));
    await scanned;
    assert.equal(scanner.records()[0]?.input, 100);
  } finally {
    scanner.unwatch();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
