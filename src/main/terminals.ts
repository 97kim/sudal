// 채팅 탭마다 하나씩 붙는 통합 터미널. node-pty 로 사용자 셸을 워크스페이스 cwd 에서 띄우고
// 출력은 renderer 의 xterm 으로 흘려보낸다. 패널을 닫아도 셸은 살아 있고, 탭을 닫으면 죽인다.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import { TERMINAL_CLEAR_MARK } from "@shared/ipc";
import { mt } from "./i18n";
import { launchSpec, resolvePtyCommand } from "./cli-launch";

export interface TerminalOpenResult {
  ok: boolean;
  /** 이미 떠 있는 셸에 다시 붙은 경우 true (renderer 가 버퍼를 새로 그리지 않아도 됨). */
  existing: boolean;
  shell: string;
  pid?: number;
  error?: string;
  /** existing 일 때 최근 출력(최대 BACKLOG_MAX). renderer 가 xterm 에 그대로 써서 화면을 복원한다. */
  backlog?: string;
}

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  title: string;
}

/** 터미널당 보관하는 출력 백로그 상한(글자). xterm 스크롤백 5000줄에 어림잡아 맞춘다 — 색·이동 시퀀스가 섞여 줄당 100자 안팎. */
const BACKLOG_MAX = 500_000;

/**
 * 백로그가 상한을 넘으면 줄 경계에서 자른다. 글자 수로만 자르면 이스케이프 시퀀스나 여러 바이트 글자 한가운데가 잘려
 * 복원한 화면 첫 줄이 깨진다. 상한 안에 줄바꿈이 하나도 없으면(한 줄짜리 진행 막대 등) 그냥 자른다.
 */
export function trimBacklog(s: string): string {
  if (s.length <= BACKLOG_MAX) return s;
  const cut = s.length - BACKLOG_MAX;
  const nl = s.indexOf("\n", cut);
  return nl === -1 ? s.slice(cut) : s.slice(nl + 1);
}

export type TerminalKind = "shell" | "command";

/**
 * 통합 터미널에 띄울 셸. macOS 는 사용자 로그인 셸(-l).
 * Windows 는 SHELL 을 보지 않는다(Git Bash 등이 남긴 /usr/bin/bash 같은 값은 띄울 수 없다) — PATH 의 pwsh.exe(PowerShell 7) →
 * 시스템 Windows PowerShell → COMSPEC(cmd.exe) 순. 로그인 셸 개념이 없어 인자는 없다.
 */
export function defaultShell(platform: NodeJS.Platform, env: Record<string, string | undefined>, exists: (p: string) => boolean): { file: string; args: string[] } {
  if (platform !== "win32") return { file: env.SHELL || process.env.SHELL || "/bin/zsh", args: ["-l"] };
  const w = path.win32;
  for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
    const p = w.join(dir, "pwsh.exe");
    if (exists(p)) return { file: p, args: [] };
  }
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const ps = w.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (exists(ps)) return { file: ps, args: [] };
  return { file: env.ComSpec || env.COMSPEC || w.join(root, "System32", "cmd.exe"), args: [] };
}

export interface TerminalManagerDeps {
  onData(tabId: string, data: string): void;
  /** kind="command" 는 openCommand 로 띄운 CLI(터미널 모드)가 끝난 것. 같은 id 의 가장 최근 pty 가 끝났을 때만 온다. */
  onExit(tabId: string, exitCode: number, kind: TerminalKind): void;
  /** 새 pty 가 생겼을 때 (renderer 가 탭을 추가하도록). */
  onOpen?(info: TerminalInfo): void;
  log?(line: string): void;
}

interface Entry {
  pty: IPty;
  shell: string;
  kind: TerminalKind;
  backlog: string;
  cwd: string;
}

/** node-pty 는 네이티브 모듈이라 로드 실패가 앱 전체를 죽이지 않도록 첫 사용 시점에 require 한다. */
function loadPty(): typeof import("node-pty") {
  ensureSpawnHelperExecutable();
  return createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
}

/**
 * yarn 1 이 prebuilds 의 실행 권한을 떨어뜨리면 spawn 이 "posix_spawnp failed" 로 실패한다.
 * postinstall 에서도 chmod 하지만, 패키지 앱(asar unpacked)에서도 안전하게 한 번 더 확인한다.
 */
function ensureSpawnHelperExecutable() {
  try {
    const dir = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(
      dir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0)
      fs.chmodSync(helper, 0o755);
  } catch {
    /* 읽기 전용 위치면 spawn 시점에 오류로 드러난다 */
  }
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  /**
   * id 별로 가장 최근에 띄운 pty. entries 와 달리 close() 로는 지우지 않고 그 pty 의 exit 가 왔을 때 지운다 —
   * 밀려났든(openCommand) 끊고 다시 띄웠든, 옛 pty 의 늦은 exit 를 새 것의 exit 로 오해하지 않기 위해서다.
   */
  private readonly latest = new Map<string, Entry>();

  constructor(private readonly deps: TerminalManagerDeps) {}

  open(
    tabId: string,
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): TerminalOpenResult {
    const cur = this.entries.get(tabId);
    if (cur) {
      this.safeResize(cur.pty, cols, rows);
      return {
        ok: true,
        existing: true,
        shell: cur.shell,
        pid: cur.pty.pid,
        backlog: cur.backlog,
      };
    }
    const { file: shell, args: shellArgs } = defaultShell(process.platform, env, (p) => fs.existsSync(p));
    // node-pty 는 cwd 가 없어도 spawn 자체는 성공하고 셸이 바로 죽는다. 미리 걸러서 이유를 알려 준다.
    if (!fs.existsSync(cwd)) {
      return {
        ok: false,
        existing: false,
        shell,
        error: mt("session.error.noCwdAt", { cwd }),
      };
    }
    try {
      const pty = loadPty().spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: Math.max(2, cols || 80),
        rows: Math.max(1, rows || 24),
        cwd,
        env: {
          ...env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: env.LANG || "ko_KR.UTF-8",
        },
      });
      const entry: Entry = { pty, shell, kind: "shell", backlog: "", cwd };
      this.wire(tabId, entry);
      this.entries.set(tabId, entry);
      this.latest.set(tabId, entry);
      this.deps.onOpen?.({
        id: tabId,
        kind: "shell",
        title: path.basename(shell),
      });
      this.deps.log?.(`open ${tabId} pid=${pty.pid} shell=${shell} cwd=${cwd}`);
      return { ok: true, existing: false, shell, pid: pty.pid };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`open ${tabId} 실패: ${message}`);
      return { ok: false, existing: false, shell, error: message };
    }
  }

  /**
   * 터미널 모드: 셸 대신 CLI(claude/codex)를 이 탭의 pty 로 직접 띄운다. 기존 셸은 끊는다.
   * 프로세스가 끝나면 onExit(kind="command") 가 와서 세션 제어가 앱으로 돌아간다.
   */
  openCommand(
    tabId: string,
    cwd: string,
    env: Record<string, string>,
    file: string,
    args: string[],
    cols = 100,
    rows = 30,
  ): TerminalOpenResult {
    this.close(tabId);
    // Windows 의 claude.cmd·codex.cmd 는 shim 대상(.exe·node .js)으로 띄운다. 못 읽으면 cmd.exe 를 거친다 —
    // CreateProcess 는 배치 파일을 직접 띄우지 못한다. 인자는 launchSpec 이 cmd.exe 규칙으로 인용해 두었으니 문자열 그대로 넘긴다.
    const spec = launchSpec(file, args);
    const [command, commandArgs]: [string, string[] | string] = spec.shell
      ? [resolvePtyCommand(process.env.ComSpec || "cmd.exe", env), `/d /s /c "${[spec.command, ...spec.args].join(" ")}"`]
      : [resolvePtyCommand(spec.command, env), spec.args];
    try {
      const pty = loadPty().spawn(command, commandArgs, {
        name: "xterm-256color",
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd,
        env: {
          ...env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: env.LANG || "ko_KR.UTF-8",
        },
      });
      const entry: Entry = {
        pty,
        shell: `${path.basename(file)} ${args.join(" ")}`.trim(),
        kind: "command",
        backlog: "",
        cwd,
      };
      this.wire(tabId, entry);
      this.entries.set(tabId, entry);
      this.latest.set(tabId, entry);
      this.deps.onOpen?.({
        id: tabId,
        kind: "command",
        title: path.basename(file),
      });
      this.deps.log?.(
        `command ${tabId} pid=${pty.pid} ${entry.shell} cwd=${cwd}`,
      );
      return { ok: true, existing: false, shell: entry.shell, pid: pty.pid };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`command ${tabId} 실패: ${message}`);
      return { ok: false, existing: false, shell: file, error: message };
    }
  }

  /** 살아 있는 사용자 셸(kind=shell)들 — 외부 CLI 감지용. termId 는 "<채팅탭 id>:<n>" 이라 앞부분이 탭 id 다. */
  shells(): { termId: string; tabId: string; pid: number; cwd: string }[] {
    const out: { termId: string; tabId: string; pid: number; cwd: string }[] = [];
    for (const [id, e] of this.entries) if (e.kind === "shell") out.push({ termId: id, tabId: id.split(":")[0], pid: e.pty.pid, cwd: e.cwd });
    return out;
  }

  kindOf(tabId: string): TerminalKind | null {
    return this.entries.get(tabId)?.kind ?? null;
  }

  private wire(tabId: string, entry: Entry) {
    entry.pty.onData((data) => {
      // 밀려난 옛 pty 가 늦게 뱉는 출력은 새 터미널에 섞이면 안 된다(renderer 는 출력을 받으면 종료 표시도 지운다).
      if (this.latest.get(tabId) !== entry) return;
      entry.backlog = trimBacklog(entry.backlog + data);
      this.deps.onData(tabId, data);
    });
    entry.pty.onExit(({ exitCode }) => {
      // 같은 id 로 더 새 pty 가 생긴 뒤에 오는 옛 pty 의 exit 는 아무에게도 알리지 않는다 — 새 것에 종료 표시가 붙거나
      // (CLI 면) 세션 제어가 엉뚱하게 앱으로 돌아간다. 새 것이 먼저 끝난 뒤에 와도 마찬가지다.
      // close() 로 지운 뒤 새 pty 가 없으면 여전히 최신이라 그대로 알린다: 하이브리드 CLI 를 끊는 경로가 그 신호로 세션 제어를 되찾는다.
      if (this.latest.get(tabId) !== entry) return;
      this.latest.delete(tabId);
      if (this.entries.get(tabId) === entry) this.entries.delete(tabId);
      this.deps.onExit(tabId, exitCode, entry.kind);
    });
  }

  /**
   * ⌘K. 백로그를 비우고 그 지점에 TERMINAL_CLEAR_MARK 를 출력 스트림으로 보낸다 — renderer 는 앞선 출력을 다 그린 뒤
   * 그 표시에서 화면을 지우므로, "지우기 전" 의 경계가 양쪽에서 같다. 백로그가 남아 있으면 다음 복원 때 지운 출력이 되살아난다.
   */
  clearBacklog(tabId: string): void {
    const cur = this.entries.get(tabId);
    if (!cur) return;
    cur.backlog = "";
    this.deps.onData(tabId, TERMINAL_CLEAR_MARK);
  }

  write(tabId: string, data: string): boolean {
    const cur = this.entries.get(tabId);
    if (!cur) return false;
    cur.pty.write(data);
    return true;
  }

  resize(tabId: string, cols: number, rows: number): void {
    const cur = this.entries.get(tabId);
    if (cur) this.safeResize(cur.pty, cols, rows);
  }

  has(tabId: string): boolean {
    return this.entries.has(tabId);
  }

  /** 접두어(보통 "<채팅탭 id>:")로 시작하는 터미널 목록. 생성 순서. */
  list(prefix: string): TerminalInfo[] {
    const out: TerminalInfo[] = [];
    for (const [id, e] of this.entries) {
      if (id.startsWith(prefix))
        out.push({
          id,
          kind: e.kind,
          title:
            e.kind === "shell" ? path.basename(e.shell) : e.shell.split(" ")[0],
        });
    }
    return out;
  }

  /** 채팅 탭을 닫을 때: 그 탭의 터미널을 모두 종료. */
  closePrefix(prefix: string): void {
    for (const id of [...this.entries.keys()])
      if (id.startsWith(prefix)) this.close(id);
  }

  /** 탭이 닫히거나 사용자가 종료를 눌렀을 때. exit 콜백은 pty 가 실제로 죽으면 온다. */
  close(tabId: string): void {
    const cur = this.entries.get(tabId);
    if (!cur) return;
    this.entries.delete(tabId);
    try {
      cur.pty.kill();
    } catch {
      /* 이미 죽은 프로세스 */
    }
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  private safeResize(pty: IPty, cols: number, rows: number) {
    if (cols < 2 || rows < 1) return;
    try {
      pty.resize(cols, rows);
    } catch {
      /* 종료 직후의 resize 는 무시 */
    }
  }
}
