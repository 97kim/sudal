// 예약을 화면에서 만들고 고칠 수 있는가. 여태 만들기는 CLI 뿐이라 첫 사용자는 터미널을 열어야 했다.
// 고른 값이 정말 그 cron 으로 저장되는지, 못 도는 예약이 저장되지 않는지까지 본다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const NAME = "화면에서만든예약";

(async () => {
  for (const s of cli("schedule", "list").schedules) cli("schedule", "rm", "--id", s.id);
  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "예약폼", "--activate");

  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.waitForTimeout(1500);

  // 설정은 채팅 화면의 "/config" 로 연다. 그 다음 좌측에서 예약으로 간다.
  await page.fill("textarea:not(.xterm-helper-textarea)", "/config");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await ev(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "예약")?.click());
  await page.waitForTimeout(600);
  result("예약 화면이 열린다", await ev(() => !!document.querySelector("[data-schedules-section]")));
  // 앱은 시험 사이에 계속 떠 있다. 지난 회차가 폼을 열어 둔 채 끝났으면 닫고 시작한다.
  await ev(() => {
    const form = document.querySelector("[data-schedule-form]");
    if (form) [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "취소")?.click();
  });
  await page.waitForTimeout(400);
  result("화면에 만들기 버튼이 있다", await ev(() => !!document.querySelector("[data-new-schedule]")));

  await page.click("[data-new-schedule]");
  await page.waitForTimeout(300);
  result("폼이 열린다", await ev(() => !!document.querySelector("[data-schedule-form]")));

  // 빈 채로 저장하면 못 도는 예약이 생기면 안 된다.
  await page.click("[data-f-save]");
  await page.waitForTimeout(500);
  const errText = await ev(() => document.querySelector("[data-schedule-error]")?.textContent?.trim() ?? "");
  console.log("오류 문구:", errText);
  result("빈 채로 저장하면 막고 이유를 말한다", errText.length > 0);
  // Electron 이 앞에 붙이는 "Error invoking remote method 'schedules:save'" 배관이 새어 나오면 안 된다.
  result("오류 문구에 내부 배관이 새지 않는다", !/remote method|schedules:save/.test(errText), `(${errText})`);
  result("막힌 예약은 저장되지 않는다", cli("schedule", "list").schedules.length === 0);

  await page.fill("[data-f-name]", NAME);
  await page.selectOption("[data-f-repeat]", "daily");
  await page.selectOption("[data-f-hour]", "07");
  await page.selectOption("[data-f-minute]", "30");
  await page.fill("[data-f-prompt]", "'예약됨' 한 마디만 답해라.");
  await page.waitForTimeout(300);
  const preview = await ev(() => document.querySelector("[data-f-preview]")?.textContent?.trim() ?? "");
  console.log("미리보기:", preview);
  result("저장 전에 다음 실행 시각을 보여 준다", preview.includes("다음") && !preview.includes("cron 형식이 아닙니다"), `(${preview})`);
  // 폴더를 앱이 채웠으면 그렇다고 적는다 — 내가 고른 값인지 구분되어야 한다.
  result("자동으로 채운 폴더임을 알린다", await ev(() => !!document.querySelector("[data-f-cwd-auto]")));
  result("그래도 폴더는 채워져 있다", await ev(() => (document.querySelector("[data-f-cwd]")?.textContent ?? "").trim() !== "폴더 고르기"));
  await page.screenshot({ path: E2E + "/shot-schedule-form.png" });

  await page.click("[data-f-save]");
  await page.waitForTimeout(900);
  const made = cli("schedule", "list").schedules.find((s) => s.name === NAME);
  result("화면에서 만든 예약이 저장된다", Boolean(made));
  result("고른 시각이 그 cron 으로 저장된다", made?.cron === "30 7 * * *", `(${made?.cron})`);
  result("다음 실행 시각이 계산된다", typeof made?.nextRunAt === "number" && made.nextRunAt > Date.now());
  result("폼이 닫힌다", await ev(() => !document.querySelector("[data-schedule-form]")));

  // 고치기: 저장된 값을 되읽어 폼을 채우는가.
  await page.click("[data-edit-schedule]");
  await page.waitForTimeout(400);
  const back = await ev(() => ({
    name: document.querySelector("[data-f-name]")?.value ?? null,
    repeat: document.querySelector("[data-f-repeat]")?.value ?? null,
    time: `${document.querySelector("[data-f-hour]")?.value ?? ""}:${document.querySelector("[data-f-minute]")?.value ?? ""}`,
    // 네이티브 time 입력을 걷어냈다 — OS 드롭다운(오전/오후 3열)이 이 화면에서만 혼자 튀었다.
    noNativeTime: !document.querySelector('input[type="time"]'),
  }));
  console.log("되읽은 값:", JSON.stringify(back));
  result("고치기가 저장된 값을 되읽는다", back.name === NAME && back.repeat === "daily" && back.time === "07:30", JSON.stringify(back));
  result("시각도 앱의 고르기로 쓴다(네이티브 피커 없음)", back.noNativeTime);
  await page.selectOption("[data-f-repeat]", "weekdays");
  await page.selectOption("[data-f-hour]", "08");
  await page.selectOption("[data-f-minute]", "05");
  await page.click("[data-f-save]");
  await page.waitForTimeout(900);
  const edited = cli("schedule", "list").schedules.find((s) => s.name === NAME);
  result("고친 값이 저장된다", edited?.cron === "5 8 * * 1-5", `(${edited?.cron})`);
  result("고쳐도 같은 예약이다(복제되지 않는다)", cli("schedule", "list").schedules.filter((s) => s.name === NAME).length === 1);

  // 직접 cron 은 틀리면 저장되지 않는다.
  await page.click("[data-edit-schedule]");
  await page.waitForTimeout(400);
  await page.selectOption("[data-f-repeat]", "custom");
  await page.fill("[data-f-cron]", "매일 아침");
  await page.waitForTimeout(300);
  result("틀린 cron 은 미리보기가 말해 준다", (await ev(() => document.querySelector("[data-f-preview]")?.textContent ?? "")).includes("cron 형식이 아닙니다"));
  await page.click("[data-f-save]");
  await page.waitForTimeout(600);
  result("틀린 cron 은 저장되지 않는다", cli("schedule", "list").schedules.find((s) => s.name === NAME)?.cron === "5 8 * * 1-5");

  // 목록이 쌓였을 때의 모습도 남긴다 — 행 하나만 있을 때는 안 보이는 문제가 있다.
  await ev(() => {
    const form = document.querySelector("[data-schedule-form]");
    if (form) [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "취소")?.click();
  });
  await page.waitForTimeout(400);
  // 폼을 닫았으면 그 폼이 낸 오류도 사라져야 한다. 남으면 가리킬 대상이 없는 지적이 목록 위에 걸린다.
  result("취소하면 폼이 낸 오류도 사라진다", await ev(() => !document.querySelector("[data-schedule-error]")));

  cli("schedule", "add", "--name", "주간 정리", "--cron", "0 9 * * 1", "--prompt", "지난 주 커밋을 한 문단으로 정리해 줘.", "--cwd", E2E + "/repo");
  cli("schedule", "add", "--name", "매시 점검", "--cron", "15 * * * *", "--prompt", "빌드가 깨졌는지 확인해 줘.", "--cwd", E2E + "/repo", "--worktree", "--policy", "full");
  await page.waitForTimeout(700);
  result("목록에 예약이 쌓인다", (await ev(() => document.querySelectorAll("[data-schedule]").length)) >= 3);

  // 켜고 끄기는 토글이다. 글자("끄기"/"켜기")는 지금 상태와 누르면 될 일이 헷갈려서 바꿨다.
  const toggles = () => ev(() => [...document.querySelectorAll("[data-toggle-schedule]")].map((e) => e.getAttribute("data-toggle-schedule")));
  const before = await toggles();
  result("목록에 토글이 있다", before.length > 0 && before.every((v) => v === "on"), JSON.stringify(before));
  await page.click("[data-toggle-schedule]");
  await page.waitForTimeout(900);
  const after = await toggles();
  result("토글을 누르면 꺼진다", after[0] === "off", JSON.stringify(after));
  result("끈 것이 실제로 저장된다", cli("schedule", "list").schedules.some((s) => s.enabled === false));
  await page.click("[data-toggle-schedule]");
  await page.waitForTimeout(900);
  result("다시 누르면 켜진다", (await toggles())[0] === "on");
  await page.screenshot({ path: E2E + "/shot-schedules.png" });

  // 폴더는 예약이 직접 갖는다. 안 주면 막고, 주면 만들어진다.
  let blocked = "통과";
  try {
    cli("schedule", "add", "--name", "폴더없음예약", "--cron", "0 5 * * *", "--prompt", "안녕");
  } catch { blocked = "막힘"; }
  result("폴더를 안 주면 막는다", blocked === "막힘", `(${blocked})`);

  // 화면에서는 워크스페이스를 묻지 않는다. 안 고르고 만든 예약은 실행할 때 전용 워크스페이스로 간다.
  result("폼에 워크스페이스 칸이 없다", await ev(() => !document.querySelector("[data-f-ws]")));
  const noWs = cli("schedule", "add", "--name", "워크스페이스없음", "--cron", "0 7 * * *", "--prompt", "'됨' 한 마디만 답해라.", "--cwd", E2E + "/repo");
  const noWsId = noWs?.schedule?.id ?? noWs?.id ?? null;
  result("워크스페이스 없이도 예약이 만들어진다", Boolean(noWsId));
  if (noWsId) {
    cli("schedule", "run", "--id", noWsId);
    for (let i = 0; i < 40; i += 1) {
      const r = cli("schedule", "runs", "--id", noWsId).runs[0];
      if (r && ["completed", "failed", "interrupted", "skipped_unavailable"].includes(r.status)) break;
      await page.waitForTimeout(1000);
    }
    const run = cli("schedule", "runs", "--id", noWsId).runs[0];
    result("그 회차가 건너뛰지 않고 실제로 돈다", run?.status === "completed", `(${run?.status} ${run?.reason ?? ""})`);
    const made = await ev(() => window.sudal.workspaces.state());
    const sched = made.model.workspaces.find((w) => w.name === "예약");
    result("예약 전용 워크스페이스가 생긴다", Boolean(sched));
    const tab = made.model.tabs.find((t) => t.id === run?.tabId);
    result("결과 탭이 그 워크스페이스에 들어간다", Boolean(tab) && tab.workspaceId === sched?.id);
    // 사이드바에서는 맨 위에 둔다. 손으로 맞춘 순서 사이에 끼면 매번 찾아야 한다.
    await ev(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "채팅")?.click());
    await page.waitForTimeout(800);
    const firstWs = await ev(() => document.querySelector("[data-ws-name]")?.textContent?.trim() ?? null);
    result("사이드바에서 예약이 맨 위에 온다", firstWs === "예약", `(${firstWs})`);
    cli("schedule", "rm", "--id", noWsId);
  }

  // 열어 둔 폼은 닫고 나간다 — 다음 시험이 같은 화면을 이어받는다.
  await ev(() => {
    const form = document.querySelector("[data-schedule-form]");
    if (form) [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "취소")?.click();
  });
  for (const s of cli("schedule", "list").schedules) cli("schedule", "rm", "--id", s.id);
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
