import type { toolCard as ko } from "../ko/toolCard";
import type { DeepPartial } from "../types";

export const toolCard: DeepPartial<typeof ko> = {
  permissionTool: "Permissions",
  state: {
    partial: "Preparing input",
    waiting_permission: "Awaiting permission",
    waiting_answer: "Awaiting answer",
    denied: "Denied",
    skipped: "Skipped",
    failed: "Failed",
    done: "Done",
    running: "Running",
  },
  todoDone: "{{done}}/{{total}} done",
  openInEditor: "Open in editor",
  openInEditorLines: "Open in editor (line {{range}})",
  runInTerminalHint: "Put it in the terminal. Press Enter yourself ({{kAlt}}click: run right away)",
  subagent: "Subagent",
  aiApproved: "AI approved",
  aiApprovedHint: "This action needed approval, and an AI reviewed and allowed it.",
  aiReviewing: "AI reviewing",
  subagentViaCodexHint: "Progress of the Codex launched by codex-companion (rollout mirror)",
  subagentTools: "{{count}} tool calls",
  moreLines: "… show {{count}} more lines",
};
