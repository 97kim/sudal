/** Codex App Server가 유지하는 상태. TUI 명령 문자열을 모델 프롬프트로 보내지 않는다. */
export type CodexMode = "default" | "plan";
export interface CodexGoal {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}
export const CODEX_CONTROL_COMMANDS = ["plan", "goal", "mcp", "ps", "stop", "status", "usage", "fast", "memories", "hooks", "plugins", "debug-config", "rename", "compact", "review", "cd"] as const;
export type CodexControlCommand = typeof CODEX_CONTROL_COMMANDS[number];
export interface CodexControlResult {
  mode?: CodexMode;
  goal?: CodexGoal | null;
  data?: unknown;
}

export type GoalAction = { action: "get" | "clear" } | { action: "set"; objective?: string; status?: "active" | "paused"; tokenBudget?: number };
export function parseGoalAction(arg: string): GoalAction {
  const value = arg.trim();
  if (!value || value === "status") return { action: "get" };
  if (value === "clear") return { action: "clear" };
  if (value === "pause" || value === "resume") return { action: "set", status: value === "pause" ? "paused" : "active" };
  const budget = /^budget\s+(\d+)$/.exec(value);
  if (budget) {
    const tokenBudget = Number(budget[1]);
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) throw new Error("goalBudget");
    return { action: "set", tokenBudget };
  }
  if (/^budget(?:\s|$)/.test(value)) throw new Error("goalBudget");
  if ([...value].length > 4000) throw new Error("goalLength");
  return { action: "set", objective: value, status: "active" };
}
