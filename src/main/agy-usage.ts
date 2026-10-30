import { execFile } from "node:child_process";
import type { ProviderRateLimitDto, RateLimitWindowDto } from "@shared/ipc";
import type { AgyRuntime } from "./agy-adapter";
import { launchSpec } from "./cli-launch";

/** 자동 갱신은 분당 한 번으로 제한하고, 그 사이의 요청은 후속 조회 하나로 합친다. */
export class AgyQuotaRefresher {
  private inflight: Promise<void> | null = null;
  private lastStarted = -Infinity;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly refresh: () => Promise<void>, private readonly intervalMs = 60_000) {}

  request(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inflight) {
      if (!force) this.pending = true;
      return this.inflight;
    }
    if (!force && Date.now() - this.lastStarted < this.intervalMs) {
      this.schedule();
      return Promise.resolve();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    this.lastStarted = Date.now();
    this.inflight = Promise.resolve().then(() => this.refresh()).finally(() => {
      this.inflight = null;
      if (this.pending) this.schedule();
    });
    return this.inflight;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.timer || this.inflight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) void this.request().catch(() => {});
    }, Math.max(0, this.lastStarted + this.intervalMs - Date.now()));
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** /usage is a local CLI command, not a model prompt. Read command.data,
 * never infer quota from generated response text or cumulative token usage. */
export function parseAgyQuota(raw: unknown, observedAt = Date.now()): ProviderRateLimitDto | null {
  if (!raw || typeof raw !== "object") return null;
  const result = raw as { status?: unknown; command?: { name?: unknown; data?: { groups?: unknown } } };
  if (result.status !== "SUCCESS" || result.command?.name !== "usage" || !Array.isArray(result.command.data?.groups)) return null;
  const groups: NonNullable<ProviderRateLimitDto["groups"]> = [];
  for (const rawGroup of result.command.data.groups) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const group = rawGroup as { name?: unknown; buckets?: unknown };
    if (typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.buckets)) continue;
    const windows: RateLimitWindowDto[] = [];
    for (const rawBucket of group.buckets) {
      if (!rawBucket || typeof rawBucket !== "object") continue;
      const bucket = rawBucket as { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };
      const remaining = bucket.remaining_fraction;
      const minutes = bucket.window === "weekly" ? 7 * 24 * 60 : bucket.window === "5h" ? 5 * 60 : null;
      if (minutes === null || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      const reset = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      windows.push({ usedPercent: (1 - remaining) * 100, windowMinutes: minutes, resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : 0 });
    }
    if (windows.length) groups.push({ label: group.name.trim(), windows });
  }
  return groups.length ? { session: null, weekly: null, modelWeekly: null, groups, observedAt } : null;
}

export async function fetchAgyQuota(runtime: AgyRuntime, cwd: string): Promise<ProviderRateLimitDto> {
  const spec = launchSpec(runtime.agyPath, ["--print", "/usage", "--output-format", "json", "--print-timeout", "30s"]);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(spec.command, spec.args, { cwd, env: runtime.env, shell: spec.shell, windowsHide: true,
      timeout: 40_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(new Error("Antigravity quota command failed"));
      else resolve(stdout);
    });
  });
  const quota = parseAgyQuota(JSON.parse(stdout));
  if (!quota) throw new Error("Antigravity quota response is unavailable or unsupported");
  return quota;
}
