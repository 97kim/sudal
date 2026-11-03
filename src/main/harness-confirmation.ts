import type { ChatEvent, UserMessageEvent } from "@shared/chat-events";
import type { HarnessAction } from "@shared/harness";

/** Reads only this tab's authoritative log. Renderer timestamps/quotes are not proof. */
export async function confirmationSource(events: Iterable<ChatEvent>, action: Extract<HarnessAction, { type: "confirm" }>): Promise<UserMessageEvent | undefined> {
  if (!Number.isInteger(action.criterionRevision) || action.criterionRevision! < 1) return undefined;
  let user: UserMessageEvent | undefined, source: UserMessageEvent | undefined;
  let count = 0;
  for (const event of events) {
    if (++count % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    if (event.type === "user_message") user = event;
    if (event.type !== "assistant_text" || event.blockId !== action.confirmationBlockId) continue;
    source = undefined;
    if (!user || !Number.isFinite(user.ts) || event.text.length > 100000) continue;
    for (const match of event.text.matchAll(/```sudal-confirm\s*\n([\s\S]*?)```/g)) {
      try {
        const value = JSON.parse(match[1]);
        if (value.taskId === action.taskId && value.criterionId === action.criterionId && value.criterionRevision === action.criterionRevision && value.quote === user.text && action.note === user.text) source = user;
      } catch { /* Partial or invalid output cannot become evidence. */ }
    }
  }
  return source;
}
