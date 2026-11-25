// 로컬 트랜스크립트 스캐너 — 터미널에서 쓴 사용량까지 합산한다.
//   Claude Code: ~/.claude/projects/<cwd-encoded>/*.jsonl  (assistant 항목의 message.usage, 메시지 id 중복 제거)
//   Codex:       ~/.codex/sessions/**/*.jsonl              (event_msg/token_count 의 누적값 차분)
// 파서는 한 줄씩 받아 집계 상태만 보관한다. Codex는 마지막 줄의 위치와 누적값도 보관한다.

import fs from "node:fs";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DEFAULT_PRICING, isPricingTable, matchingPrices, priceAt, usageLongContext, type PricingEntry, type UsageRecord } from "@shared/usage";
import type { ProviderRateLimitDto, RateLimitWindowDto, Provider } from "@shared/ipc";
import { JSONL_CHUNK_BYTES } from "./jsonl-reader";

const HOUR = 3_600_000;

export type CodexRateLimit = ProviderRateLimitDto;

export interface ParseResult {
  records: UsageRecord[];
  rateLimit?: CodexRateLimit;
}

interface LineParser {
  push(line: string): void;
  finish(pricing?: PricingEntry[]): ParseResult;
}

function parseLines(lines: Iterable<string>, parser: LineParser, pricing?: PricingEntry[]): ParseResult {
  for (const line of lines) parser.push(line);
  return parser.finish(pricing);
}

/** 가격 구간을 보존하며 세션·모델·경로·시간별로 합친다. */
export function compactRecords(records: UsageRecord[], pricing = DEFAULT_PRICING): UsageRecord[] {
  const map = new Map<string, UsageRecord>();
  const pricesByModel = new Map<string, PricingEntry[]>();
  for (const r of records) {
    let candidates = pricesByModel.get(r.model);
    if (!candidates) {
      candidates = matchingPrices(r.model, pricing);
      pricesByModel.set(r.model, candidates);
    }
    const price = priceAt(candidates, r.ts);
    const ts = Math.max(Math.floor(r.ts / HOUR) * HOUR, price?.effectiveFrom ?? -Infinity);
    const longContextLimit = price?.longContext?.inputThreshold;
    const longContext = longContextLimit === undefined ? undefined : usageLongContext(r, longContextLimit);
    const key = JSON.stringify([r.sessionId, r.model, r.cwd, ts, longContextLimit, longContext]);
    const cur = map.get(key);
    if (!cur) map.set(key, { ...r, ts, ...(longContext !== undefined ? { longContext, longContextLimit } : {}) });
    else {
      cur.input += r.input;
      cur.output += r.output;
      cur.cacheRead += r.cacheRead;
      cur.cacheWrite += r.cacheWrite;
      if (r.cacheWrite1h) cur.cacheWrite1h = (cur.cacheWrite1h ?? 0) + r.cacheWrite1h;
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
export function parseClaudeLines(lines: Iterable<string>, pricing?: PricingEntry[]): ParseResult {
  return parseLines(lines, createClaudeParser(), pricing);
}

function createClaudeParser(): LineParser {
  const byId = new Map<string, UsageRecord>();
  let seq = 0;
  const push = (line: string) => {
    if (!line.includes('"assistant"')) return;
    const e = safeJson(line);
    if (!e || e.type !== "assistant") return;
    const msg = e.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const usage = msg.usage as Record<string, unknown> | undefined;
    const model = typeof msg.model === "string" ? msg.model : "";
    if (!usage || !model || model === "<synthetic>") return;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts)) return;
    const id = typeof msg.id === "string" ? msg.id : `noid-${seq++}`;
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheWrite1h = Math.max(0, num(cacheCreation?.ephemeral_1h_input_tokens));
    const cacheWrite = Math.max(num(usage.cache_creation_input_tokens), num(cacheCreation?.ephemeral_5m_input_tokens) + cacheWrite1h);
    const rec: UsageRecord = {
      ts,
      provider: "claude",
      model,
      cwd: typeof e.cwd === "string" ? e.cwd : "",
      sessionId: typeof e.sessionId === "string" ? e.sessionId : "",
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite,
      ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
      requests: 1,
    };
    const prev = byId.get(id);
    // 같은 id 면 토큰이 더 큰 쪽(최종본)을 남긴다.
    if (!prev || rec.output + rec.input >= prev.output + prev.input) byId.set(id, rec);
  };
  return { push, finish: pricing => ({ records: compactRecords([...byId.values()], pricing) }) };
}

/**
 * Codex 세션 롤아웃. token_count 의 total_token_usage 는 누적값이라 직전 값과의 차분이 그 호출의 사용량.
 * 같은 누적값이 반복되면(rate limit 갱신만) 건너뛴다. 모델은 직전 turn_context 의 model.
 */
export function parseCodexLines(lines: Iterable<string>): ParseResult {
  return parseLines(lines, createCodexParser());
}

interface CodexParserState {
  cwd: string;
  sessionId: string;
  model: string;
  prev: { input: number; cached: number; written: number; output: number };
  rateLimit?: CodexRateLimit;
}

function createCodexParser(initial?: CodexParserState) {
  const records: UsageRecord[] = [];
  let {
    cwd = "", sessionId = "", model = "",
    prev = { input: 0, cached: 0, written: 0, output: 0 }, rateLimit,
  } = initial ?? {};

  const push = (line: string) => {
    if (!line.includes("session_meta") && !line.includes("turn_context") && !line.includes("token_count")) return;
    const e = safeJson(line);
    if (!e) return;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "session_meta") {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      const id = payload.id ?? payload.session_id;
      if (typeof id === "string") sessionId = id;
      return;
    }
    if (e.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      return;
    }
    if (e.type !== "event_msg" || payload.type !== "token_count") return;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts)) return;

    const limits = payload.rate_limits as Record<string, unknown> | null | undefined;
    if (limits) rateLimit = splitCodexWindows([codexWindow(limits.primary), codexWindow(limits.secondary)], ts) ?? rateLimit;

    const info = payload.info as Record<string, unknown> | null | undefined;
    const total = info?.total_token_usage as Record<string, unknown> | undefined;
    if (!total) return;
    const cur = {
      input: num(total.input_tokens),
      cached: num(total.cached_input_tokens),
      written: num(total.cache_write_input_tokens),
      output: num(total.output_tokens),
    };
    const dIn = cur.input - prev.input;
    const cacheRead = Math.max(0, Math.min(dIn, cur.cached - prev.cached));
    const cacheWrite = Math.max(0, Math.min(dIn - cacheRead, cur.written - prev.written));
    const dOut = cur.output - prev.output;
    prev = cur;
    if (dIn <= 0 && dOut <= 0) return; // 반복 이벤트 또는 리셋
    records.push({
      ts,
      provider: "codex",
      model: model || "codex-unknown",
      cwd,
      sessionId,
      // OpenAI input totals include both cache reads and writes.
      input: Math.max(0, dIn - cacheRead - cacheWrite),
      output: Math.max(0, dOut),
      cacheRead,
      cacheWrite,
      requests: 1,
    });
  };
  return {
    push,
    finish: (pricing?: PricingEntry[]): ParseResult => ({ records: compactRecords(records, pricing), rateLimit }),
    state: (): CodexParserState => ({ cwd, sessionId, model, prev, rateLimit }),
  };
}

function codexWindow(raw: unknown): RateLimitWindowDto | null {
  const w = raw as Record<string, unknown> | null | undefined;
  if (!w || typeof w.used_percent !== "number") return null;
  return { usedPercent: w.used_percent, windowMinutes: num(w.window_minutes), resetsAt: num(w.resets_at) };
}

/**
 * primary/secondary 는 플랜마다 다르다 (primary 가 7일 창이고 secondary 가 null 인 계정도 있다).
 * 위치가 아니라 창 길이로 세션(≤6시간)/주간을 나눈다.
 */
function splitCodexWindows(windows: (RateLimitWindowDto | null)[], observedAt: number): CodexRateLimit | null {
  let session: RateLimitWindowDto | null = null;
  let weekly: RateLimitWindowDto | null = null;
  for (const w of windows) {
    if (!w) continue;
    if (w.windowMinutes <= 360) session ??= w;
    else weekly ??= w;
  }
  return session || weekly ? { session, weekly, modelWeekly: null, observedAt } : null;
}

/**
 * app-server account/rateLimits/read 응답 → 한도. 기록 파일의 token_count 와 같은 창이 camelCase 로 온다.
 * 여러 한도 중 Codex 것(limitId "codex")을 쓰고, 없으면 예전 단일 값(rateLimits)을 쓴다.
 */
export function codexRateLimitFromAppServer(resp: unknown, observedAt: number): CodexRateLimit | null {
  const r = resp as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> | null } | null | undefined;
  const snap = (r?.rateLimitsByLimitId?.codex ?? r?.rateLimits) as Record<string, unknown> | null | undefined;
  if (!snap) return null;
  const win = (raw: unknown): RateLimitWindowDto | null => {
    const w = raw as Record<string, unknown> | null | undefined;
    if (!w || typeof w.usedPercent !== "number") return null;
    return { usedPercent: w.usedPercent, windowMinutes: num(w.windowDurationMins), resetsAt: num(w.resetsAt) };
  };
  return splitCodexWindows([win(snap.primary), win(snap.secondary)], observedAt);
}

/** Sudal already stores normalized per-turn usage for Antigravity. Other providers
 * use their native transcripts, so ignore them here to avoid double counting. */
export function parseSudalAgyLines(lines: Iterable<string>): ParseResult {
  return parseLines(lines, createSudalAgyParser());
}

function createSudalAgyParser(): LineParser {
  let provider: unknown = null;
  let sessionId = "";
  let cwd = "";
  let model = "";
  const records: UsageRecord[] = [];
  const push = (line: string) => {
    const event = safeJson(line);
    if (!event) return;
    if (event.type === "session") {
      provider = event.provider;
      sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
      cwd = typeof event.cwd === "string" ? event.cwd : "";
      model = typeof event.model === "string" ? event.model : "";
    }
    if (event.type !== "turn_result" || provider !== "agy" || !sessionId || !num(event.ts)) return;
    const entries = event.modelUsage && typeof event.modelUsage === "object" ? Object.entries(event.modelUsage) : [];
    const usages = entries.length ? entries : [[model || "unknown", event.usage]];
    for (const [modelId, raw] of usages) {
      if (!raw || typeof raw !== "object") continue;
      const usage = raw as Record<string, unknown>;
      const input = num(usage.input), output = num(usage.output), cacheRead = num(usage.cacheRead), cacheWrite = num(usage.cacheWrite);
      if (input + output + cacheRead + cacheWrite === 0) continue;
      // Antigravity input includes cache hits; UsageRecord.input excludes them.
      records.push({ ts: num(event.ts), provider: "agy", sessionId, cwd, model: String(modelId),
        input: Math.max(0, input - cacheRead), output, cacheRead, cacheWrite, requests: Math.max(1, num(event.numTurns)) });
    }
  };
  return { push, finish: pricing => ({ records: compactRecords(records, pricing) }) };
}

// ===== 스캐너 =====

interface FileCache {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
  rateLimit?: CodexRateLimit;
  pricingRules?: string;
  writeTokensParsed?: true;
  codex?: CodexCheckpoint;
}

interface CodexCheckpoint {
  identity: string;
  ctimeNs: string;
  offset: number;
  signature: string;
  state: CodexParserState;
  /** Usage before the last newline if an unterminated record also contributed to the view. */
  completeRecords?: UsageRecord[];
}

interface CacheFile {
  version: 5;
  files: Record<string, FileCache>;
  pricing?: UsagePricing;
}

interface UsagePricing {
  entries: PricingEntry[];
  custom: boolean;
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
  sudalThreadsDir?: string;
  pollIntervalMs?: number;
  cachePath: string;
  pricing?: () => unknown;
  onChange?: () => void;
}

function pricingRulesForRecords(records: UsageRecord[], pricing: PricingEntry[], keysByModel: Map<string, string>): string {
  const keys = new Set<string>();
  for (const { model } of records) {
    let key = keysByModel.get(model);
    if (key === undefined) {
      const matches = matchingPrices(model, pricing);
      key = matches.some(price => price.effectiveFrom !== undefined || price.longContext)
        ? JSON.stringify(matches.map(price => [price.effectiveFrom, price.longContext?.inputThreshold]))
        : "";
      keysByModel.set(model, key);
    }
    if (key) keys.add(JSON.stringify([model, key]));
  }
  return [...keys].sort().join("\n");
}

function needsCacheWriteRefresh(cached: FileCache, provider: Provider): boolean {
  if (cached.writeTokensParsed) return false;
  if (provider === "codex") return cached.records.some(r => r.input > 0);
  return provider === "claude" && cached.records.some(r => r.cacheWrite > 0);
}

export class UsageScanner {
  private cache: CacheFile = { version: 5, files: {} };
  private appliedPricing: UsagePricing;
  private status: ScanStatus;
  private watchers: fs.FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
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
    // Legacy caches did not record which rules produced their totals.
    this.appliedPricing = this.cache.pricing ?? { entries: DEFAULT_PRICING, custom: false };
  }

  private readPricing(): UsagePricing {
    const custom = this.opts.pricing?.();
    return isPricingTable(custom)
      ? { entries: structuredClone(custom), custom: true }
      : { entries: DEFAULT_PRICING, custom: false };
  }

  getPricing(): UsagePricing {
    return this.appliedPricing;
  }

  getStatus(): ScanStatus {
    return { ...this.status };
  }

  records(): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const f of Object.values(this.cache.files)) out.push(...f.records);
    return out;
  }

  /** 캐시가 유효하면 파일을 건너뛰고, 이어서 쓴 Codex 파일은 추가된 줄만 읽는다. */
  scan(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doScan().finally(() => {
      this.status.scanning = false;
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doScan(): Promise<void> {
    const started = Date.now();
    this.status.scanning = true;
    const seen = new Set<string>();
    const files = { ...this.cache.files };
    const nextPricing = this.readPricing();
    const pricing = nextPricing.entries;
    const keysByModel = new Map<string, string>();
    let changed = JSON.stringify(this.cache.pricing) !== JSON.stringify(nextPricing);

    const targets: { file: string; kind: Provider }[] = [];
    for (const f of listFiles(this.opts.claudeDir, ".jsonl")) targets.push({ file: f, kind: "claude" });
    for (const f of listFiles(this.opts.codexDir, ".jsonl")) targets.push({ file: f, kind: "codex" });
    if (this.opts.sudalThreadsDir) for (const f of listFiles(this.opts.sudalThreadsDir, ".jsonl")) targets.push({ file: f, kind: "agy" });

    for (const { file, kind } of targets) {
      seen.add(file);
      let st: Pick<fs.Stats, "size" | "mtimeMs"> | CodexFileStamp;
      try {
        st = kind === "codex" ? await statCodexFile(file) : await fs.promises.stat(file);
      } catch {
        continue;
      }
      try {
        const cached = files[file];
        const reusable = cached && !needsCacheWriteRefresh(cached, kind) &&
          (cached.pricingRules ?? "") === pricingRulesForRecords(cached.records, pricing, keysByModel) ? cached : undefined;
        if (reusable && reusable.mtimeMs === st.mtimeMs && reusable.size === st.size &&
            (!reusable.codex || ("identity" in st && reusable.codex.identity === st.identity && reusable.codex.ctimeNs === st.ctimeNs.toString()))) continue;
        const result = kind === "codex"
          ? await parseCodexFile(file, pricing, reusable)
          : { ...await parseFile(file, kind === "claude" ? createClaudeParser() : createSudalAgyParser(), pricing), mtimeMs: st.mtimeMs, size: st.size };
        files[file] = { ...result, pricingRules: pricingRulesForRecords(result.records, pricing, keysByModel), writeTokensParsed: true };
        changed = true;
      } catch (e) {
        console.warn(`[usage] parse 실패 ${file}:`, e instanceof Error ? e.message : e);
      }
    }
    for (const file of Object.keys(files)) {
      if (!seen.has(file) && transcriptMissing(file)) {
        delete files[file];
        changed = true;
      }
    }

    if ((!this.cache.pricing || JSON.stringify(this.appliedPricing) !== JSON.stringify(nextPricing)) &&
        Object.values(files).some(file => (file.pricingRules ?? "") !== pricingRulesForRecords(file.records, pricing, keysByModel))) {
      // Retry the price change once the remaining old partitions can be read.
      return;
    }

    let latestRl: CodexRateLimit | null = null;
    let records = 0;
    for (const f of Object.values(files)) {
      records += f.records.length;
      if (f.rateLimit && (!latestRl || f.rateLimit.observedAt > latestRl.observedAt)) latestRl = f.rateLimit;
    }
    // Queries and exports see the records and price table from one scan.
    this.cache = { version: 5, files, pricing: nextPricing };
    this.appliedPricing = nextPricing;
    this.status = {
      ...this.status,
      scanning: false,
      files: Object.keys(files).length,
      records,
      lastScanAt: Date.now(),
      lastScanMs: Date.now() - started,
      codexRateLimit: latestRl,
    };
    if (changed) this.saveCache();
    this.opts.onChange?.();
  }

  /** 기록 루트를 재귀 감시. 변경 후 2초 정지하면 재스캔. */
  watch(): void {
    this.unwatch();
    // fs.watch 이벤트는 플랫폼·파일 생성 시점에 따라 누락될 수 있다.
    this.poll = setInterval(() => { void this.scan(); }, this.opts.pollIntervalMs ?? 30_000);
    this.poll.unref();
    for (const dir of [this.opts.claudeDir, this.opts.codexDir, this.opts.sudalThreadsDir]) {
      if (!dir) continue;
      try {
        // 첫 대화 전에도 앱 소유 기록 폴더를 감시해야 첫 사용량부터 반영된다.
        if (dir === this.opts.sudalThreadsDir) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(dir)) continue;
        const w = fs.watch(dir, { recursive: true }, () => this.schedule());
        w.on("error", (e) => console.warn("[usage] watch error:", e));
        this.watchers.push(w);
      } catch (e) {
        console.warn(`[usage] watch 실패 ${dir}:`, e);
      }
    }
  }

  unwatch(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
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
      if (parsed?.version === 5 && parsed.files) {
        const files = Object.fromEntries(Object.entries(parsed.files).filter(([, entry]) =>
          Array.isArray(entry?.records) && entry.records.every(record => typeof record?.model === "string")));
        const pricing = isPricingTable(parsed.pricing?.entries) && typeof parsed.pricing?.custom === "boolean" ? parsed.pricing : undefined;
        this.cache = { version: 5, files, pricing };
      }
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

/** A failed directory read must not be mistaken for a deleted transcript. */
function transcriptMissing(file: string): boolean {
  try {
    fs.statSync(file);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
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

interface CodexFileStamp {
  identity: string;
  inode: bigint;
  size: number;
  mtimeMs: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function codexFileStamp(stat: fs.BigIntStats): CodexFileStamp {
  const size = Number(stat.size);
  if (!stat.isFile() || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Codex transcript file or size");
  const { mtimeNs, ctimeNs } = stat;
  // Match the legacy numeric mtime so unchanged v5 entries can still be reused.
  const mtimeMs = Number(mtimeNs / 1_000_000_000n) * 1000 + Number(mtimeNs % 1_000_000_000n) / 1_000_000;
  return { identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, inode: stat.ino, size, mtimeMs, mtimeNs, ctimeNs };
}

async function statCodexFile(file: string): Promise<CodexFileStamp> {
  return codexFileStamp(await fs.promises.stat(file, { bigint: true }));
}

async function readExactly(handle: FileHandle, buffer: Buffer, length: number, position: number): Promise<void> {
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Codex transcript was truncated while reading");
    offset += bytesRead;
  }
}

const CODEX_SAMPLE_BYTES = 4096;

interface CodexSamples { head: Buffer; tail: Buffer }

// Check bounded samples at both ends of a prefix so common truncate/regrow
// events are detectable even when the file identity has not changed.
async function readCodexSamples(handle: FileHandle, offset: number): Promise<CodexSamples> {
  const length = Math.min(offset, CODEX_SAMPLE_BYTES);
  const head = Buffer.allocUnsafe(length);
  await readExactly(handle, head, head.length, 0);
  if (offset === length) return { head, tail: head };
  const tail = Buffer.allocUnsafe(length);
  await readExactly(handle, tail, tail.length, offset - length);
  return { head, tail };
}

function codexSignature({ head, tail }: CodexSamples): string {
  return createHash("sha256").update(head).update(tail).digest("hex");
}

function codexResumePoint(cached: FileCache | undefined, stat: CodexFileStamp): CodexCheckpoint | undefined {
  const checkpoint = cached?.codex;
  if (!checkpoint || !cached || stat.size <= cached.size || stat.inode === 0n || checkpoint.identity !== stat.identity ||
      !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset <= 0 || checkpoint.offset > cached.size) return;
  const { state, completeRecords } = checkpoint;
  if (!state || typeof state.cwd !== "string" || typeof state.sessionId !== "string" || typeof state.model !== "string" ||
      !state.prev || ![state.prev.input, state.prev.cached, state.prev.written, state.prev.output].every(Number.isFinite) ||
      (completeRecords !== undefined && (!Array.isArray(completeRecords) || !completeRecords.every(record => typeof record?.model === "string")))) return;
  return checkpoint;
}

function appendCodexTail(tail: Buffer, bytes: Buffer): Buffer {
  const take = CODEX_SAMPLE_BYTES - bytes.length;
  if (take <= 0) return Buffer.from(bytes.subarray(-CODEX_SAMPLE_BYTES));
  return Buffer.concat([tail.subarray(-take), bytes]);
}

/** Read a fixed byte range asynchronously. Return the last incomplete line separately. */
async function readCodexLines(handle: FileHandle, start: number, size: number, push: (line: string) => void, prefix?: CodexSamples) {
  const buffer = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
  let offset = start;
  let completeEnd = start;
  let head = prefix?.head ?? Buffer.alloc(0);
  let tail = prefix?.tail ?? Buffer.alloc(0);
  let completeTail = tail;
  let parts: Buffer[] = [];
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    await readExactly(handle, buffer, length, offset);
    const chunk = buffer.subarray(0, length);
    let lineStart = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
      const end = chunk.subarray(lineStart, newline);
      const line = parts.length === 0 ? end : Buffer.concat([...parts, end]);
      push(line.toString("utf8"));
      parts = [];
      lineStart = newline + 1;
    }
    if (head.length < CODEX_SAMPLE_BYTES) head = Buffer.concat([head, chunk.subarray(0, CODEX_SAMPLE_BYTES - head.length)]);
    if (lineStart > 0) {
      completeEnd = offset + lineStart;
      completeTail = appendCodexTail(tail, chunk.subarray(0, lineStart));
    }
    tail = lineStart === length ? completeTail : appendCodexTail(tail, chunk);
    if (lineStart < length) parts.push(Buffer.from(chunk.subarray(lineStart)));
    offset += length;
  }
  return {
    completeEnd,
    trailing: parts.length ? Buffer.concat(parts).toString("utf8") : "",
    signature: codexSignature({ head: head.subarray(0, completeEnd), tail: completeTail }),
    snapshotSignature: codexSignature({ head, tail }),
  };
}

async function parseCodexFile(file: string, pricing: PricingEntry[], cached?: FileCache): Promise<FileCache> {
  const handle = await fs.promises.open(file, "r");
  try {
    const stat = codexFileStamp(await handle.stat({ bigint: true }));
    let resume = codexResumePoint(cached, stat);
    const prefix = resume ? await readCodexSamples(handle, resume.offset) : undefined;
    if (resume && prefix && codexSignature(prefix) !== resume.signature) resume = undefined;
    const parser = createCodexParser(resume?.state);
    const { completeEnd, trailing, signature, snapshotSignature } =
      await readCodexLines(handle, resume?.offset ?? 0, stat.size, parser.push, resume ? prefix : undefined);
    const complete = parser.finish(pricing);
    const priorRows = resume?.completeRecords ?? (resume ? cached?.records : undefined);
    const completeRecords = priorRows ? compactRecords([...priorRows, ...complete.records], pricing) : complete.records;
    const state = parser.state();

    // A valid EOF line is visible as before. Its contribution is provisional
    // until a newline arrives, so the next append can replace it without duplication.
    const eofParser = createCodexParser(state);
    if (trailing) eofParser.push(trailing);
    const eof = eofParser.finish(pricing);
    const records = eof.records.length ? compactRecords([...completeRecords, ...eof.records], pricing) : completeRecords;
    const matchesSnapshot = codexSignature(await readCodexSamples(handle, stat.size)) === snapshotSignature;
    const after = await statCodexFile(file);
    const grew = after.size > stat.size;
    // On growth, also check the old resume boundary, which can now be in the middle.
    const matchesResume = !grew || !resume || codexSignature(await readCodexSamples(handle, resume.offset)) === resume.signature;
    if (!matchesSnapshot || !matchesResume || after.identity !== stat.identity || after.size < stat.size ||
        (!grew && (after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs))) {
      throw new Error("Codex transcript changed while reading");
    }
    return {
      mtimeMs: stat.mtimeMs, size: stat.size, records, rateLimit: eof.rateLimit,
      codex: { identity: stat.identity, ctimeNs: stat.ctimeNs.toString(), offset: completeEnd, signature, state,
        ...(eof.records.length ? { completeRecords } : {}) },
    };
  } finally {
    await handle.close();
  }
}

/** 원문은 쌓지 않고 한 줄을 읽을 때마다 처리한다. 오류 시에도 파일 스트림을 닫는다. */
async function parseFile(file: string, parser: LineParser, pricing: PricingEntry[]): Promise<ParseResult> {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) parser.push(line);
    return parser.finish(pricing);
  } finally {
    rl.close();
    input.destroy();
  }
}
