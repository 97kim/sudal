// 검증 실행기 — 워크스페이스에 저장한 명령을 탭의 cwd 에서 순서대로 돌리고, 진행·결과를 verify 이벤트로 탭에 남긴다.
// 실행은 로그인 셸(zsh -lc)이라 사용자의 PATH·nvm 등이 그대로 적용된다(Windows 는 cmd.exe). 하나라도 실패하면 뒤 명령은 건너뛴다.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifyCommandResult, VerifyEvent } from "@shared/chat-events";
import { VERIFY_COMMAND_TIMEOUT_MS, cutOutput, overallStatus, suggestVerifyCommands } from "@shared/verify";
import type { Msg } from "@shared/i18n/msg";
import { sanitizeCliEnv } from "./cli-env";
import { appMsg, mt } from "./i18n";
import { IS_WIN, killProcessTree } from "./win-proc";

export interface VerifyRunOptions {
  tabId: string;
  cwd: string;
  commands: string[];
  env: NodeJS.ProcessEnv;
}

interface Run {
  runId: string;
  tabId: string;
  cwd: string;
  commands: VerifyCommandResult[];
  head: VerifyEvent["head"];
  child: ChildProcess | null;
  aborted: boolean;
  done: Promise<void>;
}

/** 진행 중 출력 스트리밍(partial) 을 화면에 흘리는 간격. */
const PROGRESS_INTERVAL_MS = 250;

/** 실행 시점의 HEAD(짧은 sha·브랜치·더티 여부). 레포가 아니면 null. */
export async function gitHead(cwd: string, env: NodeJS.ProcessEnv): Promise<VerifyEvent["head"]> {
  const run = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      const p = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.on("error", () => resolve(null));
      p.on("close", (code) => resolve(code === 0 ? out : null));
      setTimeout(() => {
        try { p.kill(); } catch { /* 이미 끝남 */ }
      }, 5000).unref();
    });
  const sha = (await run(["rev-parse", "--short=10", "HEAD"]))?.trim();
  if (!sha) return null;
  const branchRaw = (await run(["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const status = await run(["status", "--porcelain", "--untracked-files=no"]);
  return { sha, branch, dirty: (status ?? "").trim().length > 0 };
}

/** 저장한 명령이 없을 때 cwd 의 매니페스트에서 추천. */
export function suggestForCwd(cwd: string): string[] {
  return suggestVerifyCommands({
    has: (rel) => existsSync(join(cwd, rel)),
    read: (rel) => {
      try {
        return readFileSync(join(cwd, rel), "utf8");
      } catch {
        return null;
      }
    },
  });
}

export class VerifyRunner {
  private runs = new Map<string, Run>();

  constructor(private readonly note: (tabId: string, event: VerifyEvent) => void) {}

  /** 탭에서 진행 중인 실행. */
  running(tabId: string): string | null {
    for (const r of this.runs.values()) if (r.tabId === tabId) return r.runId;
    return null;
  }

  /** 실행을 시작하고 runId 를 돌려준다. 같은 탭에 진행 중인 실행이 있으면 거부. */
  async start(o: VerifyRunOptions): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    if (o.commands.length === 0) return { ok: false, error: mt("repo.verify.noCommands") };
    if (this.running(o.tabId)) return { ok: false, error: mt("repo.verify.alreadyRunning") };
    const runId = randomUUID();
    const env = sanitizeCliEnv({ ...o.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1", TERM: "dumb" });
    const run: Run = {
      runId,
      tabId: o.tabId,
      cwd: o.cwd,
      commands: o.commands.map((cmd) => ({ cmd, status: "pending" })),
      head: null,
      child: null,
      aborted: false,
      done: Promise.resolve(),
    };
    // 자리를 먼저 잡는다 — 아래 await 동안 같은 탭의 두 번째 요청이 들어와도 중복 검사에 걸리게
    this.runs.set(runId, run);
    try {
      run.head = await gitHead(o.cwd, env);
    } catch {
      run.head = null;
    }
    if (run.aborted) {
      this.runs.delete(runId);
      return { ok: false, error: mt("repo.verify.abortedBeforeStart") };
    }
    this.emit(run, false);
    run.done = this.execute(run, env).finally(() => this.runs.delete(runId));
    return { ok: true, runId };
  }

  /** 진행 중인 실행을 멈춘다(프로세스 그룹에 SIGTERM). */
  abort(tabId: string): boolean {
    const runId = this.running(tabId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return false;
    run.aborted = true;
    this.killTree(run.child);
    return true;
  }

  /** 앱 종료 때: 남은 실행을 모두 멈춘다. */
  dispose() {
    for (const r of this.runs.values()) {
      r.aborted = true;
      this.killTree(r.child);
    }
  }

  /** 프로세스 그룹 전체에 신호. 부모(셸)가 먼저 끝났어도 그룹에 남은 자식이 있을 수 있어 exitCode 와 무관하게 보낸다. */
  private killTree(child: ChildProcess | null) {
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    // Windows 는 그룹 신호가 없다 — taskkill /T /F 한 번으로 트리째 끝낸다.
    if (IS_WIN) return killProcessTree(pid);
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* 이미 끝남 */ }
    }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* 이미 끝남 */ }
    }, 3000).unref();
  }

  private emit(run: Run, partial: boolean) {
    const status = overallStatus(run.commands);
    this.note(run.tabId, {
      type: "verify",
      ts: Date.now(),
      runId: run.runId,
      status,
      cwd: run.cwd,
      head: run.head,
      commands: run.commands.map((c) => ({ ...c })),
      ...(partial ? { partial: true } : {}),
    });
  }

  private async execute(run: Run, env: NodeJS.ProcessEnv) {
    for (let i = 0; i < run.commands.length; i++) {
      const c = run.commands[i];
      if (run.aborted) {
        c.status = "aborted";
        continue;
      }
      c.status = "running";
      const started = Date.now();
      this.emit(run, false);
      const r = await this.runOne(run, c, env);
      c.durationMs = Date.now() - started;
      c.exitCode = r.exitCode;
      const cut = cutOutput(r.output);
      c.output = cut.text;
      if (cut.truncated) c.truncated = true;
      // 시간 초과 안내가 종료 신호 안내를 대신한다
      const note = r.timedOut && !run.aborted ? appMsg("repo.msg.verify.timeout", { minutes: Math.round(VERIFY_COMMAND_TIMEOUT_MS / 60000) }) : r.note;
      if (note) {
        c.note = note.message;
        c.noteMsg = note.msg;
      }
      if (run.aborted) c.status = "aborted";
      else if (r.timedOut) c.status = "failed";
      else c.status = r.exitCode === 0 ? "passed" : "failed";
      if (c.status !== "passed") {
        // 실패·중단 뒤의 명령은 돌리지 않는다
        for (let j = i + 1; j < run.commands.length; j++) run.commands[j].status = run.aborted ? "aborted" : "skipped";
        break;
      }
    }
    this.emit(run, false);
  }

  private runOne(run: Run, c: VerifyCommandResult, env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; output: string; timedOut: boolean; note?: { message: string; msg: Msg } }> {
    return new Promise((resolve) => {
      let output = "";
      let timedOut = false;
      let child: ChildProcess;
      try {
        // Windows: cmd.exe(shell:true) — 추천 명령이 쓰는 && 를 Windows PowerShell 5 는 모른다. detached 는 콘솔 창을 새로 띄워 쓰지 않는다.
        child = IS_WIN
          ? spawn(c.cmd, { cwd: run.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: true, windowsHide: true })
          : spawn("/bin/zsh", ["-lc", c.cmd], { cwd: run.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (e) {
        resolve({ exitCode: null, output: e instanceof Error ? e.message : String(e), timedOut: false });
        return;
      }
      run.child = child;
      let dirty = false;
      const ticker = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        const cut = cutOutput(output);
        c.output = cut.text;
        if (cut.truncated) c.truncated = true;
        this.emit(run, true);
      }, PROGRESS_INTERVAL_MS);
      const onData = (d: Buffer) => {
        output += d.toString();
        // 메모리 상한: 꼬리만 유지
        if (output.length > 64_000) output = output.slice(output.length - 32_000);
        dirty = true;
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child);
      }, VERIFY_COMMAND_TIMEOUT_MS);
      const finish = (exitCode: number | null, extra?: string, note?: { message: string; msg: Msg }) => {
        clearInterval(ticker);
        clearTimeout(timer);
        run.child = null;
        resolve({ exitCode, output: extra ? output + extra : output, timedOut, note });
      };
      let finished = false;
      const once = (exitCode: number | null, extra?: string, note?: { message: string; msg: Msg }) => {
        if (finished) return;
        finished = true;
        finish(exitCode, extra, note);
      };
      child.on("error", (e) => once(null, `\n${e.message}`));
      child.on("close", (code, signal) => once(code, undefined, signal && code === null ? appMsg("repo.msg.verify.signal", { signal }) : undefined));
      // 부모는 끝났는데 stdout 을 물려받은 자식이 남아 close 가 안 오는 경우: 잠깐 기다렸다가 그룹을 정리하고 끝낸다
      child.on("exit", (code, signal) => {
        setTimeout(() => {
          if (finished) return;
          this.killTree(child);
          once(code, undefined, signal && code === null ? appMsg("repo.msg.verify.orphanSignal", { signal }) : appMsg("repo.msg.verify.orphan"));
        }, 1500).unref();
      });
    });
  }
}

