import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PERF_LOG_FILE, PerformanceDiagnostics } from "./performance-diagnostics";

test("performance diagnostics keep only fixed fields and rate-limit tall observations", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sudal-perf-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const privateContent = "private project source and prompt";
  let now = 0;
  const monitor = new PerformanceDiagnostics(dir, {
    now: () => now,
    processMetrics: () => Array.from({ length: 14 }, (_, i) => ({
      pid: i + 5,
      type: i === 13 ? privateContent : "Tab",
      memory: { workingSetSize: 10_000 + i * 100, privateBytes: 1_000 },
    })),
  });
  monitor.observe("chat-dispatch", 1, { bytes: 9 });
  monitor.observe("chat-dispatch", 3, { bytes: 8 * 1024 * 1024 });
  monitor.observe("chat-dispatch", 14, { bytes: 8 * 1024 * 1024 });
  now += 1_100;
  const fields = { bytes: 5_000, reason: privateContent, detail: privateContent };
  monitor.observe("usage-cache-save", 125.4, fields);
  monitor.record("renderer-gone", undefined, { pid: 19, reason: "oom", exitCode: -1 });
  monitor.record("turn-result", 2826, { bytes: Infinity });
  await monitor.settle();
  const raw = await readFile(join(dir, PERF_LOG_FILE), "utf8");
  assert.ok(!raw.includes(privateContent));
  const rows = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.phase), ["chat-dispatch", "usage-cache-save", "renderer-gone", "turn-result"]);
  assert.equal(rows[0].bytes, 8 * 1024 * 1024);
  assert.equal(rows[0].processes.length, 12);
  assert.equal(rows[0].processes[0].type, "Unknown");
  assert.equal(rows[0].processes[0].workingSetKiB, 11_300);
  assert.equal(rows[1].reason, "other");
  assert.equal(rows[1].durationMs, 125);
  assert.equal(rows[2].reason, "oom");
  assert.equal(rows[2].exitCode, -1);
  assert.equal(rows[3].bytes, undefined);
  assert.equal(rows[3].processes, undefined);
});

test("only one rotation is kept, with both diagnostics files bounded", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sudal-perf-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0;
  const maxLogBytes = 420;
  const monitor = new PerformanceDiagnostics(dir, { now: () => now, maxLogBytes });
  for (let index = 0; index < 20; index++) {
    now += 2_000;
    monitor.record("turn-result", index);
  }
  await monitor.settle();
  const logs = (await readdir(dir)).sort();
  assert.deepEqual(logs, ["performance.1.jsonl", "performance.jsonl"]);
  for (const name of logs) {
    const file = join(dir, name);
    assert.ok((await stat(file)).size <= maxLogBytes);
    for (const line of (await readFile(file, "utf8")).trim().split("\n")) assert.equal(JSON.parse(line).phase, "turn-result");
  }
  monitor.stop();
  monitor.record("turn-result", 99);
  const latest = (await readFile(join(dir, PERF_LOG_FILE), "utf8")).trim().split("\n").pop()!;
  assert.equal(JSON.parse(latest).durationMs, 19);
});

test("concurrent completions and renderer transitions use app-local tab numbers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sudal-perf-tabs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0;
  const monitor = new PerformanceDiagnostics(dir, { now: () => now });
  const first = { tabId: "private-tab-id-a" }, second = { tabId: "private-tab-id-b" };
  monitor.record("renderer-unresponsive", undefined, first);
  monitor.record("turn-result", 120, first);
  now += 250;
  monitor.record("turn-result", 630, second);
  monitor.record("renderer-responsive", 250, first);
  monitor.record("codex-process-open", undefined, { pid: 15 });
  monitor.record("codex-process-open", undefined, { pid: 16 });
  await monitor.settle();

  const raw = await readFile(join(dir, PERF_LOG_FILE), "utf8");
  assert.ok(!raw.includes("private-tab-id"));
  const rows = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(({ phase, tab, pid }) => [phase, tab, pid]), [
    ["renderer-unresponsive", 1, undefined], ["turn-result", 1, undefined],
    ["turn-result", 2, undefined], ["renderer-responsive", 1, undefined],
    ["codex-process-open", undefined, 15], ["codex-process-open", undefined, 16],
  ]);
  assert.ok(rows.every(row => row.mainPid === process.pid));
});

test("main heartbeat records delay but not time the device spent suspended", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sudal-perf-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  const monitor = new PerformanceDiagnostics(dir, { now: () => now });
  monitor.start();
  try {
    now = 1_600;
    t.mock.timers.tick(1_000);
    monitor.setSuspended(true);
    now = 100_000;
    t.mock.timers.tick(1_000);
    monitor.setSuspended(false);
    now = 101_000;
    t.mock.timers.tick(1_000);
    await monitor.settle();
    const rows = (await readFile(join(dir, PERF_LOG_FILE), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.filter(row => row.phase === "main-stall").map(row => row.durationMs), [600]);
  } finally { monitor.stop(); }
});
