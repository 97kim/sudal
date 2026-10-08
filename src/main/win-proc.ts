// 운영체제마다 다른 프로세스 다루기. macOS 는 detached 로 띄워 프로세스 그룹째 신호를 보내고,
// Windows 에는 그룹 신호가 없어 taskkill /T 로 자식까지 끝낸다.
import { spawn } from "node:child_process";

export const IS_WIN = process.platform === "win32";

export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/** pid 와 그 자손을 끝낸다. macOS 는 그룹(-pid)에 signal, 그룹이 없으면 pid 하나에. Windows 는 signal 과 무관하게 강제 종료. */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try {
      const p = spawn("taskkill", taskkillArgs(pid), { stdio: "ignore", windowsHide: true });
      p.on("error", () => {
        /* 이미 끝남 */
      });
    } catch {
      /* 이미 끝남 */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 이미 끝남 */
    }
  }
}

/** .cmd/.bat 은 Node 가 shell 없이 띄우지 않는다(EINVAL) — 이런 파일은 cmd.exe 를 거쳐야 한다. */
export function needsCmdShell(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/** cmd.exe 명령 줄에 넣을 큰따옴표 인용. Windows 경로에는 " 가 올 수 없어 감싸기만 한다. */
export function cmdQuote(s: string): string {
  return `"${s}"`;
}

/**
 * Sudal 실행 파일을 node 로 돌려 스크립트를 실행하는 .cmd 내용. 훅 명령처럼 다른 프로그램이 셸로 부르는 자리에 쓴다.
 * ELECTRON_RUN_AS_NODE 는 이 .cmd 안에서만 켠다 — 부르는 쪽(CLI) env 에 넣으면 그 아래 Electron 앱까지 node 로 뜬다.
 * args 는 .cmd 안에서 그대로 쓰이는 문자열이다(%~dp0 같은 cmd 표기 가능).
 */
export function nodeCmdWrapper(execPath: string, script: string, args: string[] = []): string {
  return ["@echo off", "set ELECTRON_RUN_AS_NODE=1", [cmdQuote(execPath), script, ...args].join(" "), ""].join("\r\n");
}
