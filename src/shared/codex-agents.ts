/** Codex app-server가 보고한 하위 에이전트 상태. 호출 완료와 에이전트 완료는 별개다. */
export const CODEX_AGENT_STATUSES = ["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound", "unknown"] as const;
export type CodexAgentStatus = typeof CODEX_AGENT_STATUSES[number];
export interface CodexAgentInfo {
  id: string;
  status: CodexAgentStatus;
  message?: string;
}
export interface CodexAgentInput {
  codexAgent: true;
  operation: string;
  description: string;
  prompt?: string;
  model?: string;
  agents: CodexAgentInfo[];
}

export function codexAgentStatus(value: unknown): CodexAgentStatus {
  return CODEX_AGENT_STATUSES.includes(value as CodexAgentStatus) ? value as CodexAgentStatus : "unknown";
}

/** 기록을 다시 열 때도 같은 상태를 그릴 수 있도록 툴 입력에 보관한다. */
export function readCodexAgentInput(value: unknown): CodexAgentInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.codexAgent !== true || !Array.isArray(input.agents)) return null;
  return {
    codexAgent: true,
    operation: typeof input.operation === "string" ? input.operation : "",
    description: typeof input.description === "string" ? input.description : "",
    agents: input.agents.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return [];
      return [{ id: raw.id, status: codexAgentStatus(raw.status), ...(typeof raw.message === "string" ? { message: raw.message } : {}) }];
    }),
  };
}
