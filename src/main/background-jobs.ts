// Claude Code 플러그인이 남기는 백그라운드 작업 목록을 읽어 "탭은 놀고 있는데 아직 도는 일" 을 앱이 알게 한다.
//
// 왜 파일을 읽나: 백그라운드로 맡긴 작업은 프로세스가 앱에서 떨어져 나가(부모가 launchd) 프로세스 계보로 못 찾고,
// 턴이 끝나면 하위 에이전트 미러도 꺼진다. 플러그인이 쓰는 `<claude>/plugins/data/<plugin>/state/<작업공간>/state.json`
// 의 jobs 배열이 유일하게 남는 단서다. 남의 파일이라 형식이 바뀔 수 있으므로 못 읽으면 조용히 넘어간다(기능만 꺼진다).
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isActiveJob, mergeJobs, parseBackgroundJob, type BackgroundJobDto } from "@shared/background-jobs";
import { mt } from "./i18n";

/** 파일이 바뀐 뒤 이만큼 조용하면 다시 읽는다(한 번 쓰는 데 여러 이벤트가 온다). */
const DEBOUNCE_MS = 400;
/**
 * 감시만 믿을 수 없어 주기적으로도 읽는다. 앱을 켤 때 플러그인 디렉토리가 아직 없으면 걸 감시자가 없고,
 * 나중에 만들어져도 알 길이 없다. 파일 몇 개를 읽는 정도라 계속 돌아도 부담이 없다.
 */
const POLL_MS = 4000;

export function claudeDataRoot(): string {
  // 검증용 우회 — 실제 플러그인 데이터를 건드리지 않고 작업 목록을 흉내 내게 한다(SUDAL_APPROVED_ROOTS 와 같은 결).
  const override = process.env.SUDAL_JOBS_ROOT?.trim();
  if (override) return override;
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(cfg && cfg.length > 0 ? cfg : join(homedir(), ".claude"), "plugins", "data");
}

/** `<data>/<plugin>/state/<작업공간>/state.json` 을 모두 찾는다. */
async function findStateFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let plugins: string[] = [];
  try {
    plugins = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out; // 플러그인을 안 쓰는 설치
  }
  for (const p of plugins) {
    const stateDir = join(root, p, "state");
    let spaces: string[] = [];
    try {
      spaces = (await readdir(stateDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const s of spaces) out.push(join(stateDir, s, "state.json"));
  }
  return out;
}

async function readJobs(file: string): Promise<BackgroundJobDto[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const j = JSON.parse(text) as { jobs?: unknown };
    if (!Array.isArray(j.jobs)) return [];
    const root = file;
    return j.jobs.map((x) => parseBackgroundJob(mt, x, root)).filter((x): x is BackgroundJobDto => x !== null);
  } catch {
    return []; // 쓰는 중이라 반쪽인 JSON — 다음 읽기에 잡힌다
  }
}

export interface BackgroundJobsEvents {
  /** 도는 작업 목록이 바뀌었다(시작·종료·새 작업). */
  onChanged(active: BackgroundJobDto[]): void;
  /** 작업 하나가 끝났다. 알림은 이걸로 — onChanged 는 도는 목록만 준다. */
  onFinished(job: BackgroundJobDto): void;
}

/**
 * 플러그인 작업 목록 감시. 앱에 하나만 둔다.
 * 시작할 때 이미 끝나 있던 작업은 "방금 끝난 것" 으로 치지 않는다(앱을 켤 때마다 옛 알림이 오지 않게).
 */
export class BackgroundJobWatcher {
  private watchers: FSWatcher[] = [];
  /** 이미 감시자를 건 디렉토리 — 새 작업공간이 생기면 그때 붙인다. */
  private watched = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private known = new Map<string, BackgroundJobDto>();
  private active: BackgroundJobDto[] = [];
  private started = false;
  private scanning = false;

  constructor(
    private readonly events: BackgroundJobsEvents,
    private readonly root = claudeDataRoot(),
  ) {}

  /** 지금 도는 작업들. */
  current(): BackgroundJobDto[] {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 첫 읽기는 기준선 — 이미 끝난 작업을 알림으로 만들지 않는다(감시자도 여기서 붙는다).
    await this.scan(true);
    this.poll = setInterval(() => this.schedule(), POLL_MS);
  }

  stop(): void {
    this.started = false;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* 이미 닫힘 */
      }
    }
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
  }

  private tryWatch(dir: string, recursive = false) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    try {
      const w = watch(dir, { recursive, persistent: false }, () => this.schedule());
      w.on("error", () => {
        /* 디렉토리가 사라지면 조용히 포기한다 — 폴링이 받쳐 준다 */
      });
      this.watchers.push(w);
    } catch {
      // 아직 없는 디렉토리 — 다음 읽기에서 생겼으면 그때 붙인다
      this.watched.delete(dir);
    }
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan(false);
    }, DEBOUNCE_MS);
  }

  private async scan(baseline: boolean) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const files = await findStateFiles(this.root);
      // 새 작업공간이 생겼으면 그 디렉토리에도 감시자를 붙인다(루트 재귀 감시는 macOS 만 되고, 루트가 없을 때도 있다)
      this.tryWatch(this.root, true);
      for (const f of files) this.tryWatch(join(f, ".."));
      const all = mergeJobs((await Promise.all(files.map(readJobs))).flat());
      const finished: BackgroundJobDto[] = [];
      for (const job of all) {
        const key = `${job.root}|${job.id}`;
        const prev = this.known.get(key);
        this.known.set(key, job);
        // 돌던 것이 끝났을 때만 알린다. 기준선 읽기와 "처음 보는데 이미 끝난 것" 은 건너뛴다.
        if (!baseline && prev && isActiveJob(prev.status) && !isActiveJob(job.status)) finished.push(job);
      }
      const active = all.filter((j) => isActiveJob(j.status));
      const changed = active.length !== this.active.length || active.some((j, i) => j.id !== this.active[i]?.id || j.status !== this.active[i]?.status);
      this.active = active;
      if (changed) this.events.onChanged(active);
      for (const j of finished) this.events.onFinished(j);
    } finally {
      this.scanning = false;
    }
  }
}
