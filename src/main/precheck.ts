// 예약의 선조건 명령. "지금 할 일이 있나" 를 모델을 부르기 전에 결정적으로 확인한다.
//
// 이건 작은 조건 검사가 아니라 무인 명령 실행기다 — 모델 권한과 무관하게 돈다.
// 그래서 계약을 분명히 둔다: 고정된 셸, 제한 시간, 출력 상한, 시간 초과면 프로세스 트리째 종료,
// 그리고 "조건 불충족" 과 "명령이 고장 남" 을 구분해 기록한다(해석은 readPrecheck 가 한다).

import { spawn } from "node:child_process";
import type { PrecheckResult } from "@shared/schedules";
import { mt } from "./i18n";
import { IS_WIN, killProcessTree } from "./win-proc";

/** 기록에 남길 출력 길이. 통째로 두면 이력 파일이 커진다. */
const TAIL_MAX = 2000;
export const PRECHECK_TIMEOUT_MAX_MS = 10 * 60 * 1000;

function tail(s: string): string {
  return s.length <= TAIL_MAX ? s : `…${s.slice(-TAIL_MAX)}`;
}

/** 자식이 만든 프로세스까지 정리한다. 타임아웃인데 손자가 살아남으면 의미가 없다. */
function killTree(pid: number): void {
  if (IS_WIN) return killProcessTree(pid);
  try {
    // 음수 pid = 프로세스 그룹. detached 로 띄웠으므로 그룹이 있다.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 이미 죽음 */
    }
  }
}

export function runPrecheckCommand(input: { command: string; timeoutMs: number; cwd: string | null; env: NodeJS.ProcessEnv }): Promise<PrecheckResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(Math.max(1000, input.timeoutMs), PRECHECK_TIMEOUT_MAX_MS);
  return new Promise<PrecheckResult>((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let done = false;
    const finish = (exitCode: number | null, error: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({
        command: input.command,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: tail(out),
        stderr: tail(err),
        error,
      });
    };

    // spawn 이 던지면 finish 가 timer 를 참조하는데, 그때 timer 는 아직 만들어지지 않았다.
    // (명령에 NUL 이 섞이면 실제로 그 경로를 탄다.) 먼저 선언해 둔다.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(IS_WIN ? windowsPrecheckCommand(input.command) : input.command, {
        // Windows 는 cmd.exe. detached 는 새 콘솔 창을 띄우니 끄고, 트리 정리는 taskkill /T 가 맡는다.
        shell: IS_WIN ? true : "/bin/sh",
        cwd: input.cwd ?? undefined,
        env: input.env,
        detached: !IS_WIN,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish(null, e instanceof Error ? e.message : String(e));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (b: Buffer) => {
      out = tail(out + b.toString("utf8"));
    });
    child.stderr?.on("data", (b: Buffer) => {
      err = tail(err + b.toString("utf8"));
    });
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code, signal) => {
      // 시간 초과로 우리가 죽인 것은 "종료 코드" 로 읽으면 안 된다.
      finish(timedOut ? null : code, timedOut ? null : signal ? mt("session.error.signalExit", { signal }) : null);
    });
  });
}

/**
 * cmd.exe 는 없는 명령을 만나면 ERRORLEVEL 을 9009 로 두지만, cmd /c 자체는 1 로 끝난다.
 * 1 은 "조건 불충족(건너뜀)" 이라 오타 난 선조건이 고장으로 보이지 않고 조용히 건너뛰어졌다.
 * 마지막 ERRORLEVEL 을 그대로 종료 코드로 내게 꼬리를 붙인다. %^errorlevel% 은 처음 읽을 때 풀리지 않고
 * call 이 실행할 때 푼다(그래야 앞 명령이 끝난 뒤의 값이다). 앞 명령이 exit 로 끝나면 꼬리는 돌지 않는다.
 */
export function windowsPrecheckCommand(command: string): string {
  return `${command} & call exit %^errorlevel%`;
}
