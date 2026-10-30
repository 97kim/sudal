import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyQuotaRefresher, fetchAgyQuota, parseAgyQuota } from "./agy-usage";

const flushPromises = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test("quota refresh retains short-turn updates and coalesces them without recurring polling", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let calls = 0;
  const refresher = new AgyQuotaRefresher(async () => { calls++; });
  t.after(() => refresher.dispose());
  await refresher.request();
  assert.equal(calls, 1);
  t.mock.timers.tick(20_000);
  for (let i = 0; i < 5; i++) await refresher.request();
  assert.equal(calls, 1);
  t.mock.timers.tick(39_999);
  await flushPromises();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(calls, 2, "the last reply eventually refreshes even with no further messages");
  t.mock.timers.tick(120_000);
  await flushPromises();
  assert.equal(calls, 2, "idle time alone never starts another CLI");
});

test("quota refresh queues one follow-up during a slow fetch and shares manual requests", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let calls = 0;
  let complete!: () => void;
  const blocked = new Promise<void>((resolve) => { complete = resolve; });
  const refresher = new AgyQuotaRefresher(async () => { if (++calls === 1) await blocked; });
  t.after(() => refresher.dispose());
  const first = refresher.request();
  await flushPromises();
  assert.equal(refresher.request(true), first);
  for (let i = 0; i < 5; i++) void refresher.request();
  t.mock.timers.tick(70_000);
  assert.equal(calls, 1, "fetches never overlap");
  complete();
  await first;
  t.mock.timers.tick(0);
  await flushPromises();
  assert.equal(calls, 2);
  t.mock.timers.tick(120_000);
  await flushPromises();
  assert.equal(calls, 2);
});

test("manual refresh replaces a pending timer and shutdown cancels scheduled work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let calls = 0;
  const refresher = new AgyQuotaRefresher(async () => { calls++; });
  t.after(() => refresher.dispose());
  await refresher.request();
  t.mock.timers.tick(20_000);
  await refresher.request();
  await refresher.request(true);
  assert.equal(calls, 2);
  t.mock.timers.tick(60_000);
  await flushPromises();
  assert.equal(calls, 2, "manual refresh satisfies the earlier pending request");
  await refresher.request();
  await refresher.request();
  refresher.dispose();
  t.mock.timers.tick(120_000);
  await flushPromises();
  assert.equal(calls, 3);
  await refresher.request(true);
  assert.equal(calls, 3);
});

const response = (remaining: unknown = 0.58) => ({ status: "SUCCESS", command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [
    { window: "weekly", remaining_fraction: 0.99, reset_time: "2026-11-04T17:17:31Z" },
    { window: "5h", remaining_fraction: 1, reset_time: "2026-10-30T12:16:07Z" },
  ] },
  { name: "Gemini 4 Argon", buckets: [{ window: "weekly", remaining_fraction: remaining, reset_time: "2026-11-04T17:11:33Z" }] },
] } } });

test("Antigravity quota maps independent groups and converts remaining into used percentages", () => {
  const quota = parseAgyQuota(response(), 123)!;
  assert.equal(quota.observedAt, 123);
  assert.equal(quota.session, null);
  assert.equal(quota.groups?.length, 2);
  assert.deepEqual(quota.groups?.[0].windows.map((w) => w.windowMinutes), [10080, 300]);
  assert.equal(quota.groups?.[0].windows[1].usedPercent, 0);
  assert.ok(Math.abs(quota.groups![1].windows[0].usedPercent - 42) < 1e-9);
  assert.equal(quota.groups?.[1].windows[0].resetsAt, Date.parse("2026-11-04T17:11:33Z") / 1000);
  assert.equal(parseAgyQuota(response(0))?.groups?.[1].windows[0].usedPercent, 100);
});

test("Antigravity quota never interprets model text, failures or missing values as a healthy quota", () => {
  for (const raw of [null, {}, { status: "ERROR", command: response().command }, { status: "SUCCESS", response: "100% remaining" }]) {
    assert.equal(parseAgyQuota(raw), null);
  }
  for (const fraction of [undefined, null, "0.5", -1, 2, NaN]) {
    const raw = response();
    raw.command.data.groups[1].buckets[0].remaining_fraction = fraction;
    assert.equal(parseAgyQuota(raw)?.groups?.length, 1);
  }
  assert.equal(parseAgyQuota({ status: "SUCCESS", command: { name: "usage", data: { groups: [null, {}, { name: "unknown", buckets: [{ window: "future", remaining_fraction: 1 }] }] } } }), null);
});

test("Antigravity quota launches an isolated local command and rejects CLI errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sudal-agy-quota-"));
  const script = join(dir, "agy.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['--print','/usage','--output-format','json','--print-timeout','30s']);
if (process.env.SUDAL_QUOTA_TEST_ERROR) process.exit(2);
console.log(${JSON.stringify(JSON.stringify(response()))});
`, { mode: 0o755 });
  let bin = script;
  if (process.platform === "win32") {
    bin = join(dir, "agy.cmd");
    writeFileSync(bin, '@echo off\r\nnode "%~dp0\\agy.cjs" %*\r\n');
  }
  try {
    const result = await fetchAgyQuota({ agyPath: bin, env: { ...process.env } }, dir);
    assert.equal(result.groups?.[1].label, "Gemini 4 Argon");
    await assert.rejects(fetchAgyQuota({ agyPath: bin, env: { ...process.env, SUDAL_QUOTA_TEST_ERROR: "1" } }, dir), /command failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
