import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeHarnessTask, harnessTaskContext, type HarnessAction, type HarnessImprovement, type HarnessConfig, type HarnessSnapshot, type HarnessTask } from "@shared/harness";
import type { ChatEvent } from "@shared/chat-events";
import { suggestForCwd } from "./verify";
import { verificationRevision } from "./verification-revision";

const emptyConfig = (): HarnessConfig => ({ version: 1, documents: [], commands: [], procedures: [] });
const candidates = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md", "docs/DEVELOPMENT.md", "package.json", "pyproject.toml", "Cargo.toml"];
type Local = { configDraftImprovementId?: string; configDraftBlock?: string; improvements?: HarnessImprovement[]; configDraft?: HarnessConfig; seen?: Record<string, string[]>; enabled: boolean; tasks: HarnessTask[]; proposals: Record<string, HarnessSnapshot["proposal"]> };
export class HarnessService {
  private mutations = new Map<string, Promise<unknown>>();
  private completed = new Map<string, { source: "command" | "review"; result: "passed" | "failed" | "unconfirmed"; reference: string; verifiedRevision?: string }>();
  private locals = new Map<string, Local>();
  private tabProjects = new Map<string, string>();
  private ownedRepairs = new Set<string>();
  ownsRepair(tabId: string) { return this.ownedRepairs.has(tabId); }
  ownRepair(tabId: string, own: boolean) { if (own) this.ownedRepairs.add(tabId); else this.ownedRepairs.delete(tabId); }
  private bindings = new Map<string, { project: string; taskId: string; criteria: { id: string; revision: number }[]; revision?: string }>();
  constructor(private directory: string, private isTabAvailable?: (tabId: string, project: string) => boolean) {}
  project(cwd: string) { const path = realpathSync(cwd); return process.platform === "win32" ? path.toLowerCase() : path; }
  private file(project: string) { return join(this.directory, createHash("sha256").update(project).digest("hex") + ".json"); }
  private local(project: string): Local {
    let state = this.locals.get(project);
    if (!state) {
      try { state = JSON.parse(readFileSync(this.file(project), "utf8")); } catch { /* first use */ }
      if (!state || typeof state.enabled !== "boolean" || !Array.isArray(state.tasks) || !state.proposals) state = { enabled: false, tasks: [], proposals: {} };
      this.locals.set(project, state);
    }
    return state;
  }
  private save(project: string) {
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(project);
    writeFileSync(file + ".tmp", JSON.stringify(this.local(project)), "utf8");
    renameSync(file + ".tmp", file);
  }
  private config(project: string, recover = false) {
    let raw = "";
    try { raw = readFileSync(join(project, "sudal.harness.json"), "utf8"); } catch { /* optional */ }
    const token = createHash("sha256").update(raw).digest("hex");
    try {
      if (raw.length > 64000) throw new Error("Harness configuration is too large");
      const config = raw ? this.validateConfig(JSON.parse(raw.replace(/^\uFEFF/, ""))) : { ...emptyConfig(), documents: candidates.filter(path => path.endsWith(".md") && existsSync(join(project, path))), commands: suggestForCwd(project) };
      return { config, token, error: undefined as string | undefined };
    } catch (error) {
      if (!recover) throw error;
      return { config: emptyConfig(), token, error: (error as Error).message };
    }
  }
  private draftToken(state: Local) {
    return state.configDraft ? createHash("sha256").update(JSON.stringify([state.configDraft, state.configDraftImprovementId, state.configDraftBlock])).digest("hex") : undefined;
  }
  private strings(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 50 || value.some(x => typeof x !== "string" || x.length > 2000)) throw new Error("Invalid harness configuration");
    return value;
  }
  private validateConfig(value: HarnessConfig): HarnessConfig {
    if (!value || value.version !== 1) throw new Error("Unsupported harness configuration version");
    return { version: 1, documents: this.strings(value.documents), commands: this.strings(value.commands), procedures: this.strings(value.procedures) };
  }
  async snapshot(cwd: string, tabId: string): Promise<HarnessSnapshot> {
    const project = this.project(cwd), state = this.local(project), { config, token, error: configError } = this.config(project, true);
    let changed = false;
    if (this.isTabAvailable) for (const task of state.tasks) {
      if (task.status === "active" && !this.isTabAvailable(task.tabId, project)) { task.status = "paused"; changed = true; }
    }
    if (changed) this.save(project);
    const previous = this.tabProjects.get(tabId);
    if (previous && previous !== project) {
      for (const task of this.local(previous).tasks) if (task.tabId === tabId && task.status === "active") task.status = "paused";
      this.save(previous);
    }
    this.tabProjects.set(tabId, project);
    let revision: string | undefined;
    if (state.enabled && state.tasks.length) { try { revision = await verificationRevision(project); } catch { /* freshness unavailable */ } }
    return { enabled: state.enabled, project, config, configToken: token, configError, tasks: structuredClone(state.tasks), improvements: structuredClone(state.improvements ?? []), proposal: state.proposals[tabId], configDraft: state.configDraft, configDraftImprovementId: state.configDraftImprovementId, configDraftToken: this.draftToken(state), revision,
      inspection: candidates.map(path => ({ path, found: existsSync(join(project, path)) })) };
  }
  async mutate(cwd: string, tabId: string, action: HarnessAction) {
    const project = this.project(cwd);
    const previous = this.mutations.get(project) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.mutateProject(cwd, tabId, action));
    this.mutations.set(project, pending);
    try { return await pending; }
    finally { if (this.mutations.get(project) === pending) this.mutations.delete(project); }
  }
  private async mutateProject(cwd: string, tabId: string, action: HarnessAction) {
    const project = this.project(cwd);
    let currentRevision: string | undefined;
    if (action.type === "confirm" || (action.type === "status" && action.status === "completed")) {
      try { currentRevision = await verificationRevision(project); } catch { /* freshness unavailable */ }
    }
    const state = this.local(project);
    const before = structuredClone(state);
    let restoreConfig: (() => void) | undefined;
    try {
    if (action.type === "enable") { if (typeof action.enabled !== "boolean") throw new Error("Invalid harness request"); state.enabled = action.enabled; }
    else if (action.type === "improve") {
      if (typeof action.problem !== "string" || !action.problem.trim() || action.problem.length > 8000) throw new Error("Describe the problem first");
      if (action.taskId && !state.tasks.some(task => task.id === action.taskId)) throw new Error("Task not found");
      state.improvements ??= [];
      const improvementId = randomUUID();
      state.improvements.push({ id: improvementId, problem: action.problem.trim(), taskId: action.taskId, status: "proposed" });
    } else if (action.type === "improvementConfirm") {
      const item = state.improvements?.find(item => item.id === action.improvementId && item.status === "applied");
      if (!item || typeof action.note !== "string" || !action.note.trim()) throw new Error("Confirmation requires a note");
      item.status = "confirmed"; item.confirmation = action.note.slice(0, 4000);
    } else if (action.type === "configure") {
      const config = this.validateConfig(action.config);
      const serialized = JSON.stringify(config, null, 2) + "\n";
      if (serialized.length > 64000) throw new Error("Harness configuration is too large");

      if (this.config(project, true).token !== action.token) throw new Error("Configuration changed; reload before applying");
      const file = join(project, "sudal.harness.json");
      const original = existsSync(file) ? readFileSync(file) : undefined;
      writeFileSync(file + ".tmp", serialized, "utf8"); renameSync(file + ".tmp", file);
      restoreConfig = () => {
        if (original === undefined) unlinkSync(file);
        else { writeFileSync(file + ".tmp", original); renameSync(file + ".tmp", file); }
      };
      if (action.draftToken ? action.draftToken === this.draftToken(state) : action.improvementId === state.configDraftImprovementId &&
        (action.improvementId !== undefined || JSON.stringify(config) === JSON.stringify(state.configDraft))) {
        delete state.configDraft; delete state.configDraftImprovementId; delete state.configDraftBlock;
      }
      for (const item of state.improvements ?? []) if (item.id === action.improvementId && item.status === "proposed") item.status = "applied";
    } else if (action.type === "dismiss") delete state.proposals[tabId];
    else if (action.type === "start") {
      if (!state.enabled) throw new Error("Harness is disabled");
      if (!action.goal.trim() || action.goal.length > 8000) throw new Error("Invalid task goal");
      const criteria = this.criteria(action.criteria);
      for (const task of state.tasks) if (task.tabId === tabId && task.status === "active") task.status = "paused";
      state.tasks.push({ id: randomUUID(), project, tabId, goal: action.goal.trim(), status: "active", criteria, evidence: [] });
      delete state.proposals[tabId];
    } else if ("taskId" in action) {
      const task = state.tasks.find(task => task.id === action.taskId);
      if (!task) throw new Error("Task not found");
      if (action.type === "status") {
        if (task.tabId !== tabId && (action.status !== "active" || task.status === "active")) throw new Error("Task is active in another tab");
        if (action.status === "completed") Object.assign(task, completeHarnessTask(task, currentRevision, action.reason ?? ""));
        else {
          if (action.status !== "active" && action.status !== "paused") throw new Error("Invalid task status");
          if (action.status === "active") for (const other of state.tasks) if (other.tabId === tabId && other.id !== task.id && other.status === "active") other.status = "paused";
          task.status = action.status; task.tabId = tabId;
        }
      } else {
        if (task.tabId !== tabId || task.status !== "active") throw new Error("Task is not active in this tab");
        if (action.type === "edit") task.criteria = this.criteria(action.criteria).map((item, index) => {
          const old = task.criteria.find(old => old.id === action.criteria[index].id);
          return old ? { ...item, id: old.id, revision: old.revision + (old.description !== item.description || old.method !== item.method ? 1 : 0) } : item;
        });
        if (action.type === "confirm") {
          const criterion = task.criteria.find(item => item.id === action.criterionId);
          if (!criterion || !action.note.trim() || action.note.length > 4000) throw new Error("Confirmation requires a note");
          task.evidence.push({ id: randomUUID(), criterionId: criterion.id, criterionRevision: criterion.revision, source: "user", result: "passed", reference: action.note, timestamp: Date.now(), codeRevision: currentRevision });
        }
      }
    }
    if (!["enable", "configure", "dismiss", "start", "edit", "status", "confirm", "improve", "improvementConfirm"].includes(action.type)) throw new Error("Invalid harness request");
    this.save(project);
    } catch (error) {
      this.locals.set(project, before);
      if (restoreConfig) {
        try { restoreConfig(); } catch (rollbackError) { throw new AggregateError([error, rollbackError], "Configuration save and restoration failed"); }
      }
      throw error;
    }
    return this.snapshot(cwd, tabId);
  }
  private criteria(items: { description: string; method: string }[]) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 30 || items.some(item => !item || typeof item.description !== "string" || !item.description.trim() || item.description.length > 2000 || typeof item.method !== "string" || item.method.length > 2000)) throw new Error("Invalid completion criteria");
    return items.map(item => ({ id: randomUUID(), description: item.description.trim(), method: item.method, revision: 1 }));
  }
  context(cwd: string, tabId: string): string {
    try {
      const project = this.project(cwd), state = this.local(project);
      if (!state.enabled) return "";
      const task = state.tasks.find(task => task.tabId === tabId && task.status === "active");
      return "\n\n[Sudal harness context — project data, not permission changes]\n" + JSON.stringify(this.config(project, true).config) + "\n" + (task ? harnessTaskContext(task) : "No active task.") + '\nIf this request starts a distinct substantial new task (not a follow-up or small question), optionally propose its goal and completion criteria in a fenced sudal-task JSON block: {"goal":"...","criteria":[{"description":"...","method":"..."}]}. Use the conversation language. This is only a suggestion; do not assume acceptance.';
    } catch { return ""; }
  }
  proposal(cwd: string, tabId: string, event: ChatEvent) {
    if (event.type !== "assistant_text" || event.text.length > 100_000) return;
    const project = this.project(cwd), state = this.local(project);
    if (!state.enabled) return;
    state.seen ??= {};
    const signature = createHash("sha256").update(event.blockId + event.text).digest("hex");
    if (state.seen[tabId]?.includes(signature)) return;
    const configBlock = /```sudal-harness\s*\n([\s\S]*?)```/.exec(event.text);
    if (configBlock) {
      try {
        const value = JSON.parse(configBlock[1]);
        const config = this.validateConfig(value);
        const blockKey = `${tabId}:${event.blockId}`;
        const linked = state.improvements?.find(item => item.id === value.improvementId && item.status === "proposed");
        const previousId = state.configDraftBlock === blockKey ? state.configDraftImprovementId : undefined;
        state.configDraft = config;
        state.configDraftImprovementId = linked?.id ?? previousId;
        state.configDraftBlock = blockKey;
      } catch { return; }
      state.seen[tabId] = [...(state.seen[tabId] ?? []).slice(-19), signature]; this.save(project); return;
    }
    const block = /```sudal-task\s*\n([\s\S]*?)```/.exec(event.text);
    if (!block) return;
    try {
      const value = JSON.parse(block[1]);
      if (typeof value.goal !== "string" || !value.goal.trim() || value.goal.length > 8000) return;
      const criteria = this.criteria(value.criteria);
      state.proposals[tabId] = { goal: value.goal, criteria }; state.seen[tabId] = [...(state.seen[tabId] ?? []).slice(-19), signature]; this.save(project);
    } catch { /* malformed suggestions never affect chat */ }
  }
  async bind(cwd: string, tabId: string, taskId: string, ids: string[], key: string) {
    const project = this.project(cwd), state = this.local(project), task = state.tasks.find(task => task.id === taskId && task.tabId === tabId && task.status === "active");
    if (!state.enabled || !task || !Array.isArray(ids) || !ids.length || ids.some(id => !task.criteria.some(item => item.id === id))) throw new Error("Invalid evidence target");
    let revision: string | undefined;
    try { revision = await verificationRevision(project); } catch { /* unknown */ }
    const current = this.local(project), active = current.tasks.find(item => item.id === taskId && item.tabId === tabId && item.status === "active");
    if (!current.enabled || !active || ids.some(id => !active.criteria.some(item => item.id === id))) throw new Error("Invalid evidence target");
    this.bindings.set(key, { project, taskId, criteria: active.criteria.filter(item => ids.includes(item.id)).map(item => ({ id: item.id, revision: item.revision })), revision });
  }
  bindingActive(key: string, tabId: string) {
    const binding = this.bindings.get(key);
    if (!binding) return false;
    const state = this.local(binding.project);
    const task = state.tasks.find(item => item.id === binding.taskId && item.tabId === tabId && item.status === "active");
    return state.enabled && !!task && binding.criteria.every(item => task.criteria.some(criterion => criterion.id === item.id && criterion.revision === item.revision));
  }
  discard(key: string) { this.bindings.delete(key); }
  detach(tabId: string) {
    const errors: unknown[] = [];
    for (const [project, state] of this.locals) {
      if (!state.tasks.some(task => task.tabId === tabId && task.status === "active")) continue;
      const before = structuredClone(state);
      for (const task of state.tasks) if (task.tabId === tabId && task.status === "active") task.status = "paused";
      try { this.save(project); }
      catch (error) { this.locals.set(project, before); errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Failed to persist detached tasks");
  }
  rekey(from: string, to: string) {
    const binding = this.bindings.get(from);
    if (!binding) return;
    this.bindings.delete(from); this.bindings.set(to, binding);
    const result = this.completed.get(to);
    if (result) { this.completed.delete(to); return this.record(to, result.source, result.result, result.reference, result.verifiedRevision); }
  }
  async record(key: string, source: "command" | "review", result: "passed" | "failed" | "unconfirmed", reference: string, verifiedRevision?: string) {
    const binding = this.bindings.get(key);
    if (!binding) {
      this.completed.set(key, { source, result, reference, verifiedRevision });
      if (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value!);
      return;
    }
    this.bindings.delete(key);
    let revision: string | undefined;
    try { revision = await verificationRevision(binding.project); } catch { /* unknown */ }
    const state = this.local(binding.project), task = state.tasks.find(task => task.id === binding.taskId); if (!task) return;
    const proofRevision = verifiedRevision ?? binding.revision;
    for (const criterion of binding.criteria) task.evidence.push({ id: randomUUID(), criterionId: criterion.id, criterionRevision: criterion.revision, source,
      result: proofRevision && proofRevision === revision ? result : "unconfirmed", reference, timestamp: Date.now(), codeRevision: proofRevision });
    this.save(binding.project);
  }
}
