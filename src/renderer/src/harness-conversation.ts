import type { Block } from "@shared/session-state";
import { harnessCriterionEvidence, type HarnessProposal, type HarnessTask, type HarnessEvidence } from "@shared/harness";
import { sameCwdOrNull } from "@shared/any-path";

/** Never move a card to the tail when its source is outside the loaded history. */
export function harnessBlockBefore(blocks: Block[], timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !blocks.some(block => "ts" in block && block.ts <= timestamp)) return undefined;
  let id: string | undefined;
  for (const block of blocks) {
    if ("ts" in block && block.ts > timestamp) break;
    id = block.id;
  }
  return id;
}

export function harnessProposalBlock(blocks: Block[], proposal: HarnessProposal): string | undefined {
  if (proposal.blockId) return proposal.blockId;
  // Compatibility with proposals saved before source message IDs were stored.
  return blocks.findLast(block => block.kind === "text" && [...block.text.matchAll(/```sudal-task\s*\n([\s\S]*?)```/g)].some(match => {
    try {
      const value = JSON.parse(match[1]);
      return value.goal === proposal.goal && Array.isArray(value.criteria) && value.criteria.length === proposal.criteria.length &&
        value.criteria.every((item: { description?: unknown; method?: unknown } | null, index: number) => typeof item?.description === "string" && item.description.trim() === proposal.criteria[index].description && item.method === proposal.criteria[index].method);
    } catch { return false; }
  }))?.id;
}

/** Evidence time determines precedence; attachment time determines the ready card's position. */
export function harnessReadyBlock(blocks: Block[], task: HarnessTask): string | undefined {
  const effective = task.criteria.map(criterion => harnessCriterionEvidence(task, criterion)).filter((item): item is HarnessEvidence => !!item);
  const latest = effective.reduce<HarnessEvidence | undefined>((last, item) => !last || (item.recordedAt ?? item.timestamp) >= (last.recordedAt ?? last.timestamp) ? item : last, undefined);
  return latest?.afterBlockId ?? harnessBlockBefore(blocks, latest && (latest.recordedAt ?? latest.timestamp));
}

export interface ConversationVerificationLink { runId: string; criteria: { id: string; revision: number }[]; blockId: string }
/** Agent proposals only select targets; the app's real result remains authoritative. */
export function conversationVerificationLinks(blocks: Block[], task: HarnessTask, cwd = task.project): ConversationVerificationLink[] {
  const runs = new Set(blocks.filter(block => block.kind === "verify" && block.status !== "running" && sameCwdOrNull(block.cwd, cwd)).map(block => block.id));
  const result: ConversationVerificationLink[] = [];
  let hasUser = false;
  for (const block of blocks) {
    if (block.kind === "user") { hasUser = true; continue; }
    if (!hasUser || block.kind !== "text" || block.streaming || block.text.length > 100000) continue;
    for (const match of block.text.matchAll(/```sudal-evidence\s*\n([\s\S]*?)```/g)) {
      try {
        const value = JSON.parse(match[1]);
        if (value?.taskId !== task.id || typeof value.runId !== "string" || !runs.has(value.runId) || !Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 30) continue;
        if (value.criteria.some((item: { id: string; revision: number } | null) => !item || !task.criteria.some(criterion => criterion.id === item.id && criterion.revision === item.revision))) continue;
        if (new Set(value.criteria.map((item: { id: string }) => item.id)).size !== value.criteria.length) continue;
        const criteria = task.criteria.filter(criterion => value.criteria.some((item: { id: string }) => item.id === criterion.id) && !task.evidence.some(item => item.source === "command" && item.reference === value.runId && item.criterionId === criterion.id && item.criterionRevision === criterion.revision)).map(({ id, revision }) => ({ id, revision }));
        const previous = result.findIndex(item => item.runId === value.runId);
        if (previous >= 0) result.splice(previous, 1);
        if (criteria.length) result.push({ runId: value.runId, criteria, blockId: block.id });
      } catch { /* Invalid/partial output never changes state. */ }
    }
  }
  return result.slice(-5);
}

export interface ConversationConfirmation { criterionId: string; criterionRevision: number; quote: string; blockId: string }
/** Suggestions must quote the immediately preceding user message, never an agent assertion. */
export function conversationConfirmations(blocks: Block[], task: HarnessTask): ConversationConfirmation[] {
  const result: ConversationConfirmation[] = [];
  let userText = "";
  let userTimestamp = 0;
  for (const block of blocks) {
    if (block.kind === "user") { userText = block.text; userTimestamp = block.ts; continue; }
    if (block.kind !== "text" || block.streaming || block.text.length > 100000 || !userText) continue;
    for (const match of block.text.matchAll(/```sudal-confirm\s*\n([\s\S]*?)```/g)) {
      try {
        const value = JSON.parse(match[1]);
        const criterion = task.criteria.find(item => item.id === value?.criterionId);
        if (value?.taskId !== task.id || !criterion || value.criterionRevision !== criterion.revision ||
          typeof value.quote !== "string" || !value.quote.trim() || value.quote.length > 4000 || value.quote !== userText) continue;
        const previous = result.findIndex(item => item.criterionId === criterion.id && item.quote === value.quote);
        if (previous >= 0) result.splice(previous, 1);
        if (task.evidence.some(item => item.source === "user" && item.criterionId === criterion.id && item.criterionRevision === criterion.revision &&
          (item.confirmationBlockId === block.id || !item.confirmationBlockId && item.reference === value.quote && item.timestamp >= userTimestamp))) continue;
        result.push({ criterionId: criterion.id, criterionRevision: criterion.revision, quote: value.quote, blockId: block.id });
      } catch { /* Streaming and invalid suggestions do not change task state. */ }
    }
  }
  return result.slice(-5);
}
