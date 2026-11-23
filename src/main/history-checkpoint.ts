import fs from "node:fs";
import { createHash } from "node:crypto";
import { compactHistoryCut, createHistoryReplay, slimHistoryBlock } from "@shared/session-history";
import type { SessionState } from "@shared/session-state";
import type { ChatEvent } from "@shared/chat-events";
import { readCodexAgentInput } from "@shared/codex-agents";
import { readJsonl } from "./jsonl-reader";

export interface HistoryCheckpoint { offset: number; state: SessionState; restore: ChatEvent[]; loadedStart: number }
interface Stamp { size: number; mtimeMs: number; ctimeMs: number; ino: number; birthtimeMs: number }
interface Entry { stamp: Stamp; digest: string; checkpoint: HistoryCheckpoint }
interface CheckpointJob { stamp: Stamp; generation: number; again: boolean; promise: Promise<HistoryCheckpoint | null> }
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const REFRESH_TAIL_BYTES = 128 * 1024;
const same = (a: Stamp, b: Stamp) => JSON.stringify(a) === JSON.stringify(b);
export function historyFileStamp(file: string): Stamp | undefined {
  try { const { size, mtimeMs, ctimeMs, ino, birthtimeMs } = fs.statSync(file); return { size, mtimeMs, ctimeMs, ino, birthtimeMs }; } catch { return undefined; }
}

/** An optional, checksummed projection. The append-only JSONL remains the source of truth. */
export class HistoryCheckpoints {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, CheckpointJob>();
  private scheduled = new Set<string>();
  private generations = new Map<string, number>();
  constructor(private fileFor: (id: string) => string) {}
  private paths(id: string) { const file = this.fileFor(id); return { data: file + ".compact-state.json", meta: file + ".compact-meta.json" }; }
  private remember(id: string, entry: Entry) {
    this.entries.delete(id); this.entries.set(id, entry);
    while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
  }
  private load(id: string, stamp = historyFileStamp(this.fileFor(id))): Entry | undefined {
    if (!stamp) return;
    const cached = this.entries.get(id);
    if (cached && same(cached.stamp, stamp)) return cached;
    const paths = this.paths(id);
    try {
      if (fs.statSync(paths.meta).size > 4096) return;
      const meta = JSON.parse(fs.readFileSync(paths.meta, "utf8"));
      if (meta.version !== 1 || !same(meta.stamp, stamp)) return;
      // Old versions wrote null for unindexed logs. That is a cache miss.
      if (typeof meta.digest !== "string" || fs.statSync(paths.data).size > MAX_CACHE_BYTES) return;
      const raw = fs.readFileSync(paths.data);
      if (createHash("sha256").update(raw).digest("hex") !== meta.digest) return;
      const value = JSON.parse(raw.toString("utf8"));
      if (value.version !== 1 || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > stamp.size ||
        !Array.isArray(value.state?.blocks) || !Array.isArray(value.restore) || !Number.isSafeInteger(value.state?.eventCount) || !value.state?.totals ||
        !Number.isSafeInteger(value.loadedStart) || value.loadedStart < 0 || value.loadedStart > value.state.blocks.length) return;
      const entry = { stamp, digest: meta.digest, checkpoint: value as HistoryCheckpoint };
      this.remember(id, entry); return entry;
    } catch { return; }
  }
  current(id: string) { return this.load(id)?.checkpoint ?? null; }
  private meta(id: string, entry: Entry) {
    const path = this.paths(id).meta;
    fs.writeFileSync(path + ".tmp", JSON.stringify({ version: 1, stamp: entry.stamp, digest: entry.digest }));
    fs.renameSync(path + ".tmp", path);
  }
  private scheduleRefresh(id: string) {
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    setImmediate(() => {
      this.scheduled.delete(id);
      void this.ensure(id, true);
    });
  }
  advance(id: string, before: Stamp | undefined, boundary?: "compacted" | "completed") {
    const stamp = historyFileStamp(this.fileFor(id));
    if (!stamp) return;
    const appended = before && before.ino === stamp.ino && before.birthtimeMs === stamp.birthtimeMs && stamp.size >= before.size;
    const entry = appended ? this.load(id, before) : undefined;
    if (entry) {
      const next = { ...entry, stamp };
      this.remember(id, next);
      try { this.meta(id, next); } catch { /* A lost cache is rebuilt from JSONL. */ }
    }
    const refresh = boundary === "compacted" || !!(entry?.checkpoint &&
      (boundary === "completed" || stamp.size - entry.checkpoint.offset >= REFRESH_TAIL_BYTES));
    const job = this.jobs.get(id);
    // Accept only appends observed by Store. A rewrite or unverified append
    // still fails the stamp check before the checkpoint can be published.
    if (job && appended && same(job.stamp, before)) {
      job.stamp = stamp;
      job.again ||= boundary !== undefined;
    } else if (refresh && !job) this.scheduleRefresh(id);
  }
  invalidate(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.entries.delete(id);
    this.jobs.delete(id);
    for (const file of Object.values(this.paths(id))) try { fs.rmSync(file, { force: true }); } catch { /* optional cache */ }
  }
  async ensure(id: string, refresh = false): Promise<HistoryCheckpoint | null> {
    const stamp = historyFileStamp(this.fileFor(id));
    if (!stamp) return null;
    const running = this.jobs.get(id);
    if (running) return running.promise;
    const cached = this.load(id, stamp);
    const seed = cached?.checkpoint ?? undefined;
    if (seed && (seed.offset === stamp.size ||
      (!refresh && !this.scheduled.has(id) && stamp.size - seed.offset < REFRESH_TAIL_BYTES)))
      return seed;
    const generation = this.generations.get(id) ?? 0;
    const job: CheckpointJob = {
      stamp,
      generation,
      again: false,
      promise: Promise.resolve().then(() => this.build(id, job, seed)).catch(() => null),
    };
    this.jobs.set(id, job);
    const result = await job.promise;
    if (this.jobs.get(id) !== job) return null;
    this.jobs.delete(id);
    // A snapshot can end with an incomplete record. Retry only if the
    // writer appended bytes while we were reading that snapshot.
    const remaining = result && job.stamp.size > stamp.size ? job.stamp.size - result.offset : 0;
    if (remaining > 0 && (job.again || remaining >= REFRESH_TAIL_BYTES)) this.scheduleRefresh(id);
    return result ?? this.current(id);
  }
  private async build(id: string, job: CheckpointJob, seed?: HistoryCheckpoint): Promise<HistoryCheckpoint | null> {
    const file = this.fileFor(id), stamp = historyFileStamp(file);
    if (!stamp || !same(stamp, job.stamp) || this.jobs.get(id) !== job) return null;
    let replay = createHistoryReplay(undefined, seed?.state, false, seed?.loadedStart);
    const tools = new Set<string>(), agents = new Set<string>();
    const pending = new Map<string, ChatEvent>();
    let hasUser = false, status: Extract<ChatEvent, { type: "status" }> | undefined;
    let count = 0, lastEnd = seed?.offset ?? 0;
    const trackRestore = (event: ChatEvent) => {
      if (event.type === "user_message") hasUser = true;
      if (event.type === "status") status = event;
      if (event.type === "tool_use") { tools.add(event.toolUseId); if (readCodexAgentInput(event.input)) agents.add(event.toolUseId); }
      if (event.type === "tool_result") tools.delete(event.toolUseId);
      if (event.type === "verify" && !event.partial) { if (event.status === "running") pending.set("v:" + event.runId, event); else pending.delete("v:" + event.runId); }
      if (event.type === "review") { if (event.status === "requested") pending.set("r:" + event.reviewTabId, event); else pending.delete("r:" + event.reviewTabId); }
      if (event.type === "fanout") { if (event.status === "running") pending.set("f:" + event.fanoutId, event); else pending.delete("f:" + event.fanoutId); }
    };
    for (const event of seed?.restore ?? []) trackRestore(event);
    const capture = (offset: number, slim: boolean): HistoryCheckpoint => {
      const page = replay.finish(), restore: ChatEvent[] = [];
      if (hasUser) restore.push({ type: "user_message", id: "checkpoint-user", text: "", ts: 0 });
      for (const toolUseId of new Set([...agents, ...tools])) {
        restore.push({ type: "tool_use", ts: 0, toolUseId, name: "Tool", input: agents.has(toolUseId) ? { codexAgent: true, agents: [] } : {} });
        if (!tools.has(toolUseId)) restore.push({ type: "tool_result", ts: 0, toolUseId, output: "", isError: false });
      }
      restore.push(...pending.values()); if (status) restore.push(status);
      const blocks = [...page.prefix, ...page.state.blocks, ...page.suffix];
      return { offset, state: { ...page.state, blocks: slim ? blocks.map(slimHistoryBlock) : blocks }, restore, loadedStart: slim ? compactHistoryCut(blocks)?.index ?? blocks.length : page.prefix.length };
    };
    try {
      for (const record of readJsonl(file, false, lastEnd, stamp.size)) {
        lastEnd = record.end;
        let event: ChatEvent; try { event = JSON.parse(record.line); } catch { continue; }
        if (!event || typeof event.type !== "string") continue;
        replay.push(event);
        trackRestore(event);
        if (event.type === "compacted") {
          const checkpoint = capture(record.end, true);
          replay = createHistoryReplay(undefined, checkpoint.state, false, checkpoint.loadedStart);
        }
        if (++count % 128 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (this.jobs.get(id) !== job) return null;
        }
      }
      const after = historyFileStamp(file);
      if (!after || !same(job.stamp, after) || job.generation !== (this.generations.get(id) ?? 0)) return null;
      // Keep the recent tail too, so a rebuilt cache resumes at EOF even when
      // thousands of events have arrived since the latest compaction.
      const checkpoint = capture(lastEnd, false);
      const raw = Buffer.from(JSON.stringify({ version: 1, ...checkpoint }));
      if (raw.length > MAX_CACHE_BYTES) return null;
      const digest = createHash("sha256").update(raw).digest("hex");
      const entry = { stamp: after, checkpoint, digest };
      const data = this.paths(id).data;
      fs.writeFileSync(data + ".tmp", raw); fs.renameSync(data + ".tmp", data);
      this.meta(id, entry); this.remember(id, entry);
      return checkpoint;
    } catch { return null; }
  }
}
