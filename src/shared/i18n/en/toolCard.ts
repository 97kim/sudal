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
  codexAgentOperation: {
    spawnAgent: "Spawn agent", sendInput: "Send task", resumeAgent: "Resume agent",
    wait: "Wait for results", closeAgent: "Close agent", sendMessage: "Send message",
    followupTask: "Send follow-up task", interruptAgent: "Interrupt agent", listAgents: "List agents",
    started: "Task started", interacted: "Task progress", interrupted: "Task interrupted", completed: "Task completed",
  },
  codexAgentStatus: {
    pendingInit: "Preparing", running: "Running", interrupted: "Interrupted", completed: "Completed",
    errored: "Error", shutdown: "Closed", notFound: "Not found", unknown: "Checking status",
  },
  aiApproved: "AI approved",
  aiApprovedHint: "This action needed approval, and an AI reviewed and allowed it.",
  aiReviewing: "AI reviewing",
  subagentViaCodexHint: "Progress of the Codex launched by codex-companion (rollout mirror)",
  subagentTools: "{{count}} tool calls",
  moreLines: "… show {{count}} more lines",
};
