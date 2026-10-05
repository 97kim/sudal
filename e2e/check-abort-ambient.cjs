// 우리가 시작하지 않은 턴도 중단되는가.
// 백그라운드가 끝나면 CLI 가 스스로 이어서 일하는데, 그 턴에는 우리가 만든 abort 가 없다.
// 예전에는 그래서 중단 버튼이 화면에 떠 있는데도 눌러 봐야 아무 일도 일어나지 않았다
// (실제로 37분을 못 멈추고 앱을 껐다).
const path = require("path"), { execFileSync, execSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Sudal.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Sudal", [app + "/Contents/Resources/cli/sudal.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SUDAL_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

// 화면 문구가 아니라 실제 프로세스로 본다 — 프롬프트에 쓴 낱말은 화면에 그대로 남아 증거가 못 된다.
// 맨 sleep 은 앱이 자식에게 주는 하네스가 막는다(Monitor 를 쓰라고 한다) — 막히지 않는 방식으로 오래 끈다.
const MARK = "SUDALABORTE2E";
const LONG = `python3 -c "import time; time.sleep(400)  # ${MARK}"`;
const longAlive = () => { try { execSync(`pgrep -f ${MARK} > /dev/null`); return true; } catch { return false; } };

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const tab = cli("tab", "new", "--ws", ws, "--provider", "claude", "--policy", "full", "--title", "중단" + Date.now(), "--activate").tab.id;
  await page.waitForTimeout(2000);

  const status = () => ev(async (t) => (await window.sudal.chat.snapshot(t)).status, tab);
  const blocks = () => ev(() => document.querySelectorAll("[data-block-id]").length);
  const bodyHas = (s) => ev((m) => document.body.innerText.includes(m), s);
  const waitFor = async (pred, secs) => { for (let i = 0; i < secs; i++) { await page.waitForTimeout(1000); if (await pred()) return true; } return false; };

  // 1) 백그라운드를 띄우고 첫 턴은 끝낸다. 그 작업이 끝나면 CLI 가 스스로 이어받아 오래 걸리는 일을 시작한다.
  cli("tab", "send", "--tab", tab, "--text",
    "Bash 도구를 run_in_background:true 로 `sleep 5 && echo 깨웠다` 실행해라. 기다리지 말고 '시작했습니다' 한 마디만 답해라. " +
    `그 명령이 끝나면, 이어서 Bash 로 (백그라운드 아님, timeout 은 600000) 다음을 그대로 실행하고 그 결과를 한 줄로 알려 줘라: ${LONG}`);

  const firstDone = await waitFor(async () => (await status()) === "idle", 90);
  const n0 = await blocks();
  result("첫 턴이 끝난다", firstDone && n0 > 0, `(idle=${firstDone} 블록=${n0})`);

  // 2) 아무도 말을 걸지 않았는데 다시 도는 중이 된다 = 앰비언트 턴
  const woke = await waitFor(async () => (await status()) === "running", 60);
  result("말을 걸지 않았는데 다시 도는 중이 된다", woke);
  const alive0 = await (async () => { for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); if (longAlive()) return true; } return false; })();
  result("이어받은 턴이 실제로 일을 물고 있다", alive0);

  // 3) 중단 — 화면의 중단 버튼과 같은 경로(chat.abort IPC)
  const returned = await ev((t) => window.sudal.chat.abort(t), tab);
  result("중단이 받아들여진다", returned === true, `(반환 ${returned})`);

  const stopped = await waitFor(async () => (await status()) === "idle", 15);
  result("중단하면 도는 중이 풀린다", stopped, `(status=${await status()})`);
  result("중단됐다고 화면에 보인다", await bodyHas("중단됨"));

  // 4) 정말로 멈췄는가 — 돌던 프로세스가 사라지고, 되살아나지 않아야 한다
  const died = await (async () => { for (let i = 0; i < 20; i++) { if (!longAlive()) return true; await page.waitForTimeout(1000); } return false; })();
  result("돌던 일이 실제로 죽는다", died);
  const n1 = await blocks();
  await page.waitForTimeout(15000);
  const n2 = await blocks(), st = await status();
  result("중단 뒤 되살아나지 않는다", st === "idle" && n2 === n1, `(블록 ${n1} → ${n2}, status=${st})`);

  await page.screenshot({ path: E2E + "/shot-abort-ambient.png" });
  await b.close();
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
