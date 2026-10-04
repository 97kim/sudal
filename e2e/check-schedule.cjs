// 예약 실행. 정해진 시각에 스스로 깨어나 돌고, 끝을 정확히 판정하고, 이력에 남는가.
// 손으로 확인한 흐름(45초 running → 55초 completed)을 그대로 고정한다.
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 지난 시험이 남긴 예약을 치운다 — 매분 도는 예약이 쌓이면 다음 시험을 방해한다.
  for (const s of cli("schedule", "list").schedules) cli("schedule", "rm", "--id", s.id);

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const add = cli("schedule", "add", "--name", "e2e예약", "--cron", "*/1 * * * *",
    "--prompt", "'예약됨' 한 마디만 답해라. 도구는 쓰지 마라.", "--cwd", E2E + "/repo", "--policy", "full");
  const id = add.schedule.id;
  result("예약이 만들어진다", Boolean(id));

  const listed = cli("schedule", "list").schedules.find((s) => s.id === id);
  console.log("다음 실행까지", Math.round(((listed?.nextRunAt ?? 0) - Date.now()) / 1000), "초");
  result("다음 실행 시각이 계산된다", typeof listed?.nextRunAt === "number" && listed.nextRunAt > Date.now());

  // 예정 시각까지 기다린다(최대 2분)
  let runs = [];
  let sawRunning = false;
  for (let i = 0; i < 48; i += 1) {
    await sleep(2500);
    runs = cli("schedule", "runs", "--id", id).runs;
    if (runs[0]?.status === "running") sawRunning = true;
    if (runs[0] && ["completed", "failed", "interrupted"].includes(runs[0].status)) break;
  }
  const run = runs[0];
  console.log("회차:", JSON.stringify(run));
  result("예정 시각에 스스로 돈다", Boolean(run), "회차가 만들어지지 않았다");
  result("도는 동안 running 으로 보인다", sawRunning);
  result("끝을 판정한다", run?.status === "completed", `(${run?.status} ${run?.reason ?? ""})`);
  result("어느 세션에서 돌았는지 남는다", Boolean(run?.tabId));

  // 겹침: 방금 끝났으니 다시 돌려도 새 회차가 생긴다(수동)
  const manual = cli("schedule", "run", "--id", id).run;
  result("수동 실행도 된다", ["running", "pending"].includes(manual.status), `(${manual.status})`);
  const dup = cli("schedule", "run", "--id", id).run;
  result("앞 회차가 살아 있으면 겹침으로 건너뛴다", dup.status === "skipped_overlap", `(${dup.status})`);
  // 회차마다 새 탭을 만들면 매일 도는 예약이 워크스페이스에 탭을 쌓는다. 제 탭 하나에 쌓아야 한다.
  result("두 번째 회차도 같은 탭에서 돈다", Boolean(manual.tabId) && manual.tabId === run?.tabId, `(${run?.tabId} vs ${manual.tabId})`);
  const pinned = cli("schedule", "list").schedules.find((s) => s.id === id)?.pinnedTabId ?? null;
  result("예약이 그 탭을 잡아 둔다", pinned === run?.tabId, `(${pinned})`);

  // 끄면 돌지 않는다
  cli("schedule", "set", "--id", id, "--enabled", "false");
  const off = cli("schedule", "list").schedules.find((s) => s.id === id);
  result("끄면 꺼진 것으로 보인다", off?.enabled === false);

  cli("schedule", "rm", "--id", id);
  result("지우면 목록에서 사라진다", !cli("schedule", "list").schedules.some((s) => s.id === id));

  // 격리 회차가 정말 worktree 안에서 도는가. 위의 프롬프트는 도구를 금지해서 이걸 못 본다 —
  // 실제로 configure 가 작업 경로를 워크스페이스 경로로 덮어써 격리가 풀린 적이 있다. 파일을 만들게 해서 확인한다.
  const mark = `cwd-check-${Date.now()}.txt`;
  const isoId = cli("schedule", "add", "--name", "e2e격리", "--cron", "0 0 1 1 *",
    "--prompt", `지금 작업 폴더에 ${mark} 라는 빈 파일을 만들어라. 다른 말은 하지 마라.`,
    "--cwd", E2E + "/repo", "--policy", "full", "--worktree").schedule.id;
  let iso = cli("schedule", "run", "--id", isoId).run;
  for (let i = 0; i < 60; i += 1) {
    await sleep(2500);
    iso = cli("schedule", "runs", "--id", isoId).runs[0];
    if (iso && ["completed", "failed", "interrupted"].includes(iso.status)) break;
  }
  result("격리 회차가 끝난다", iso?.status === "completed", `(${iso?.status} ${iso?.reason ?? ""})`);
  const isoCwd = iso?.tabId ? cli("tab", "status", "--tab", iso.tabId).tab.cwd : null;
  console.log("격리 작업 경로:", isoCwd);
  result("격리 회차는 원본 저장소에서 돌지 않는다", Boolean(isoCwd) && path.resolve(isoCwd) !== path.resolve(E2E, "repo"));
  result("작업 결과가 worktree 안에 남는다", Boolean(isoCwd) && fs.existsSync(path.join(isoCwd, mark)));
  result("원본 저장소는 건드리지 않는다", !fs.existsSync(path.join(E2E, "repo", mark)));

  // 격리 회차는 회차마다 작업 폴더를 만든다. 치우지 않으면 매일 하나씩 쌓인다.
  // 최근 3개만 남기고, 치우기 전에 남은 것은 제 브랜치에 커밋해 둔다 — 폴더는 회수하되 결과는 잃지 않는다.
  const isoPaths = [isoCwd];
  for (let n = 0; n < 4; n += 1) {
    cli("schedule", "run", "--id", isoId);
    let r = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(2500);
      r = cli("schedule", "runs", "--id", isoId).runs[0];
      if (r && ["completed", "failed", "interrupted"].includes(r.status)) break;
    }
    isoPaths.push(r?.tabId ? cli("tab", "status", "--tab", r.tabId).tab.cwd : null);
  }
  const alive = isoPaths.filter((p) => p && fs.existsSync(p));
  console.log("작업 폴더:", JSON.stringify(isoPaths.map((p) => (p ? path.basename(p) : null))), "살아 있는 것", alive.length);
  // 남기는 3개 + 방금 만든 것 = 4. 다섯 번 돌렸는데도 다섯 개가 남으면 치우지 못한 것이다.
  result("오래된 작업 폴더는 치운다", alive.length <= 4, `(${alive.length}개 남음)`);
  result("가장 최근 회차의 폴더는 남는다", Boolean(isoPaths[isoPaths.length - 1]) && fs.existsSync(isoPaths[isoPaths.length - 1]));
  result("첫 회차의 폴더는 사라진다", Boolean(isoPaths[0]) && !fs.existsSync(isoPaths[0]), `(${isoPaths[0]})`);
  // 커밋하지 않은 회차는 브랜치도 남기지 않는다(worktree 를 지우면 빈 브랜치는 branch -d 로 지워진다).
  // 남으면 폴더 대신 브랜치가 쌓이는 셈이라 정리가 아니다.
  const branches = execFileSync("git", ["branch", "--list", "sudal/*"], { cwd: path.join(E2E, "repo"), encoding: "utf8" })
    .split("\n").map((s) => s.replace(/^[+*]?\s*/, "").trim()).filter(Boolean);
  const firstBranch = isoPaths[0] ? path.basename(isoPaths[0]) : "";
  result("치운 회차는 브랜치도 남기지 않는다", !branches.includes(`sudal/${firstBranch}`), `(${branches.length}개: ${branches.join(", ")})`);

  // 치운다 — 탭을 닫아도 worktree 는 남는다.
  if (iso?.tabId) try { cli("tab", "close", "--tab", iso.tabId); } catch { /* 이미 닫힘 */ }
  if (isoCwd) try { execFileSync("git", ["worktree", "remove", "--force", isoCwd], { cwd: path.join(E2E, "repo") }); } catch { /* 이미 없음 */ }
  cli("schedule", "rm", "--id", isoId);

  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
