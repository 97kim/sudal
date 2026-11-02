import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BackgroundJobWatcher } from "./background-jobs";
import { jobRunningLabel, jobsSummaryLabel, mergeJobs, parseBackgroundJob, type BackgroundJobDto } from "@shared/background-jobs";
import { createI18n } from "@shared/i18n";

// 문구 단언은 한국어 기준이다
const t = createI18n("ko").t;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 검사에 실패해도 감시자를 반드시 끈다. 안 끄면 폴링 타이머와 파일 감시자가 남아
 * 테스트 러너가 끝나지 않는다 — 실패가 "느린 테스트" 로 보이고 릴리스가 그대로 멈춘다(실제로 겪었다).
 */
function watching(events: ConstructorParameters<typeof BackgroundJobWatcher>[0], root: string, t: import("node:test").TestContext): BackgroundJobWatcher {
  const w = new BackgroundJobWatcher(events, root);
  t.after(() => w.stop());
  return w;
}

const job = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  sessionId: "sess-a",
  kindLabel: "rescue",
  title: "Codex Task",
  status: "running",
  summary: "브라우저를  올려\n달라",
  createdAt: "2026-09-13T00:00:00.000Z",
  ...over,
});

test("parseBackgroundJob: 읽히는 것만 쓰고, 모르는 형식은 버린다", () => {
  const ok = parseBackgroundJob(t, job(), "/r/state.json");
  assert.equal(ok?.id, "task-1");
  assert.equal(ok?.label, "rescue");
  assert.equal(ok?.status, "running");
  assert.equal(ok?.summary, "브라우저를 올려 달라", "요약의 줄바꿈·연속 공백은 한 칸으로");
  assert.equal(ok?.startedAt, Date.parse("2026-09-13T00:00:00.000Z"));
  assert.equal(ok?.completedAt, null);

  assert.equal(parseBackgroundJob(t, null, "/r"), null);
  assert.equal(parseBackgroundJob(t, job({ id: "" }), "/r"), null, "id 없으면 버린다");
  assert.equal(parseBackgroundJob(t, job({ sessionId: undefined }), "/r"), null, "세션을 모르면 탭에 못 이으므로 버린다");
  assert.equal(parseBackgroundJob(t, job({ status: "weird" }), "/r"), null, "모르는 상태는 버린다");
  assert.equal(parseBackgroundJob(t, job({ createdAt: "nope" }), "/r"), null, "시각이 없으면 버린다");
  // kindLabel 이 없으면 kind 로, 그것도 없으면 기본 이름
  assert.equal(parseBackgroundJob(t, job({ kindLabel: undefined, kind: "review" }), "/r")?.label, "review");
  assert.equal(parseBackgroundJob(t, job({ kindLabel: undefined, kind: undefined }), "/r")?.label, "작업");
});

test("mergeJobs: 같은 저장소의 같은 id 는 하나로, 시작 순으로", () => {
  const a = parseBackgroundJob(t, job({ id: "a", createdAt: "2026-09-13T00:00:02.000Z" }), "/r")!;
  const b = parseBackgroundJob(t, job({ id: "b", createdAt: "2026-09-13T00:00:01.000Z" }), "/r")!;
  const aDup = parseBackgroundJob(t, job({ id: "a", status: "completed", createdAt: "2026-09-13T00:00:02.000Z" }), "/r")!;
  const bOther = parseBackgroundJob(t, job({ id: "b", createdAt: "2026-09-13T00:00:01.000Z" }), "/other")!;
  const out = mergeJobs([a, b, aDup, bOther]);
  assert.deepEqual(
    out.map((j) => `${j.root}|${j.id}|${j.status}`),
    ["/r|b|running", "/other|b|running", "/r|a|completed"],
  );
});

test("jobRunningLabel: 분·초", () => {
  const j = { label: "rescue", startedAt: 1000 } as BackgroundJobDto;
  assert.equal(jobRunningLabel(j, 1000 + 45_000, t), "rescue · 45초 경과");
  assert.equal(jobRunningLabel(j, 1000 + 192_000, t), "rescue · 3분 12초 경과");
  assert.equal(jobRunningLabel(j, 0, t), "rescue · 0초 경과", "시계가 뒤로 가도 음수는 안 나온다");
});

test("BackgroundJobWatcher: 시작 때 이미 끝난 작업은 알리지 않고, 돌던 것이 끝나면 알린다", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-jobs-"));
  const dir = join(root, "codex-plugin", "state", "repo-1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "state.json");
  const write = (jobs: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, jobs }));

  // 앱을 켤 때 이미 끝나 있던 작업 + 도는 작업 하나
  write([job({ id: "old", status: "completed", completedAt: "2026-09-13T00:01:00.000Z" }), job({ id: "live" })]);
  const changed: BackgroundJobDto[][] = [];
  const finished: BackgroundJobDto[] = [];
  const w = watching({ onChanged: (j) => changed.push(j), onFinished: (j) => finished.push(j) }, root, t);
  await w.start();
  assert.equal(finished.length, 0, "기준선 읽기는 알림을 내지 않는다");
  assert.deepEqual(
    w.current().map((j) => j.id),
    ["live"],
    "도는 것만 current 에",
  );

  // 돌던 것이 끝난다
  write([job({ id: "old", status: "completed", completedAt: "2026-09-13T00:01:00.000Z" }), job({ id: "live", status: "completed", completedAt: "2026-09-13T00:02:00.000Z" })]);
  // 폴링 주기가 4초다. 4초만 기다리면 여유가 없어 부하가 걸릴 때 놓친다.
  for (let i = 0; i < 150 && finished.length === 0; i++) await wait(100);
  assert.equal(finished.length, 1, "끝난 작업을 한 번 알린다");
  assert.equal(finished[0].id, "live");
  assert.deepEqual(w.current(), [], "끝났으면 도는 목록에서 빠진다");
  assert.ok(changed.length >= 1, "목록 변화도 알린다");

  // 한 번 알린 것을 다시 알리지 않는다
  write([job({ id: "live", status: "completed", completedAt: "2026-09-13T00:02:00.000Z" })]);
  await wait(700);
  assert.equal(finished.length, 1);

  w.stop();
  rmSync(root, { recursive: true, force: true });
});

test("BackgroundJobWatcher: 시작 때 없던 디렉토리에 나중에 생긴 작업도 잡는다", async (t) => {
  // 감시자는 없는 디렉토리에 못 붙는다 — 주기적으로 다시 읽지 않으면 영영 못 본다(e2e 에서 실제로 놓쳤던 경우).
  const base = mkdtempSync(join(tmpdir(), "wb-jobs3-"));
  const root = join(base, "아직-없음");
  const seen: BackgroundJobDto[][] = [];
  const w = watching({ onChanged: (j) => seen.push(j), onFinished: () => {} }, root, t);
  await w.start();
  assert.deepEqual(w.current(), [], "없는 동안은 빈 목록");

  const dir = join(root, "plugin", "state", "repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ jobs: [job({ id: "late" })] }));
  for (let i = 0; i < 100 && w.current().length === 0; i++) await wait(100);
  assert.deepEqual(
    w.current().map((j) => j.id),
    ["late"],
    "나중에 생긴 작업도 잡아야 한다",
  );
  assert.ok(seen.length >= 1);
  w.stop();
  // Keep Unicode coverage, but remove the whole fixture through its ASCII base.
  // Node 24.13 on Windows can native-crash when rmSync receives the Unicode
  // child as its root; deleting the base also avoids leaving its directory behind.
  assert.equal(dirname(resolve(base)), resolve(tmpdir()));
  assert.ok(basename(base).startsWith("wb-jobs3-"));
  rmSync(base, { recursive: true, force: true });
});

test("BackgroundJobWatcher: 깨진 JSON·없는 디렉토리에도 죽지 않는다", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-jobs2-"));
  const dir = join(root, "p", "state", "r");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), '{"jobs": [{"id": "x"');
  const w = watching({ onChanged: () => {}, onFinished: () => {} }, root, t);
  await w.start();
  assert.deepEqual(w.current(), []);
  w.stop();

  const missing = watching({ onChanged: () => {}, onFinished: () => {} }, join(root, "없음"), t);
  await missing.start();
  assert.deepEqual(missing.current(), []);
  missing.stop();
  rmSync(root, { recursive: true, force: true });
});

test("여러 개일 때의 한 줄 — 시간은 가장 오래 돈 것 기준", () => {
  const at = (id: string, startedAt: number): BackgroundJobDto => ({
    id, sessionId: "s", label: "명령", title: id, status: "running", summary: id, startedAt, completedAt: null, root: "/r",
  });
  const now = 100_000;
  assert.equal(jobsSummaryLabel([], now, t), "");
  assert.equal(jobsSummaryLabel([at("a", now - 5_000)], now, t), "1개 · 5초 경과");
  // 순서가 뒤섞여 있어도 가장 오래된 것을 고른다
  assert.equal(
    jobsSummaryLabel([at("a", now - 5_000), at("b", now - 130_000), at("c", now - 60_000)], now, t),
    "3개 · 2분 10초 경과",
  );
});
