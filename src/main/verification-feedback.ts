import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatEvent, VerifyEvent } from "@shared/chat-events";
import { feedbackActive, feedbackPrompt, type FeedbackStartOptions, type FeedbackStartResult, type VerificationFeedback } from "@shared/verification-feedback";
import { parseVerifyCommands, VERIFY_MAX_COMMANDS, VERIFY_MAX_COMMAND_LENGTH } from "@shared/verify";

export interface FeedbackContext { cwd: string; provider: string; busy: boolean; ownBusy?: boolean; available: boolean }
export interface FeedbackDeps {
  context(tabId: string): FeedbackContext;
  revision(cwd: string, signal?: AbortSignal): Promise<string>;
  verify(tabId: string, cwd: string, commands: string[], signal: AbortSignal): Promise<VerifyEvent>;
  send(tabId: string, prompt: string, signal: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  abortFix(tabId: string): boolean;
  emit(state: VerificationFeedback): void;
  error(key: "busy" | "options" | "context"): string;
  save?(state: VerificationFeedback): void;
  load?(tabId: string): VerificationFeedback | null;
  timeoutMs?: number;
}
interface Job {
  state: VerificationFeedback;
  provider: string;
  controller: AbortController;
  done: Promise<void>;
  fixing: boolean;
  ownsFix: boolean;
  fixError: boolean;
}

/** 명령은 실행 중 바뀌지 않는다. 에이전트가 끝났다는 말 대신 실제 유휴 상태와 재검증 결과를 사용한다. */
export class VerificationFeedbackRunner {
  private jobs = new Map<string, Job>();
  private restored = new Map<string, VerificationFeedback | null>();
  constructor(private readonly deps: FeedbackDeps) {}

  snapshot(tabId: string): VerificationFeedback | null {
    if (this.jobs.has(tabId)) return this.jobs.get(tabId)!.state;
    if (!this.restored.has(tabId)) {
      const saved = this.deps.load?.(tabId) ?? null;
      this.restored.set(tabId, saved ? { ...saved, phase: feedbackActive(saved) ? "stopped" : saved.phase === "passed" ? "stale" : saved.phase, reason: feedbackActive(saved) ? "interrupted" : saved.phase === "passed" ? "unverified" : saved.reason } : null);
    }
    return this.restored.get(tabId) ?? null;
  }
  async refresh(tabId: string): Promise<VerificationFeedback | null> {
    const job = this.jobs.get(tabId);
    if (job?.state.phase === "passed") {
      const revision = job.state.revision;
      try {
        this.context(job);
        const now = await this.deps.revision(job.state.cwd);
        if (this.jobs.get(tabId) === job && job.state.phase === "passed" && job.state.revision === revision && now !== revision) this.update(job, { phase: "stale", reason: "changed" });
      } catch { if (this.jobs.get(tabId) === job && job.state.phase === "passed") this.update(job, { phase: "stale", reason: "unverified" }); }
    }
    return this.snapshot(tabId);
  }
  active(tabId: string): boolean { return feedbackActive(this.snapshot(tabId)); }
  activeCwd(cwd: string): boolean {
    return [...this.jobs.values()].some(job => feedbackActive(job.state) && this.pathKey(job.state.cwd) === this.pathKey(cwd));
  }
  reconcile() {
    for (const [tabId, job] of this.jobs) {
      if (!feedbackActive(job.state)) continue;
      try { this.context(job); } catch { void this.stop(tabId); }
    }
  }
  private pathKey(cwd: string) {
    let path = resolve(cwd);
    try { path = realpathSync(path); } catch { /* context 검사에서 경로 오류를 처리한다. */ }
    return process.platform === "win32" ? path.replace(/\\/g, "/").toLowerCase() : path;
  }
  private update(job: Job, patch: Partial<VerificationFeedback>) {
    job.state = { ...job.state, ...patch, updatedAt: Math.max(Date.now(), job.state.updatedAt + 1) };
    this.deps.save?.(job.state);
    this.deps.emit(job.state);
  }

  start(tabId: string, options: FeedbackStartOptions): FeedbackStartResult {
    if (!options || !Array.isArray(options.commands) || !options.commands.length || options.commands.length > VERIFY_MAX_COMMANDS || !options.commands.every(command => typeof command === "string" && command.trim() && command.length <= VERIFY_MAX_COMMAND_LENGTH && !/[\r\n]/.test(command)) || !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 3) return { ok: false, error: this.deps.error("options") };
    const commands = parseVerifyCommands(options.commands.join("\n"));
    if (!commands.length) return { ok: false, error: this.deps.error("options") };
    const context = this.deps.context(tabId);
    if (!context.available || !context.cwd || !commands.length) return { ok: false, error: this.deps.error("context") };
    if (context.busy || this.activeCwd(context.cwd)) return { ok: false, error: this.deps.error("busy") };
    const now = Date.now();
    const job: Job = {
      state: { id: randomUUID(), tabId, cwd: context.cwd, commands, phase: "checking", attempt: 0, maxAttempts: options.maxAttempts, startedAt: now, updatedAt: now, reason: null },
      provider: context.provider, controller: new AbortController(), done: Promise.resolve(), fixing: false, ownsFix: false, fixError: false,
    };
    this.jobs.set(tabId, job);
    this.update(job, {});
    job.done = this.execute(job);
    return { ok: true, id: job.state.id };
  }

  async stop(tabId: string): Promise<void> {
    const job = this.jobs.get(tabId);
    if (!job || !feedbackActive(job.state)) return;
    this.update(job, { phase: "stopping" });
    job.controller.abort();
    await job.done;
  }
  async stopForCwd(cwd: string): Promise<void> {
    await Promise.all([...this.jobs.entries()].filter(([, job]) => feedbackActive(job.state) && this.pathKey(job.state.cwd) === this.pathKey(cwd)).map(([tabId]) => this.stop(tabId)));
  }
  dispose() { for (const [tabId] of this.jobs) void this.stop(tabId); }
  forget(tabId: string) { if (!this.active(tabId)) { this.jobs.delete(tabId); this.restored.delete(tabId); } }
  onEvent(tabId: string, event: ChatEvent) {
    const job = this.jobs.get(tabId);
    if (!job?.fixing) return;
    if (event.type === "error" || (event.type === "turn_result" && event.isError)) job.fixError = true;
    if (job.controller.signal.aborted) return;
    if (event.type === "status" && ["waiting_permission", "queued"].includes(event.status)) this.update(job, { phase: "waiting" });
    else if (event.type === "status" && event.status === "running") this.update(job, { phase: "fixing" });
  }

  private context(job: Job): FeedbackContext {
    const context = this.deps.context(job.state.tabId);
    if (!context.available || context.provider !== job.provider || this.pathKey(context.cwd) !== this.pathKey(job.state.cwd)) throw new Error(this.deps.error("context"));
    return context;
  }
  private async execute(job: Job) {
    const { tabId, cwd, commands } = job.state;
    const signal = job.controller.signal;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; job.controller.abort(); }, this.deps.timeoutMs ?? 10 * 60_000);
    const abort = () => { if (job.ownsFix) this.deps.abortFix(tabId); };
    signal.addEventListener("abort", abort);
    try {
      let previousFailure: string | null = null;
      while (!signal.aborted) {
        if (this.context(job).busy) throw new Error(this.deps.error("busy"));
        this.update(job, { phase: "checking", reason: null });
        const before = await this.deps.revision(cwd, signal);
        if (signal.aborted) break;
        const verification = await this.deps.verify(tabId, cwd, [...commands], signal);
        if (signal.aborted || verification.status === "aborted") break;
        this.context(job);
        const after = await this.deps.revision(cwd, signal);
        if (signal.aborted) break;
        let remaining = 12000;
        const outputs = new Map<number, string>();
        const priority = verification.commands.map((command, index) => ({ command, index })).sort((a, b) => Number(b.command.status === "failed") - Number(a.command.status === "failed"));
        for (const { command, index } of priority) {
          const output = remaining > 0 ? (command.output ?? "").slice(-remaining) : "";
          remaining -= output.length;
          outputs.set(index, output);
        }
        const compact = { ...verification, commands: verification.commands.map((command, index) => {
          const output = outputs.get(index) ?? "";
          return { ...command, output, ...(output.length < (command.output?.length ?? 0) ? { truncated: true as const } : {}) };
        }) };
        this.update(job, { verification: compact, revision: after, ...(verification.status === "failed" ? { failure: compact, phase: "detected" as const } : {}) });
        if (before !== after) { this.update(job, { phase: "stale", reason: "changed" }); return; }
        if (verification.status === "passed") { this.update(job, { phase: "passed" }); return; }
        if (job.state.attempt >= job.state.maxAttempts) { this.update(job, { phase: "failed", reason: "limit" }); return; }
        const failure = `${after}\n${verification.commands.filter(command => command.status === "failed").map(command => `${command.cmd}\n${command.exitCode}\n${command.output}`).join("\n")}`;
        if (previousFailure === failure) { this.update(job, { phase: "failed", reason: "unchanged" }); return; }
        previousFailure = failure;
        while (!signal.aborted && (this.context(job).ownBusy ?? this.context(job).busy)) await new Promise(resolve => setTimeout(resolve, 100));
        if (signal.aborted) break;
        if (this.context(job).busy) throw new Error(this.deps.error("busy"));
        if (await this.deps.revision(cwd, signal) !== after) { this.update(job, { phase: "stale", reason: "changed" }); return; }
        if (signal.aborted) break;
        job.fixError = false;
        job.fixing = true;
        this.update(job, { phase: "fixing", attempt: job.state.attempt + 1 });
        const sent = await this.deps.send(tabId, feedbackPrompt(job.state), signal);
        if (!sent.ok) throw new Error(sent.error || this.deps.error("context"));
        job.ownsFix = true;
        if (signal.aborted) abort();
        while ((this.context(job).ownBusy ?? this.context(job).busy)) await new Promise(resolve => setTimeout(resolve, 100));
        job.fixing = false;
        job.ownsFix = false;
        if (signal.aborted) break;
        if (job.fixError) { this.update(job, { phase: "failed", reason: "agentFailed" }); return; }
      }
      this.update(job, { phase: "stopped", reason: timedOut ? "timeout" : "interrupted" });
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(-6000);
      this.update(job, { phase: signal.aborted ? "stopped" : "failed", reason: signal.aborted ? (timedOut ? "timeout" : "interrupted") : detail === this.deps.error("context") ? "context" : "error", detail });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      job.fixing = false;
      job.ownsFix = false;
    }
  }
}
