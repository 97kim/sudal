// Skill(codex:rescue) 이 codex-companion 으로 띄운 Codex 의 진행을 카드 안에 흘린다.
// companion 은 저장소 cwd 에서 `codex app-server` 를 띄우므로 그 rollout(session_meta.cwd = 탭 cwd)이 ~/.codex/sessions 에 새로 생긴다.
// Skill·Agent 카드가 열려 있는 동안 "탭 cwd 로, 카드 시작 이후 만들어진, 앱 자신의 Codex 탭이 아닌" rollout 을 찾아 tail 하고,
// 항목(명령·패치·말)을 subagent_activity(via: codex) 로 바꿔 그 카드에 붙인다. 화면 전용 — 기록엔 남지 않는다.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { parsePsTree, processCwd } from "./cli-watch";
import type { ChatEvent, SubagentActivityEvent } from "@shared/chat-events";
import { TranscriptWatcher, mapCodexRolloutLine, readCodexRolloutMeta } from "./transcript-mirror";
import { sameCwd } from "@shared/any-path";

export interface CompanionMirrorOptions {
  codexRoot: string;
  cwd: string;
  /** 카드가 시작된 시각 — 이보다 먼저 만들어진 rollout 은 보지 않는다. */
  since: number;
  parentToolUseId: string;
  /** 앱 자신의 Codex 탭 세션 id(이건 companion 이 아니다). */
  excludeSessionIds: () => Set<string>;
  onEvents: (events: SubagentActivityEvent[]) => void;
  pollMs?: number;
  now?: () => number;
  /** 프로세스 트리 검색의 뿌리(기본 이 프로세스). 테스트에서 끈다(null). */
  rootPid?: number | null;
}

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout))));
}

/**
 * 프로세스 트리로 companion 의 Codex 를 정확히 찾는다: 이 앱(rootPid)의 자손 중 comm 이 codex 이고, 조상에 claude(SDK 가 띄운 CLI)가 있는 것.
 * 앱이 직접 띄운 Codex 탭의 app-server 는 조상에 claude 가 없어 걸러진다. cwd 가 맞는 프로세스의 열린 rollout 파일(lsof)을 돌려준다.
 */
export async function findCompanionRolloutByProcess(rootPid: number, cwd: string): Promise<string | null> {
  // Windows 에는 열린 파일·cwd 를 읽을 lsof 가 없다 — cwd·시각 기반 추정(findCompanionRollout)만 쓴다.
  if (process.platform === "win32") return null;
  const tree = parsePsTree(await sh("ps", ["-axo", "pid=,ppid=,comm="]));
  if (tree.size === 0) return null;
  const base = (comm: string) => comm.split("/").pop() ?? comm;
  const norm = (p: string) => p.replace(/\/+$/, "");
  for (const [pid, { comm }] of tree) {
    if (base(comm) !== "codex") continue;
    // 조상 사슬: rootPid 까지 올라가며 claude 를 지나야 한다
    let p = tree.get(pid)?.ppid ?? 0;
    let viaClaude = false;
    let underRoot = false;
    for (let hops = 0; hops < 32 && p > 1; hops++) {
      if (p === rootPid) {
        underRoot = true;
        break;
      }
      if (base(tree.get(p)?.comm ?? "") === "claude") viaClaude = true;
      p = tree.get(p)?.ppid ?? 0;
    }
    if (!underRoot || !viaClaude) continue;
    const pcwd = await processCwd(pid);
    if (!pcwd || norm(pcwd) !== norm(cwd)) continue;
    const files = await sh("lsof", ["-a", "-p", String(pid), "-Fn"]);
    const rollout = files.split("\n").map((l) => (l.startsWith("n/") ? l.slice(1) : "")).find((f) => /\/sessions\/.*rollout-.*\.jsonl$/.test(f));
    if (rollout) return rollout;
  }
  return null;
}

/** 앱이 만든 rollout 의 originator. 이 값이면 companion 이 아니다. */
const OWN_ORIGINATOR = "sudal";

/** cwd 가 맞고 since 이후에 생긴 rollout 중 가장 최근 것. 제외 목록·앱 자신의 것은 건너뛴다. */
export function findCompanionRollout(root: string, opts: { cwd: string; since: number; exclude: Set<string> }): string | null {
  const days: string[] = [];
  try {
    for (const y of fs.readdirSync(root).sort().reverse().slice(0, 2)) {
      const yp = path.join(root, y);
      for (const m of fs.readdirSync(yp).sort().reverse().slice(0, 2)) {
        const mp = path.join(yp, m);
        for (const dd of fs.readdirSync(mp).sort().reverse().slice(0, 3)) days.push(path.join(mp, dd));
      }
    }
  } catch {
    return null;
  }
  let best: { file: string; birth: number } | null = null;
  for (const dir of days) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const birth = st.birthtimeMs || st.mtimeMs;
      if (birth < opts.since - 2000) continue;
      if (best && birth <= best.birth) continue;
      const meta = readCodexRolloutMeta(file);
      if (!meta?.cwd || !sameCwd(meta.cwd, opts.cwd)) continue;
      if (meta.originator === OWN_ORIGINATOR) continue;
      if (meta.sessionId && opts.exclude.has(meta.sessionId)) continue;
      best = { file, birth };
    }
  }
  return best?.file ?? null;
}

/** rollout 미러 이벤트(tool_use/assistant_text …) → 카드에 붙일 하위 에이전트 활동. 사용자 메시지·결과는 버린다. */
export function rolloutToSubagentActivity(events: ChatEvent[], parentToolUseId: string, ts: number): SubagentActivityEvent[] {
  const out: SubagentActivityEvent[] = [];
  for (const e of events) {
    if (e.type === "tool_use") {
      const input: Record<string, string> = {};
      const o = (e.input ?? {}) as Record<string, unknown>;
      if (typeof o.command === "string") input.command = o.command.slice(0, 200);
      if (Array.isArray(o.changes)) input.path = (o.changes as { path?: string }[]).map((c) => c.path ?? "").filter(Boolean).join(", ").slice(0, 200);
      out.push({ type: "subagent_activity", ts, parentToolUseId, tool: e.name, input, via: "codex" });
    } else if (e.type === "assistant_text") {
      // 마지막 의미 있는 줄 — 코드 펜스(```)만 있는 줄은 건너뛴다
      const line = e.text.trim().split("\n").filter((l) => l.trim() && !/^\s*(```|~~~)/.test(l)).pop() ?? "";
      if (line) out.push({ type: "subagent_activity", ts, parentToolUseId, text: line.length > 160 ? line.slice(0, 160) + "…" : line, via: "codex" });
    }
  }
  return out;
}

export class CompanionMirror {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: TranscriptWatcher | null = null;
  private fileFound: string | null = null;

  constructor(private readonly opts: CompanionMirrorOptions) {}

  get parentToolUseId(): string {
    return this.opts.parentToolUseId;
  }

  file(): string | null {
    return this.fileFound;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 2000);
  }

  private ticking = false;

  private tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    void this.resolve()
      .then((file) => {
        if (!file || file === this.fileFound) return;
        // 프로세스로 확정한 파일이 지금 보던 것과 다르면(먼저 잡은 게 엉뚱한 세션) 갈아탄다
        this.watcher?.stop();
        this.watcher = null;
        this.attach(file);
      })
      .finally(() => {
        this.ticking = false;
      });
  }

  /** 1순위: 프로세스 트리(정확). 2순위: 아직 파일을 못 잡았을 때만 cwd·시각 기반 추정. */
  private async resolve(): Promise<string | null> {
    const rootPid = this.opts.rootPid === undefined ? process.pid : this.opts.rootPid;
    if (rootPid !== null) {
      const byProc = await findCompanionRolloutByProcess(rootPid, this.opts.cwd);
      if (byProc) return byProc;
    }
    if (this.watcher) return null;
    return findCompanionRollout(this.opts.codexRoot, { cwd: this.opts.cwd, since: this.opts.since, exclude: this.opts.excludeSessionIds() });
  }

  private attach(file: string): void {
    this.fileFound = file;
    const now = this.opts.now ?? Date.now;
    this.watcher = new TranscriptWatcher({
      resolveFile: () => file,
      map: mapCodexRolloutLine,
      onEvents: (events) => {
        const acts = rolloutToSubagentActivity(events, this.opts.parentToolUseId, now());
        if (acts.length) this.opts.onEvents(acts);
      },
      skipExisting: false,
      intervalMs: Math.min(700, this.opts.pollMs ?? 700),
    });
    this.watcher.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.stop();
    this.watcher = null;
  }
}
