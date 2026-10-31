/** 표시할 필드만 읽는다. 누락된 값을 사용률 0%나 연결 성공으로 간주하지 않는다. */
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export const FORMATTED_CODEX_COMMANDS = ["usage", "mcp", "status", "ps", "hooks", "plugins", "memories", "fast", "stop", "debug-config"] as const;
export type FormattedCodexCommand = typeof FORMATTED_CODEX_COMMANDS[number];
export function isFormattedCodexCommand(name: string): name is FormattedCodexCommand { return (FORMATTED_CODEX_COMMANDS as readonly string[]).includes(name); }

export function codexSessionInfo(value: unknown) {
  const root = object(value), session = object(root.session), response = object(root.thread), thread = object(response.thread ?? root.thread);
  return {
    id: string(session.sessionId) ?? string(thread.id), name: string(thread.name),
    model: string(session.model) ?? string(thread.model), cwd: string(session.cwd) ?? string(thread.cwd),
    status: string(session.status), policy: string(session.policy), mode: string(session.codexMode), controller: string(session.controller),
    pending: Array.isArray(session.pendingPrompts) ? session.pendingPrompts.length : null,
    cliVersion: string(thread.cliVersion), branch: string(object(thread.gitInfo).branch),
  };
}

export function codexTerminals(value: unknown) {
  const raw = object(value).data;
  return { available: Array.isArray(raw), items: (Array.isArray(raw) ? raw : []).flatMap(value => {
    const row = object(value), command = string(row.command);
    if (!command) return [];
    return [{ id: string(row.processId) ?? string(row.itemId) ?? command, command, cwd: string(row.cwd), pid: number(row.osPid), cpu: number(row.cpuPercent), rssKb: number(row.rssKb) }];
  }) };
}

export function codexHooks(value: unknown) {
  const raw = object(value).data;
  const items: { key: string; event: string; enabled: boolean | null; trust: string | null; type: string | null; command: string | null; matcher: string | null; path: string | null; description: string | null }[] = [];
  const messages: { text: string; path: string | null; error: boolean }[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const group = object(entry);
    for (const warning of Array.isArray(group.warnings) ? group.warnings : []) if (string(warning)) messages.push({ text: String(warning), path: string(group.cwd), error: false });
    for (const error of Array.isArray(group.errors) ? group.errors : []) { const row = object(error); if (string(row.message)) messages.push({ text: String(row.message), path: string(row.path), error: true }); }
    for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
      const row = object(hook), event = string(row.eventName);
      if (!event) continue;
      items.push({ key: string(row.key) ?? `${event}:${items.length}`, event, enabled: typeof row.enabled === "boolean" ? row.enabled : null, trust: string(row.trustStatus), type: string(row.handlerType), command: string(row.command) ?? (string(row.server) && string(row.tool) ? `${row.server} / ${row.tool}` : null), matcher: string(row.matcher), path: string(row.sourcePath), description: string(row.statusMessage) });
    }
  }
  return { available: Array.isArray(raw), items, messages };
}

export function codexPlugins(value: unknown) {
  const root = object(value);
  const items: { key: string; name: string; description: string | null; developer: string | null; marketplace: string; version: string | null; state: "enabled" | "disabled" | "notInstalled" | "unavailable" | "unknown"; reason: string | null }[] = [];
  for (const value of Array.isArray(root.marketplaces) ? root.marketplaces : []) {
    const market = object(value);
    for (const plugin of Array.isArray(market.plugins) ? market.plugins : []) {
      const row = object(plugin), info = object(row.interface), name = string(info.displayName) ?? string(row.name);
      if (!name) continue;
      const state = row.availability === "DISABLED_BY_ADMIN" || string(row.disabledReason) ? "unavailable" : row.installed === false ? "notInstalled" : row.installed === true && row.enabled === true ? "enabled" : row.installed === true && row.enabled === false ? "disabled" : "unknown";
      const marketplace = string(market.name) ?? "";
      items.push({ key: `${marketplace}:${string(row.id) ?? name}`, name, description: string(info.shortDescription) ?? string(info.longDescription), developer: string(info.developerName), marketplace, version: string(row.localVersion) ?? string(row.version), state, reason: string(row.disabledReason) });
    }
  }
  const errors = (Array.isArray(root.marketplaceLoadErrors) ? root.marketplaceLoadErrors : []).flatMap(value => { const row = object(value), message = string(row.message); return message ? [{ text: message, path: string(row.marketplacePath), error: true }] : []; });
  return { available: Array.isArray(root.marketplaces), items, errors };
}

export function codexMemory(value: unknown) {
  const raw = object(value);
  return { available: "summary" in raw, summary: string(raw.summary), mode: raw.mode === "enabled" || raw.mode === "disabled" ? raw.mode : null };
}

/** Electron 통신 경로 대신 사용자가 판단할 수 있는 실제 오류 내용만 표시한다. */
export function codexResultErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}

export interface CodexUsageWindow {
  kind: "primary" | "secondary";
  usedPercent: number;
  minutes: number | null;
  resetsAt: number | null;
}
export interface CodexUsageGroup {
  id: string;
  name: string;
  plan: string | null;
  windows: CodexUsageWindow[];
  credits: { available: boolean | null; unlimited: boolean; balance: string | null } | null;
}

export function codexUsageGroups(value: unknown): { groups: CodexUsageGroup[]; ordinaryUsageAllowed: boolean | null } {
  const root = object(value);
  const buckets = Object.entries(object(root.rateLimitsByLimitId)).filter(([, value]) => value && typeof value === "object");
  const entries = buckets.length ? buckets : root.rateLimits && typeof root.rateLimits === "object" ? [["codex", root.rateLimits] as const] : [];
  const groups = entries.map(([id, raw]): CodexUsageGroup => {
    const snapshot = object(raw);
    const windows: CodexUsageWindow[] = [];
    for (const kind of ["primary", "secondary"] as const) {
      const raw = object(snapshot[kind]);
      const usedPercent = number(raw.usedPercent);
      if (usedPercent === null) continue;
      const minutes = number(raw.windowDurationMins);
      const reset = number(raw.resetsAt);
      windows.push({ kind, usedPercent: Math.min(100, Math.max(0, usedPercent)), minutes: minutes !== null && minutes > 0 ? minutes : null, resetsAt: reset !== null && reset > 0 && Number.isFinite(new Date(reset * 1000).getTime()) ? reset : null });
    }
    const credits = object(snapshot.credits);
    return {
      id, name: string(snapshot.limitName) ?? string(snapshot.limitId) ?? (id === "codex" ? "Codex" : id),
      plan: string(snapshot.planType), windows,
      credits: snapshot.credits && typeof snapshot.credits === "object" ? { available: typeof credits.hasCredits === "boolean" ? credits.hasCredits : null, unlimited: credits.unlimited === true, balance: string(credits.balance) } : null,
    };
  });
  return { groups, ordinaryUsageAllowed: typeof root.ordinaryUsageAllowed === "boolean" ? root.ordinaryUsageAllowed : null };
}

export const MCP_CONNECTION_STATES = ["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled", "unknown"] as const;
export type CodexMcpConnectionState = typeof MCP_CONNECTION_STATES[number];
export interface CodexMcpTool { name: string; title: string | null; description: string | null }
export interface CodexMcpServer {
  name: string;
  status: CodexMcpConnectionState;
  auth: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  origin: string | null;
  version: string | null;
  tools: CodexMcpTool[];
  toolsError: string | null;
  resources: { name: string; description: string | null }[];
  templateCount: number;
}

export function codexMcpServers(value: unknown): CodexMcpServer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CodexMcpServer[] => {
    const server = object(raw);
    const name = string(server.name);
    if (!name) return [];
    const tools = Object.entries(object(server.tools)).flatMap(([key, value]): CodexMcpTool[] => {
      if (!value || typeof value !== "object") return [];
      const tool = object(value);
      return [{ name: string(tool.name) ?? key, title: string(tool.title), description: string(tool.description) }];
    });
    let origin: string | null = null;
    try { const url = new URL(string(server.httpOrigin) ?? ""); if (["http:", "https:"].includes(url.protocol)) origin = url.origin; } catch { /* HTTP 서버가 아니면 주소를 표시하지 않는다. */ }
    return [{
      name, status: (MCP_CONNECTION_STATES as readonly unknown[]).includes(server.runtimeStatus) ? server.runtimeStatus as CodexMcpConnectionState : "unknown",
      auth: ["unsupported", "notLoggedIn", "bearerToken", "oAuth"].includes(String(server.authStatus)) ? server.authStatus as CodexMcpServer["auth"] : "unknown",
      origin, version: string(object(server.serverInfo).version), tools, toolsError: string(server.toolsError),
      resources: Array.isArray(server.resources) ? server.resources.flatMap(value => { const resource = object(value); const name = string(resource.title) ?? string(resource.name); return name ? [{ name, description: string(resource.description) }] : []; }) : [],
      templateCount: Array.isArray(server.resourceTemplates) ? server.resourceTemplates.length : 0,
    }];
  });
}
