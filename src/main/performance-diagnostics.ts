// Local numeric-only observations. Heavy samples are rare and writes never block Electron's main loop.
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";

export const PERF_LOG_FILE = "performance.jsonl";
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PENDING = 32;
const HEARTBEAT_MS = 1_000;
const STALL_MS = 250;
const LARGE_BYTES = 1024 * 1024;
const SLOW_MS = 100;
const MIB = 1024 * 1024;

const phases = [
  "codex-frame", "history-read", "history-preview", "history-flush", "usage-scan", "usage-cache",
  "chat-dispatch", "history-search", "history-export", "usage-cache-load", "usage-cache-save",
] as const;
const notices = [
  "codex-process-open", "codex-process-exit", "turn-result", "main-stall", "renderer-unresponsive",
  "renderer-responsive", "renderer-gone", "child-gone", "memory-pressure", "app-start",
] as const;
type PerfPhase = typeof phases[number];
type PerfNotice = typeof notices[number];
type PerfName = PerfPhase | PerfNotice;
const perfNames = new Set<string>([...phases, ...notices]);
const reasons = new Set<string>(["oom", "crashed", "abnormal-exit", "launch-failed", "integrity-failure", "memory-eviction", "clean-exit", "killed"]);
interface Fields { bytes?: number; count?: number; pid?: number; exitCode?: number; reason?: string; tabId?: string }
interface ProcessMetric { pid: number; type: string; memory: { workingSetSize: number; peakWorkingSetSize?: number; privateBytes?: number } }
const metricTypes = new Set(["Browser", "Tab", "GPU", "Utility", "Zygote", "Sandbox helper", "Plugin", "Pepper Plugin Broker", "Unknown"]);
const withoutSnapshot = new Set<PerfName>(["turn-result", "codex-process-open", "codex-process-exit"]);
const lifecycle = new Set<PerfName>([...withoutSnapshot, "renderer-unresponsive", "renderer-responsive", "renderer-gone", "child-gone"]);

function safeNumber(value: unknown, negative = false): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
    (negative || value >= 0) ? Math.round(value) : undefined;
}

class BoundedPerformanceLog {
  private readonly pending: string[] = [];
  private bytes: number | undefined;
  private writing: Promise<void> | null = null;

  constructor(private readonly dir: string, private readonly maxBytes = MAX_LOG_BYTES) {}

  push(row: object): void {
    // Bound the backlog even if the disk is hanging or the process is under pressure.
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push(JSON.stringify(row) + "\n");
    this.restart();
  }

  private restart(): void {
    if (!this.writing) this.writing = this.drain().finally(() => { this.writing = null; if (this.pending.length) this.restart(); });
  }

  async settle(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private async drain(): Promise<void> {
    const path = join(this.dir, PERF_LOG_FILE);
    try {
      if (this.bytes === undefined) {
        await mkdir(this.dir, { recursive: true });
        this.bytes = (await stat(path).catch(() => null))?.size ?? 0;
      }
      while (this.pending.length) {
        const line = this.pending.shift()!;
        const size = Buffer.byteLength(line);
        if (size > this.maxBytes) continue;
        if (this.bytes + size > this.maxBytes) {
          const previous = join(this.dir, "performance.1.jsonl");
          // Windows cannot rename over an existing file. Never keep stacking log generations.
          await rm(previous, { force: true });
          await rename(path, previous);
          this.bytes = 0;
        }
        await appendFile(path, line, { mode: 0o600 });
        this.bytes += size;
      }
    } catch {
      // A locked file/full disk must not delay the app or cause a retry loop.
      this.pending.length = 0;
      this.bytes = undefined;
    }
  }
}

export class PerformanceDiagnostics {
  private readonly log: BoundedPerformanceLog;
  private readonly last = new Map<PerfName, number>();
  private readonly tabs = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastBeat = 0;
  private suspended = false;
  private memoryCheckAt = 0;
  private stopped = false;

  constructor(dir: string, private readonly options: {
    processMetrics?: () => ProcessMetric[];
    now?: () => number;
    maxLogBytes?: number;
  } = {}) {
    this.log = new BoundedPerformanceLog(dir, options.maxLogBytes);
  }

  private now(): number { return this.options.now?.() ?? performance.now(); }

  start(): void {
    if (this.timer || this.stopped) return;
    this.lastBeat = this.now();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.timer.unref();
    this.record("app-start");
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    this.lastBeat = this.now();
  }

  private beat(): void {
    if (this.suspended) return;
    const now = this.now();
    const delay = now - this.lastBeat - HEARTBEAT_MS;
    this.lastBeat = now;
    if (delay >= STALL_MS) this.record("main-stall", delay);
    if (now < this.memoryCheckAt) return;
    this.memoryCheckAt = now + 5_000;
    const totalBytes = totalmem();
    const availableBytes = freemem();
    if (totalBytes > 0 && availableBytes <= totalBytes * 0.1) this.record("memory-pressure");
  }

  observe(phase: PerfPhase, elapsedMs: number, fields: Fields = {}): void {
    if (elapsedMs >= SLOW_MS || (fields.bytes ?? 0) >= LARGE_BYTES) this.record(phase, elapsedMs, fields);
  }

  record(name: PerfName, elapsedMs?: number, fields: Fields = {}): void {
    if (this.stopped || !perfNames.has(name)) return;
    if (!lifecycle.has(name)) {
      const now = this.now();
      const previous = this.last.get(name);
      const gap = name === "memory-pressure" ? 15_000 : 1_000;
      if (previous !== undefined && now - previous < gap) return;
      this.last.set(name, now);
    }
    this.log.push({
      ts: new Date().toISOString(),
      phase: name,
      mainPid: process.pid,
      tab: this.tabNumber(fields.tabId),
      durationMs: safeNumber(elapsedMs),
      bytes: safeNumber(fields.bytes),
      count: safeNumber(fields.count),
      pid: safeNumber(fields.pid),
      exitCode: safeNumber(fields.exitCode, true),
      reason: typeof fields.reason === "string" ? (reasons.has(fields.reason) ? fields.reason : "other") : undefined,
      ...(!withoutSnapshot.has(name) ? this.memory() : {}),
    });
  }

  private tabNumber(tabId?: string): number | undefined {
    if (!tabId) return;
    const existing = this.tabs.get(tabId);
    if (existing !== undefined) return existing;
    const tab = this.tabs.size + 1;
    this.tabs.set(tabId, tab);
    return tab;
  }

  private memory() {
    const main = process.memoryUsage();
    let processes: { pid?: number; type: string; workingSetKiB?: number; peakWorkingSetKiB?: number; privateKiB?: number }[] = [];
    try {
      processes = (this.options.processMetrics?.() ?? [])
        .sort((a, b) => b.memory.workingSetSize - a.memory.workingSetSize)
        .slice(0, 12)
        .map(({ pid, type, memory }) => ({
          pid: safeNumber(pid),
          type: metricTypes.has(type) ? type : "Unknown",
          workingSetKiB: safeNumber(memory.workingSetSize),
          peakWorkingSetKiB: safeNumber(memory.peakWorkingSetSize),
          privateKiB: safeNumber(memory.privateBytes),
        }));
    } catch { /* Metrics may be unavailable after a renderer exits. */ }
    return {
      osAvailableMiB: Math.round(freemem() / MIB),
      osTotalMiB: Math.round(totalmem() / MIB),
      mainRssMiB: Math.round(main.rss / MIB),
      mainHeapUsedMiB: Math.round(main.heapUsed / MIB),
      mainExternalMiB: Math.round(main.external / MIB),
      processes,
    };
  }

  /** For tests; app shutdown does not wait for diagnostics I/O. */
  settle(): Promise<void> { return this.log.settle(); }
}

let live: PerformanceDiagnostics | undefined;

export function startPerformanceDiagnostics(dir: string, processMetrics: () => ProcessMetric[]): PerformanceDiagnostics {
  live?.stop();
  live = new PerformanceDiagnostics(dir, { processMetrics });
  live.start();
  return live;
}

export function observePerf(phase: PerfPhase, elapsedMs: number, fields?: Fields): void {
  live?.observe(phase, elapsedMs, fields);
}

export function performanceNotice(name: PerfNotice, fields?: Fields, elapsedMs?: number): void {
  live?.record(name, elapsedMs, fields);
}
