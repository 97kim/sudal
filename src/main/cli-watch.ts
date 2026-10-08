// 통합 터미널(사용자 셸)에서 직접 띄운 Claude Code·Codex 를 알아챈다.
// 셸 pty 의 자손 프로세스 목록을 주기적으로 훑어(ps 한 번) claude/codex 실행 파일이 있으면 "외부 CLI 가 시작됐다" 고 알리고,
// 사라지면 "끝났다" 고 알린다. 세션 매니저는 그 동안 기록 파일을 미러해 채팅에 따라 보여 준다.
import { execFile } from "node:child_process";
import type { Provider } from "@shared/ipc";

export interface CliProcess {
  pid: number;
  provider: Provider;
  /** `codex resume <id>` · `claude --resume <id>` 처럼 명령에 세션 id 가 있으면 그것. 첫 턴 전에도 어떤 세션인지 알 수 있다. */
  resumeId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 실행 명령에서 이어받는 세션 id 를 뽑는다. `--last` 처럼 id 가 없거나 세션 이름이면 null. */
export function parseResumeId(args: string): string | null {
  const tok = args.trim().split(/\s+/);
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] !== "resume" && tok[i] !== "--resume" && tok[i] !== "-r") continue;
    for (let j = i + 1; j < tok.length; j++) {
      if (tok[j].startsWith("-")) continue; // --last 같은 플래그는 건너뛴다
      return UUID.test(tok[j]) ? tok[j] : null;
    }
    return null;
  }
  return null;
}

export interface ShellInfo {
  tabId: string;
  pid: number;
  cwd: string;
}

/** `ps -axo pid=,ppid=,comm=` 출력을 pid → { ppid, comm } 으로. */
export function parsePsTree(out: string): Map<number, { ppid: number; comm: string }> {
  const m = new Map<number, { ppid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const t = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (t) m.set(Number(t[1]), { ppid: Number(t[2]), comm: t[3] });
  }
  return m;
}

function providerOf(comm: string): Provider | null {
  // Windows 는 "claude.exe" 꼴이라 \ 로도 나누고 .exe 를 뗀다.
  const base = (comm.split(/[\\/]/).pop() ?? comm).replace(/\.exe$/i, "");
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}

/** root 의 자손 가운데 CLI 프로세스. 가장 가까운(얕은) 것부터. */
export function findCliDescendants(tree: Map<number, { ppid: number; comm: string }>, root: number): CliProcess[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of tree) {
    const arr = children.get(ppid);
    if (arr) arr.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: CliProcess[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) {
      const p = providerOf(tree.get(c)?.comm ?? "");
      if (p) out.push({ pid: c, provider: p });
      queue.push(c);
    }
  }
  return out;
}

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout))),
  );
}

const IS_WIN = process.platform === "win32";

export type ProcTree = Map<number, { ppid: number; comm: string }>;

/**
 * Windows: `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json` 출력을 트리와 명령 줄로.
 * npm 으로 깐 CLI 는 이름이 node.exe 라, 명령 줄에 패키지 경로가 보이면 그 CLI 이름으로 바꿔 둔다.
 */
export function parseWinProcessJson(json: string): { tree: ProcTree; args: Map<number, string> } {
  const tree: ProcTree = new Map();
  const args = new Map<number, string>();
  let rows: unknown;
  try {
    rows = JSON.parse(json.trim() || "[]");
  } catch {
    return { tree, args };
  }
  for (const r of (Array.isArray(rows) ? rows : [rows]) as (Record<string, unknown> | null)[]) {
    const pid = Number(r?.ProcessId);
    if (!r || !Number.isInteger(pid) || pid <= 0) continue;
    const cmdline = typeof r.CommandLine === "string" ? r.CommandLine : "";
    let comm = typeof r.Name === "string" ? r.Name : "";
    if (/^node(\.exe)?$/i.test(comm)) {
      if (/[\\/]@anthropic-ai[\\/]claude-code[\\/]/i.test(cmdline)) comm = "claude";
      else if (/[\\/]@openai[\\/]codex[\\/]/i.test(cmdline)) comm = "codex";
    }
    tree.set(pid, { ppid: Number(r.ParentProcessId) || 0, comm });
    args.set(pid, cmdline);
  }
  return { tree, args };
}

type WinSnapshot = ReturnType<typeof parseWinProcessJson>;

// PowerShell 은 뜨는 데만 수백 ms 가 든다 — 한 번 읽은 목록을 잠깐 같이 쓴다(같은 틱의 명령 줄 조회 등).
const WIN_SNAPSHOT_TTL_MS = 1000;
let winSnap: { at: number; p: Promise<WinSnapshot> } | null = null;

function winSnapshot(): Promise<WinSnapshot> {
  if (winSnap && Date.now() - winSnap.at < WIN_SNAPSHOT_TTL_MS) return winSnap.p;
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const p = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 10_000).then(parseWinProcessJson);
  winSnap = { at: Date.now(), p };
  return p;
}

/** 모든 프로세스의 pid → { ppid, comm }. 못 읽으면 빈 맵. */
export async function processTree(): Promise<ProcTree> {
  if (IS_WIN) return (await winSnapshot()).tree;
  return parsePsTree(await run("ps", ["-axo", "pid=,ppid=,comm="]));
}

/** 프로세스의 실행 명령(ps). 못 읽으면 빈 문자열. */
export async function processArgs(pid: number): Promise<string> {
  if (IS_WIN) return (await winSnapshot()).args.get(pid)?.trim() ?? "";
  return (await run("ps", ["-p", String(pid), "-o", "args="])).trim();
}

/** 프로세스의 작업 디렉토리(macOS: lsof). 못 읽으면 null. Windows 는 다른 프로세스의 cwd 를 읽을 길이 없어 늘 null(셸 cwd 로 대신한다). */
export async function processCwd(pid: number): Promise<string | null> {
  if (IS_WIN) return null;
  const out = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const n = out.split("\n").find((l) => l.startsWith("n/"));
  return n ? n.slice(1) : null;
}

export interface ShellCliMonitorDeps {
  shells(): ShellInfo[];
  onStart(tabId: string, cli: CliProcess & { cwd: string; resumeId: string | null }): void;
  onExit(tabId: string, pid: number): void;
  /** 테스트용: ps 출력을 대신 준다. */
  ps?: () => Promise<string>;
  cwdOf?: (pid: number) => Promise<string | null>;
  argsOf?: (pid: number) => Promise<string>;
  intervalMs?: number;
}

/** 셸이 하나라도 있는 동안만 주기적으로 ps 를 돈다. 탭당 CLI 하나만 추적한다(가장 얕은 것). */
export class ShellCliMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tracked = new Map<string, number>(); // tabId → CLI pid
  private ticking = false;

  constructor(private readonly deps: ShellCliMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    // Windows 는 한 번 훑는 데 PowerShell 을 띄워야 해 간격을 늘린다.
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? (IS_WIN ? 3000 : 1500));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const shells = this.deps.shells();
      const live = new Map<string, ShellInfo>();
      for (const s of shells) if (!live.has(s.tabId)) live.set(s.tabId, s);
      // 셸이 없어진 탭의 CLI 는 끝난 것
      for (const [tabId, pid] of [...this.tracked]) {
        if (!shells.some((s) => s.tabId === tabId)) {
          this.tracked.delete(tabId);
          this.deps.onExit(tabId, pid);
        }
      }
      if (shells.length === 0) return;
      const tree = this.deps.ps ? parsePsTree(await this.deps.ps()) : await processTree();
      for (const [tabId] of live) {
        const cur = this.tracked.get(tabId);
        // 같은 탭의 셸 여러 개(터미널 탭)를 모두 본다
        const found = shells.filter((s) => s.tabId === tabId).flatMap((s) => findCliDescendants(tree, s.pid).map((c) => ({ ...c, shellCwd: s.cwd })));
        if (cur !== undefined) {
          if (!tree.has(cur)) {
            this.tracked.delete(tabId);
            this.deps.onExit(tabId, cur);
          }
          continue;
        }
        const first = found[0];
        if (!first) continue;
        this.tracked.set(tabId, first.pid);
        const cwd = (await (this.deps.cwdOf ?? processCwd)(first.pid)) ?? first.shellCwd;
        const resumeId = parseResumeId(await (this.deps.argsOf ?? processArgs)(first.pid));
        // cwd·명령을 읽는 사이 끝났을 수 있다
        if (this.tracked.get(tabId) !== first.pid) continue;
        this.deps.onStart(tabId, { pid: first.pid, provider: first.provider, cwd, resumeId });
      }
    } finally {
      this.ticking = false;
    }
  }
}
