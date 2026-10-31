import { parseGoalAction, type CodexControlCommand, type CodexControlResult, type CodexMode } from "@shared/codex-controls";
import { MsgError } from "./i18n";

interface Client { request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> }
export interface CodexControlContext { threadId: string; cwd: string; model: string | null; mode?: CodexMode }

export function codexControlError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown (?:method|variant)|method not found|unrecognized method|-32601/i.test(message) ? new MsgError("session.msg.codexControl.appServerRequired") : error;
}

export function codexCollaborationMode(mode: CodexMode, model: string | null) {
  if (!model) throw new MsgError("session.msg.codexControl.modelMissing");
  return { mode, settings: { model, reasoning_effort: null, developer_instructions: null } };
}

/** 설정 진단에는 인증 값·환경 변수 값이 섞일 수 있어 화면으로 보내기 전에 가린다. */
export function redactCodexControlData(value: unknown, depth = 0, parentKey = ""): unknown {
  if (depth > 12) return "…";
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactCodexControlData(item, depth + 1, parentKey));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /api.?key|token|secret|password|authorization|cookie|headers$|^env$/i.test(key) || (key === "set" && /^shell_?environment_?policy$/i.test(parentKey)) ? "••••" : redactCodexControlData(item, depth + 1, key)]));
  return typeof value === "string" ? value.slice(0, 20_000) : value;
}

/** TUI 문자열 대신 대응하는 공개 RPC를 실행한다. */
export async function executeCodexControl(client: Client, ctx: CodexControlContext, command: CodexControlCommand, arg: string): Promise<CodexControlResult> {
  const threadId = ctx.threadId;
  if (command === "plan") {
    const mode = arg === "off" || arg === "default" ? "default" : arg === "on" ? "plan" : ctx.mode === "plan" ? "default" : "plan";
    await client.request("thread/settings/update", { threadId, collaborationMode: codexCollaborationMode(mode, ctx.model) });
    return { mode };
  }
  if (command === "goal") {
    let action;
    try { action = parseGoalAction(arg); } catch (e) { throw new MsgError((e as Error).message === "goalLength" ? "session.msg.codexControl.goalLength" : "session.msg.codexControl.goalBudget"); }
    if (action.action === "clear") {
      await client.request("thread/goal/clear", { threadId, origin: "user" });
      return { goal: null };
    }
    const result = action.action === "get"
      ? await client.request<{ goal: CodexControlResult["goal"] }>("thread/goal/get", { threadId })
      : await client.request<{ goal: CodexControlResult["goal"] }>("thread/goal/set", { threadId, origin: "user", ...Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action")) });
    return { goal: result.goal ?? null };
  }
  if (command === "rename") {
    if (!arg.trim()) throw new MsgError("session.msg.codexControl.renameRequired");
    await client.request("thread/name/set", { threadId, name: arg.trim() });
    return {};
  }
  if (command === "fast") {
    if (!["on", "off"].includes(arg)) throw new MsgError("session.msg.codexControl.fastUsage");
    await client.request("thread/settings/update", { threadId, serviceTier: arg === "on" ? "fast" : "default" });
    return { data: { fast: arg === "on" } };
  }
  if (command === "memories") {
    if (!arg) return { data: await client.request("thread/memory/read", { threadId }) };
    if (!["on", "off"].includes(arg)) throw new MsgError("session.msg.codexControl.memoriesUsage");
    const mode = arg === "on" ? "enabled" : "disabled";
    await client.request("thread/memoryMode/set", { threadId, mode });
    return { data: { mode } };
  }
  if (command === "stop") {
    await client.request("thread/backgroundTerminals/clean", { threadId });
    return { data: { stopped: true } };
  }
  if (command === "ps") {
    const data: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: unknown[]; nextCursor?: string | null } = await client.request("thread/backgroundTerminals/list", { threadId, cursor, limit: 100 });
      data.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw new Error("Repeated terminal pagination cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { data: { data } };
  }
  if (command === "mcp") {
    const data: unknown[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: { data: unknown[]; nextCursor?: string | null } = await client.request("mcpServerStatus/list", { threadId, cursor, limit: 100 });
      data.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw new Error("Repeated MCP pagination cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { data };
  }
  const methods: Record<string, [string, Record<string, unknown>]> = {
    status: ["thread/read", { threadId, includeTurns: false }],
    usage: ["account/rateLimits/read", {}],
    hooks: ["hooks/list", { threadId }],
    plugins: ["plugin/list", { cwds: [ctx.cwd] }],
    "debug-config": ["config/read", { cwd: ctx.cwd, includeLayers: true }],
  };
  const [method, params] = methods[command];
  const data = await client.request(method, params);
  return { data: command === "debug-config" ? redactCodexControlData(data) : data };
}
