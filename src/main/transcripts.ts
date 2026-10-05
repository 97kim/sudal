// 로컬 트랜스크립트 스캐너 — 터미널에서 쓴 사용량까지 합산한다.
//   Claude Code: ~/.claude/projects/<cwd-encoded>/*.jsonl  (assistant 항목의 message.usage, 메시지 id 중복 제거)
//   Codex:       ~/.codex/sessions/**/*.jsonl              (event_msg/token_count 의 누적값 차분)
// 파서는 줄 배열을 받는 순수 함수(테스트 가능). 스캐너는 mtime+size 기준 증분 캐시와 fs.watch 를 맡는다.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { UsageRecord } from "@shared/usage";
import type { ProviderRateLimitDto, RateLimitWindowDto, Provider } from "@shared/ipc";

const HOUR = 3_600_000;

export type CodexRateLimit = ProviderRateLimitDto;

export interface ParseResult {
  records: UsageRecord[];
  rateLimit?: CodexRateLimit;
}

/** (sessionId, model, cwd, 시간 버킷) 으로 합쳐 캐시를 작게 유지한다. */
export function compactRecords(records: UsageRecord[]): UsageRecord[] {
  const map = new Map<string, UsageRecord>();
  for (const r of records) {
    const bucket = Math.floor(r.ts / HOUR) * HOUR;
    const key = `${r.sessionId}|${r.model}|${r.cwd}|${bucket}`;
    const cur = map.get(key);
    if (!cur) map.set(key, { ...r, ts: bucket });
    else {
      cur.input += r.input;
      cur.output += r.output;
      cur.cacheRead += r.cacheRead;
      cur.cacheWrite += r.cacheWrite;
      cur.requests += r.requests;
    }
  }
  return [...map.values()];
}

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Claude Code 트랜스크립트. 스트리밍 중간 저장으로 같은 message.id 가 여러 줄 나오므로
 * id 별로 마지막(가장 큰 usage) 하나만 센다. `<synthetic>` 모델은 API 호출이 아니라 제외.
 */
export function parseClaudeLines(lines: Iterable<string>): ParseResult {
  const byId = new Map<string, UsageRecord>();
  let seq = 0;
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    const e = safeJson(line);
    if (!e || e.type !== "assistant") continue;
    const msg = e.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    const model = typeof msg.model === "string" ? msg.model : "";
    if (!usage || !model || model === "<synthetic>") continue;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const id = typeof msg.id === "string" ? msg.id : `noid-${seq++}`;
    const rec: UsageRecord = {
      ts,
      provider: "claude",
      model,
      cwd: typeof e.cwd === "string" ? e.cwd : "",
      sessionId: typeof e.sessionId === "string" ? e.sessionId : "",
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      requests: 1,
    };
    const prev = byId.get(id);
    // 같은 id 면 토큰이 더 큰 쪽(최종본)을 남긴다.
    if (!prev || rec.output + rec.input >= prev.output + prev.input) byId.set(id, rec);
  }
  return { records: compactRecords([...byId.values()]) };
}

/**
 * Codex 세션 롤아웃. token_count 의 total_token_usage 는 누적값이라 직전 값과의 차분이 그 호출의 사용량.
 * 같은 누적값이 반복되면(rate limit 갱신만) 건너뛴다. 모델은 직전 turn_context 의 model.
 */
export function parseCodexLines(lines: Iterable<string>): ParseResult {
  const records: UsageRecord[] = [];
  let cwd = "";
  let sessionId = "";
  let model = "";
  let prev = { input: 0, cached: 0, output: 0 };
  let rateLimit: CodexRateLimit | undefined;

  for (const line of lines) {
    if (!line.includes("session_meta") && !line.includes("turn_context") && !line.includes("token_count")) continue;
    const e = safeJson(line);
    if (!e) continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "session_meta") {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      const id = payload.id ?? payload.session_id;
      if (typeof id === "string") sessionId = id;
      continue;
    }
    if (e.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (e.type !== "event_msg" || payload.type !== "token_count") continue;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;

    // primary/secondary 는 플랜마다 다르다 (primary 가 7일 창이고 secondary 가 null 인 계정도 있다).
    // 위치가 아니라 창 길이로 세션(≤6시간)/주간을 나눈다.
    const limits = payload.rate_limits as Record<string, unknown> | null | undefined;
    if (limits) {
      let session: RateLimitWindowDto | null = null;
      let weekly: RateLimitWindowDto | null = null;
      for (const w of [codexWindow(limits.primary), codexWindow(limits.secondary)]) {
        if (!w) continue;
        if (w.windowMinutes <= 360) session ??= w;
        else weekly ??= w;
      }
      if (session || weekly) rateLimit = { session, weekly, modelWeekly: null, observedAt: ts };
    }

    const info = payload.info as Record<string, unknown> | null | undefined;
    const total = info?.total_token_usage as Record<string, unknown> | undefined;
    if (!total) continue;
    const cur = {
      input: num(total.input_tokens),
      cached: num(total.cached_input_tokens),
      output: num(total.output_tokens),
    };
    const dIn = cur.input - prev.input;
    const dCached = cur.cached - prev.cached;
    const dOut = cur.output - prev.output;
    prev = cur;
    if (dIn <= 0 && dOut <= 0) continue; // 반복 이벤트 또는 리셋
    records.push({
      ts,
      provider: "codex",
      model: model || "codex-unknown",
      cwd,
      sessionId,
      // OpenAI 의 input_tokens 는 캐시 히트를 포함한다.
      input: Math.max(0, dIn - Math.max(0, dCached)),
      output: Math.max(0, dOut),
      cacheRead: Math.max(0, dCached),
      cacheWrite: 0,
      requests: 1,
    });
  }
  return { records: compactRecords(records), rateLimit };
}

function codexWindow(raw: unknown): RateLimitWindowDto | null {
  const w = raw as Record<string, unknown> | null | undefined;
  if (!w || typeof w.used_percent !== "number") return null;
  return { usedPercent: w.used_percent, windowMinutes: num(w.window_minutes), resetsAt: num(w.resets_at) };
}

// ===== 스캐너 =====

interface FileCache {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
  rateLimit?: CodexRateLimit;
}

interface CacheFile {
  version: 4;
  files: Record<string, FileCache>;
}

export interface ScanStatus {
  scanning: boolean;
  files: number;
  records: number;
  lastScanAt: number | null;
  lastScanMs: number;
  codexRateLimit: CodexRateLimit | null;
  roots: { claude: string; codex: string };
}

export interface ScannerOptions {
  claudeDir: string;
  codexDir: string;
  cachePath: string;
  onChange?: () => void;
}

export class UsageScanner {
  private cache: CacheFile = { version: 4, files: {} };
  private status: ScanStatus;
  private watchers: fs.FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: ScannerOptions) {
    this.status = {
      scanning: false,
      files: 0,
      records: 0,
      lastScanAt: null,
      lastScanMs: 0,
      codexRateLimit: null,
      roots: { claude: opts.claudeDir, codex: opts.codexDir },
    };
    this.loadCache();
  }

  getStatus(): ScanStatus {
    return { ...this.status };
  }

  records(): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const f of Object.values(this.cache.files)) out.push(...f.records);
    return out;
  }

  /** 전체 1회 스캔. 캐시와 mtime/size 가 같으면 파싱을 건너뛴다. */
  scan(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doScan().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doScan(): Promise<void> {
    const started = Date.now();
    this.status.scanning = true;
    const seen = new Set<string>();
    let changed = false;

    const targets: { file: string; kind: Provider }[] = [];
    for (const f of listFiles(this.opts.claudeDir, ".jsonl")) targets.push({ file: f, kind: "claude" });
    for (const f of listFiles(this.opts.codexDir, ".jsonl")) targets.push({ file: f, kind: "codex" });

    for (const { file, kind } of targets) {
      seen.add(file);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const cached = this.cache.files[file];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      try {
        const result = kind === "claude" ? await parseFile(file, parseClaudeLines) : await parseFile(file, parseCodexLines);
        this.cache.files[file] = { mtimeMs: st.mtimeMs, size: st.size, records: result.records, rateLimit: result.rateLimit };
        changed = true;
      } catch (e) {
        console.warn(`[usage] parse 실패 ${file}:`, e instanceof Error ? e.message : e);
      }
    }
    for (const file of Object.keys(this.cache.files)) {
      if (!seen.has(file)) {
        delete this.cache.files[file];
        changed = true;
      }
    }

    let latestRl: CodexRateLimit | null = null;
    let records = 0;
    for (const f of Object.values(this.cache.files)) {
      records += f.records.length;
      if (f.rateLimit && (!latestRl || f.rateLimit.observedAt > latestRl.observedAt)) latestRl = f.rateLimit;
    }
    this.status = {
      ...this.status,
      scanning: false,
      files: Object.keys(this.cache.files).length,
      records,
      lastScanAt: Date.now(),
      lastScanMs: Date.now() - started,
      codexRateLimit: latestRl,
    };
    if (changed) this.saveCache();
    this.opts.onChange?.();
  }

  /** 두 루트를 재귀 감시. 변경 후 2초 정지하면 재스캔. */
  watch(): void {
    this.unwatch();
    for (const dir of [this.opts.claudeDir, this.opts.codexDir]) {
      if (!fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: true }, () => this.schedule());
        w.on("error", (e) => console.warn("[usage] watch error:", e));
        this.watchers.push(w);
      } catch (e) {
        console.warn(`[usage] watch 실패 ${dir}:`, e);
      }
    }
  }

  unwatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.scan();
    }, 2000);
  }

  private loadCache() {
    try {
      if (!fs.existsSync(this.opts.cachePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.opts.cachePath, "utf8")) as CacheFile;
      if (parsed?.version === 4 && parsed.files) this.cache = parsed;
    } catch (e) {
      console.warn("[usage] cache 로드 실패, 새로 스캔:", e);
    }
  }

  private saveCache() {
    try {
      fs.mkdirSync(path.dirname(this.opts.cachePath), { recursive: true });
      // 앱 인스턴스가 둘(dev + 패키지) 떠 있으면 같은 .tmp 를 두 프로세스가 rename 해 ENOENT 가 났다 → pid 로 구분.
      const tmp = `${this.opts.cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), "utf8");
      fs.renameSync(tmp, this.opts.cachePath);
    } catch (e) {
      console.warn("[usage] cache 저장 실패:", e);
    }
  }
}

function listFiles(root: string, ext: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith(ext)) out.push(full);
    }
  }
  return out;
}

/** 큰 파일(수십 MB)을 통째로 읽지 않고 줄 단위로 스트리밍한다. */
async function parseFile(file: string, parser: (lines: Iterable<string>) => ParseResult): Promise<ParseResult> {
  const lines: string[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  return parser(lines);
}
