import type { Block } from "@shared/session-state";
import type { HarnessTask } from "@shared/harness";

export interface ConversationConfirmation { criterionId: string; criterionRevision: number; quote: string; blockId: string }
/** Suggestions must quote the immediately preceding user message, never an agent assertion. */
export function conversationConfirmations(blocks: Block[], task: HarnessTask): ConversationConfirmation[] {
  const result: ConversationConfirmation[] = [];
  let userText = "";
  let userTimestamp = 0;
  for (const block of blocks.slice(-100)) {
    if (block.kind === "user") { result.length = 0; userText = block.text; userTimestamp = block.ts; continue; }
    if (block.kind !== "text" || block.streaming || block.text.length > 100000 || !userText) continue;
    for (const match of block.text.matchAll(/```sudal-confirm\s*\n([\s\S]*?)```/g)) {
      try {
        const value = JSON.parse(match[1]);
        const criterion = task.criteria.find(item => item.id === value?.criterionId);
        if (value?.taskId !== task.id || !criterion || value.criterionRevision !== criterion.revision ||
          typeof value.quote !== "string" || !value.quote.trim() || value.quote.length > 4000 || value.quote !== userText) continue;
        if (task.evidence.some(item => item.source === "user" && item.criterionId === criterion.id && item.criterionRevision === criterion.revision && item.reference === value.quote && item.timestamp >= userTimestamp)) continue;
        if (!result.some(item => item.criterionId === criterion.id && item.quote === value.quote)) result.push({ criterionId: criterion.id, criterionRevision: criterion.revision, quote: value.quote, blockId: block.id });
      } catch { /* Streaming and invalid suggestions do not change task state. */ }
    }
  }
  return result.slice(-5);
}
