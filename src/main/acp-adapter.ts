// 명시적으로 만든 실험 탭만 사용한다. 기존 SDK/App Server 세션 ID와 섞지 않는다.
import { randomUUID } from "node:crypto";
import type { SessionNotification, SessionConfigOption, ToolCallContent } from "@agentclientprotocol/sdk";
import { ZERO_USAGE, type ChatEvent, type PermissionAnswer, type PermissionRequestEvent } from "@shared/chat-events";
import type { SlashCommandDto } from "@shared/slash-commands";
import type { AcpConfigValueDto } from "@shared/ipc";
import type { StoredChatImage } from "./chat-attachments";
import { AcpClient, type AcpLaunchOptions, type AcpProvider } from "./acp-client";
import { acpConfigValues, acpSelectOptions } from "./acp-session";
import { appMsg } from "./i18n";

interface OpenRequest {
  sessionKey: string;
  provider: AcpProvider;
  cwd: string;
  sessionId: string | null;
  onSession(id: string): void;
  onCommands(): void;
  onConfig?(): void;
}
interface Entry {
  startup: AbortController;
  client?: AcpClient;
  ready: Promise<void>;
  closed: boolean;
  id: string | null;
  commands: SlashCommandDto[];
  commandSets: Map<string, SlashCommandDto[]>;
  config: AcpConfigValueDto[];
  onConfig(): void;
  turn?: { emit(event: ChatEvent): void; permission(req: PermissionRequestEvent, signal: AbortSignal): Promise<PermissionAnswer>; block: string | null };
}

function toolText(content: ToolCallContent[] | null | undefined): string {
  return (content ?? []).flatMap(part => part.type === "content" && part.content.type === "text" ? [part.content.text] : part.type === "diff" ? [`${part.path}\n${part.newText}`] : []).join("\n");
}

export class AcpAdapter {
  private entries = new Map<string, Entry>();
  constructor(private runtime: (provider: AcpProvider, tabId: string) => Promise<Omit<AcpLaunchOptions, "cwd">>) {}

  async open(req: OpenRequest): Promise<void> {
    let entry = this.entries.get(req.sessionKey);
    if (entry && !entry.closed && entry.client?.alive === false) { this.close(req.sessionKey); entry = undefined; }
    if (!entry) {
      entry = { startup: new AbortController(), closed: false, ready: Promise.resolve(), id: req.sessionId, commands: [], commandSets: new Map(), config: [], onConfig: () => req.onConfig?.() };
      const current = entry;
      this.entries.set(req.sessionKey, current);
      current.ready = (async () => {
        const options = await this.runtime(req.provider, req.sessionKey);
        if (current.closed) throw new Error("ACP session closed");
        const client = await AcpClient.start({ ...options, cwd: req.cwd }, {
          onCommands: (id, commands) => {
            if (current.closed) return;
            current.commandSets.set(id, commands);
            if (id === current.id) { current.commands = commands; req.onCommands(); }
          },
          onUpdate: update => this.update(current, update),
          requestPermission: async (request, signal) => {
            const turn = current.turn;
            if (!turn || signal.aborted || request.sessionId !== current.id) return null;
            // 일회 승인 선택지만 대응한다. always를 추측해 영구 허용하지 않는다.
            const allow = request.options.find(option => option.kind === "allow_once");
            const deny = request.options.find(option => option.kind === "reject_once");
            const event: PermissionRequestEvent = {
              type: "permission_request", ts: Date.now(), requestId: randomUUID(),
              toolUseId: request.toolCall.toolCallId, tool: request.toolCall.kind ?? "ACP",
              title: request.toolCall.title ?? undefined, input: { acp: request.toolCall.rawInput ?? {}, options: request.options.map(option => option.name) },
              canAlwaysAllow: false,
            };
            const pending = turn.permission(event, signal);
            turn.emit(event);
            turn.emit({ type: "status", ts: Date.now(), status: "waiting_permission" });
            const answer = await pending;
            const selected = signal.aborted ? null : answer.behavior === "allow" ? allow?.optionId ?? null : deny?.optionId ?? null;
            turn.emit({ type: "permission_resolved", ts: Date.now(), requestId: event.requestId, behavior: selected && selected === allow?.optionId ? "allow" : "deny" });
            if (!signal.aborted) turn.emit({ type: "status", ts: Date.now(), status: "running" });
            return selected;
          },
        }, current.startup.signal);
        current.client = client;
        if (current.closed) { await client.close(); throw new Error("ACP session closed"); }
        try {
          // resume은 기록을 재전송하지 않는다. load 재생은 로컬 기록과 중복되지 않도록 버린다.
          const response = req.sessionId
            ? client.info.agentCapabilities?.sessionCapabilities?.resume
              ? await client.resumeSession({ sessionId: req.sessionId, cwd: req.cwd, mcpServers: [] })
              : await client.loadSession({ sessionId: req.sessionId, cwd: req.cwd, mcpServers: [] })
            : await client.newSession({ cwd: req.cwd, mcpServers: [] });
          if (current.closed) throw new Error("ACP session closed");
          current.id = "sessionId" in response ? response.sessionId as string : req.sessionId;
          if (!current.id) throw new Error("ACP did not return a session ID");
          // 실험 대화는 ask로 시작한다. 미지원 mode를 더 느슨한 정책으로 대체하지 않는다.
          const mode = (response.configOptions ?? []).find((option: SessionConfigOption) => option.id === "mode");
          const value = req.provider === "claude" ? "default" : "read-only";
          if (!mode || !acpSelectOptions(mode).some(option => option.value === value)) throw new Error("ACP adapter does not advertise the required ask mode");
          const applied = await client.setConfigOption({ sessionId: current.id, configId: mode.id, value });
          if (!applied.configOptions.some(option => option.id === mode.id && option.currentValue === value)) throw new Error("ACP adapter did not apply the required ask mode");
          if (current.closed) throw new Error("ACP session closed");
          this.configUpdate(current, applied.configOptions);
          current.commands = current.commandSets.get(current.id) ?? [];
          current.commandSets.clear();
          req.onSession(current.id);
          req.onCommands();
        } catch (error) { await client.close(error); throw error; }
      })().catch(error => {
        current.closed = true;
        if (this.entries.get(req.sessionKey) === current) this.entries.delete(req.sessionKey);
        throw error;
      });
    }
    await entry.ready;
  }

  commands(tabId: string): SlashCommandDto[] { return this.entries.get(tabId)?.commands ?? []; }
  config(tabId: string): AcpConfigValueDto[] { return this.entries.get(tabId)?.config ?? []; }

  async run(req: OpenRequest & { prompt: string; images: StoredChatImage[]; signal: AbortSignal; emit(event: ChatEvent): void; permission(request: PermissionRequestEvent, signal: AbortSignal): Promise<PermissionAnswer> }): Promise<void> {
    if (req.signal.aborted) throw new DOMException("ACP request cancelled", "AbortError");
    const opening = this.open(req);
    const cancelOpening = () => this.close(req.sessionKey);
    req.signal.addEventListener("abort", cancelOpening, { once: true });
    try { await opening; }
    finally { req.signal.removeEventListener("abort", cancelOpening); }
    if (req.signal.aborted) throw new DOMException("ACP request cancelled", "AbortError");
    const entry = this.entries.get(req.sessionKey)!;
    if (entry.turn) throw new Error("ACP session already has an active prompt");
    const started = Date.now();
    req.emit({ type: "session", ts: started, sessionId: entry.id!, provider: req.provider, cwd: req.cwd });
    entry.turn = { emit: req.emit, permission: req.permission, block: null };
    try {
      const result = await entry.client!.prompt({ sessionId: entry.id!, prompt: [
        { type: "text", text: req.prompt },
        ...req.images.map(image => ({ type: "image" as const, data: image.base64, mimeType: image.mime })),
      ] }, req.signal);
      req.emit({ type: "turn_result", ts: Date.now(), usageUnavailable: true, usage: { ...ZERO_USAGE }, costUsd: 0,
        durationMs: Date.now() - started, numTurns: 1, sessionId: entry.id!, modelUsage: {},
        isError: result.stopReason === "refusal", ...(result.stopReason === "refusal" ? { errorText: "ACP agent refused the request" } : {}),
      });
    } finally { entry.turn = undefined; }
  }

  close(tabId: string): void {
    const entry = this.entries.get(tabId);
    this.entries.delete(tabId);
    if (entry) { entry.closed = true; entry.startup.abort(); void entry.client?.close(); }
  }
  closeAll(): void { for (const id of this.entries.keys()) this.close(id); }

  private update(entry: Entry, notification: SessionNotification): void {
    if (entry.closed || notification.sessionId !== entry.id) return;
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      this.configUpdate(entry, update.configOptions);
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      this.setConfig(entry, entry.config.map(option => option.id === "mode" ? { ...option, value: update.currentModeId, label: update.currentModeId } : option));
      return;
    }
    const turn = entry.turn;
    if (!turn) return;
    const ts = Date.now();
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      turn.block ??= randomUUID();
      turn.emit({ type: "text_delta", ts, blockId: turn.block, text: update.content.text });
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      turn.block = null;
      turn.emit({ type: "thinking_delta", ts, text: update.content.text });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      turn.block = null;
      if (update.sessionUpdate === "tool_call" || update.rawInput !== undefined) turn.emit({ type: "tool_use", ts, toolUseId: update.toolCallId, name: update.title ?? update.kind ?? "ACP", input: update.rawInput ?? {} });
      if (update.status === "completed" || update.status === "failed") turn.emit({ type: "tool_result", ts, toolUseId: update.toolCallId, output: toolText(update.content) || (update.rawOutput == null ? "" : typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput)), isError: update.status === "failed" });
    }
  }

  private configUpdate(entry: Entry, options: SessionConfigOption[]): void {
    this.setConfig(entry, acpConfigValues(options));
  }

  private setConfig(entry: Entry, values: AcpConfigValueDto[]): void {
    const previous = new Map(entry.config.map(option => [option.id, option.value]));
    if (JSON.stringify(entry.config) === JSON.stringify(values)) return;
    entry.config = values;
    entry.onConfig();
    // 초기 설정·기록 복원은 알리지 않는다. 턴 중 실제로 바뀐 설정만 대화에도 남긴다.
    if (!entry.turn) return;
    for (const option of values) {
      if (!previous.has(option.id) || previous.get(option.id) === option.value) continue;
      entry.turn.emit({ type: "notice", ts: Date.now(), level: "notice",
        ...appMsg("session.msg.acpConfigChanged", { name: option.name, value: option.label }),
      });
    }
  }
}
