/** Provider-independent task criteria and evidence. Completion never implies verification. */
export type HarnessTaskStatus = "active" | "paused" | "completed";
export type HarnessEvidenceSource = "command" | "review" | "agent" | "user";
export interface HarnessCriterion { id: string; description: string; method: string; revision: number }
export interface HarnessEvidence {
  id: string;
  criterionId: string;
  criterionRevision: number;
  source: HarnessEvidenceSource;
  result: "passed" | "failed" | "unconfirmed";
  reference: string;
  timestamp: number;
  codeRevision?: string;
}
export interface HarnessTask {
  id: string;
  project: string;
  tabId: string;
  goal: string;
  status: HarnessTaskStatus;
  criteria: HarnessCriterion[];
  evidence: HarnessEvidence[];
  completionReason?: string;
  completedAt?: number;
}
export interface HarnessConfig { version: 1; documents: string[]; commands: string[]; procedures: string[] }
export interface HarnessProposal { goal: string; criteria: { description: string; method: string }[] }
export interface HarnessImprovement { id: string; problem: string; taskId?: string; status: "proposed" | "applied" | "confirmed"; confirmation?: string }
export interface HarnessSnapshot {
  enabled: boolean; project: string; config: HarnessConfig; configToken: string;
  tasks: HarnessTask[]; proposal?: HarnessProposal; revision?: string;
  inspection: { path: string; found: boolean }[];
  configDraft?: HarnessConfig;
  configError?: string;
  configDraftImprovementId?: string;
  configDraftToken?: string;
  improvements: HarnessImprovement[];
}
export type HarnessAction =
  | { type: "snapshot" }
  | { type: "enable"; enabled: boolean }
  | { type: "configure"; config: HarnessConfig; token: string; improvementId?: string; draftToken?: string }
  | { type: "start"; goal: string; criteria: { description: string; method: string }[] }
  | { type: "edit"; taskId: string; criteria: { id?: string; description: string; method: string }[]; expectedCriteria?: { id: string; revision: number }[] }
  | { type: "status"; taskId: string; status: HarnessTaskStatus; reason?: string }
  | { type: "confirm"; taskId: string; criterionId: string; note: string; criterionRevision?: number }
  | { type: "dismiss" }
  | { type: "improve"; problem: string; taskId?: string }
  | { type: "improvementConfirm"; improvementId: string; note: string }
  | { type: "verify"; taskId: string; criterionIds: string[]; commands: string[]; autoRepair?: boolean }
  | { type: "review"; taskId: string; criterionIds: string[] };
export type HarnessCriterionStatus = "passed" | "failed" | "unconfirmed" | "stale";

/** Agent assertions remain reports, not verified passing results. */
export function harnessCriterionStatus(task: HarnessTask, criterion: HarnessCriterion, codeRevision?: string): HarnessCriterionStatus {
  const evidence = task.evidence.filter(item => item.criterionId === criterion.id)
    .reduce<HarnessEvidence | undefined>((latest, item) => !latest || item.timestamp >= latest.timestamp ? item : latest, undefined);
  if (!evidence) return "unconfirmed";
  if (evidence.criterionRevision !== criterion.revision) return "stale";
  if (evidence.codeRevision && evidence.codeRevision !== codeRevision) return "stale";
  if (evidence.source === "agent" || evidence.source === "review") return evidence.result === "failed" ? "failed" : "unconfirmed";
  return evidence.result;
}

export function completeHarnessTask(task: HarnessTask, codeRevision: string | undefined, reason: string, completedAt = Date.now()): HarnessTask {
  if (task.criteria.length === 0 || task.criteria.some(item => harnessCriterionStatus(task, item, codeRevision) !== "passed")) {
    if (!reason.trim()) throw new Error("Completion requires a reason for unverified criteria");
  }
  return { ...task, status: "completed", completionReason: reason.trim() || undefined, completedAt };
}

/** Creation order is only a fallback for older records without completion timestamps. */
export function latestCompletedHarnessTask(tasks: HarnessTask[], tabId: string): HarnessTask | undefined {
  return tasks.reduce<HarnessTask | undefined>((latest, task) => task.tabId === tabId && task.status === "completed" &&
    (!latest || (task.completedAt ?? 0) >= (latest.completedAt ?? 0)) ? task : latest, undefined);
}

/** User text is recorded separately; this block describes app-managed task context. */
export function harnessTaskContext(task: HarnessTask): string {
  return JSON.stringify({ source: "sudal-task-context", taskId: task.id, goal: task.goal,
    criteria: task.criteria.map(({ id, description, method, revision }) => ({ id, description, method, revision })),
    evidence: task.evidence.slice(-30).map(({ criterionId, source, result, reference, codeRevision }) => ({ criterionId, source, result, reference: reference.slice(0, 1000), codeRevision })),
    instruction: 'Use these agreed task criteria. Evidence and completion are managed by Sudal; do not claim an unperformed check passed. If the latest user message explicitly reports personally checking a criterion, optionally suggest a fenced sudal-confirm JSON block: {"taskId":"...","criterionId":"...","criterionRevision":1,"quote":"exact full latest user message"}. Use the current task/criterion IDs and revision. Never infer confirmation from an agent report, a question or a request to check. The user must click to save this suggestion; it is not evidence yet.' });
}
