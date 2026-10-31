import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationFeedback } from "@shared/verification-feedback";

/** 실행 증거만 저장한다. 앱을 다시 열었을 때 자동으로 에이전트를 실행하지 않는다. */
export class VerificationFeedbackStore {
  constructor(private readonly dir: string) {}
  private path(tabId: string) { return join(this.dir, Buffer.from(tabId).toString("base64url") + ".json"); }
  load(tabId: string): VerificationFeedback | null {
    try {
      if (statSync(this.path(tabId)).size > 128 * 1024) return null;
      const raw = readFileSync(this.path(tabId), "utf8");
      if (raw.length > 64 * 1024) return null;
      const state = JSON.parse(raw) as VerificationFeedback;
      if (state.tabId !== tabId || typeof state.id !== "string" || typeof state.cwd !== "string" || !Array.isArray(state.commands) || !state.commands.every(command => typeof command === "string") || !["checking", "detected", "fixing", "waiting", "stopping", "passed", "failed", "stopped", "stale"].includes(state.phase)) return null;
      if (!Number.isInteger(state.attempt) || state.attempt < 0 || !Number.isInteger(state.maxAttempts) || state.maxAttempts < 1 || state.maxAttempts > 3 || !Number.isFinite(state.updatedAt) || !Number.isFinite(state.startedAt) || state.commands.length > 20 || state.commands.some(command => command.length > 500)) return null;
      if (state.detail !== undefined && typeof state.detail !== "string") return null;
      for (const verification of [state.verification, state.failure]) {
        if (verification === undefined) continue;
        if (!verification || typeof verification.runId !== "string" || !["running", "passed", "failed", "aborted"].includes(verification.status) || !Array.isArray(verification.commands) || verification.commands.length > 20 || verification.commands.some(command => !command || typeof command.cmd !== "string" || (command.output !== undefined && typeof command.output !== "string"))) return null;
      }
      return state;
    } catch { return null; }
  }
  save(state: VerificationFeedback) {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.path(state.tabId);
      writeFileSync(file + ".tmp", JSON.stringify(state), "utf8");
      renameSync(file + ".tmp", file);
    } catch (error) { console.warn("[verification-feedback] state persistence failed", error); }
  }
  remove(tabId: string) {
    try { rmSync(this.path(tabId), { force: true }); rmSync(this.path(tabId) + ".tmp", { force: true }); }
    catch (error) { console.warn("[verification-feedback] state cleanup failed", error); }
  }
}
