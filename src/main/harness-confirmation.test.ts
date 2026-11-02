import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmationSource } from "./harness-confirmation";
import type { ChatEvent } from "@shared/chat-events";
import type { HarnessAction } from "@shared/harness";

test("conversation confirmation resolves its original user and validates the actual proposal", async () => {
  const action: Extract<HarnessAction, { type: "confirm" }> = { type: "confirm", taskId: "t", criterionId: "c", criterionRevision: 1, note: "checked", confirmationBlockId: "a" };
  const user: ChatEvent = { type: "user_message", id: "u", text: "checked", ts: 10 };
  const proposal: ChatEvent = { type: "assistant_text", blockId: "a", text: '```sudal-confirm\n' + JSON.stringify({ taskId: "t", criterionId: "c", criterionRevision: 1, quote: "checked" }) + '\n```', ts: 11 };
  const events: ChatEvent[] = [user, proposal, { type: "user_message", id: "later", text: "change the code", ts: 20 }];
  assert.deepEqual(await confirmationSource(events, action), user);
  for (const invalid of [{ confirmationBlockId: "invented" }, { taskId: "other" }, { criterionId: "other" }, { criterionRevision: 2 }, { note: "invented" }]) assert.equal(await confirmationSource(events, { ...action, ...invalid }), undefined);
  assert.equal(await confirmationSource([proposal], action), undefined);
  assert.equal(await confirmationSource([user, events[2], proposal], action), undefined);
  assert.equal(await confirmationSource([...events, { ...proposal, text: "replaced" }], action), undefined);
});
