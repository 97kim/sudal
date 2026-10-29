// Antigravity CLI (`agy --output-format stream-json`) NDJSON 이벤트 → 공통 ChatEvent 매핑.
// 상태(step 별 누적 텍스트·도구 호출 여부)를 들고 턴 단위로 변환한다.

import type { ChatEvent, ModelUsageEntry, TokenUsage } from "@shared/chat-events";
import { appMsg } from "./i18n";

export interface AgyUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
}

export interface AgyToolInfoRaw {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string };
}

export interface AgyStepUpdateRaw {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  thinking_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfoRaw;
  duration_seconds?: number;
  usage?: AgyUsageRaw;
  error?: string;
}

export interface AgyResultRaw {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsageRaw;
}

export interface AgyStreamEvent {
  event?: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: AgyStepUpdateRaw;
  result?: AgyResultRaw;
}

/**
 * Antigravity 도구 이름·인자를 Sudal 의 표준 도구 카드(Read/Edit/Write/Bash/Grep/Glob/LS/WebSearch/WebFetch/Agent)로 정규화.
 * 이렇게 맞춰 두면 렌더러의 기존 도구 카드(파일 경로 클릭·명령어 표시·이모지·요약)가 그대로 동작한다.
 */
export function normalizeAgyTool(
  rawName: string,
  params: Record<string, unknown> = {},
): { name: string; input: Record<string, unknown> } {
  switch (rawName) {
    case "read_file":
    case "view_file":
      return {
        name: "Read",
        input: {
          ...params,
          file_path: params.Path ?? params.AbsolutePath ?? params.file_path ?? "",
          ...(params.StartLine !== undefined ? { offset: params.StartLine } : {}),
          ...(params.EndLine !== undefined && typeof params.StartLine === "number" && typeof params.EndLine === "number"
            ? { limit: Math.max(1, params.EndLine - params.StartLine + 1) }
            : {}),
        },
      };
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return {
        name: "Edit",
        input: {
          ...params,
          file_path: params.Path ?? params.TargetFile ?? params.file_path ?? "",
          old_string: params.Target ?? params.TargetContent ?? params.old_string ?? "",
          new_string: params.Replacement ?? params.ReplacementContent ?? params.new_string ?? "",
        },
      };
    case "write_file":
    case "write_to_file":
      return {
        name: "Write",
        input: {
          ...params,
          file_path: params.Path ?? params.TargetFile ?? params.file_path ?? "",
          content: params.Content ?? params.CodeContent ?? params.content ?? "",
        },
      };
    case "run_command":
      return {
        name: "Bash",
        input: {
          ...params,
          command: params.CommandLine ?? params.command ?? "",
          ...(typeof params.toolSummary === "string" ? { description: params.toolSummary } : {}),
        },
      };
    case "grep_search":
      return {
        name: "Grep",
        input: {
          ...params,
          pattern: params.Query ?? params.pattern ?? "",
          path: params.SearchPath ?? params.path ?? "",
        },
      };
    case "find_by_name":
      return {
        name: "Glob",
        input: {
          ...params,
          pattern: params.Pattern ?? params.pattern ?? "",
          path: params.SearchDirectory ?? params.path ?? "",
        },
      };
    case "list_dir":
      return {
        name: "LS",
        input: {
          ...params,
          path: params.DirectoryPath ?? params.path ?? "",
        },
      };
    case "search_web":
      return {
        name: "WebSearch",
        input: {
          ...params,
          query: params.query ?? "",
        },
      };
    case "read_url_content":
      return {
        name: "WebFetch",
        input: {
          ...params,
          url: params.Url ?? params.url ?? "",
        },
      };
    case "invoke_subagent":
      return {
        name: "Agent",
        input: {
          ...params,
          description: params.Role ?? params.TypeName ?? "Subagent",
          prompt: params.Prompt ?? "",
        },
      };
    case "ask_question":
      return {
        name: "AskUserQuestion",
        input: params,
      };
    default:
      return { name: rawName || "Tool", input: params };
  }
}

export function agyUsage(u: AgyUsageRaw | null | undefined): TokenUsage {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    // agy input/output 은 각각 캐시·thinking 을 이미 포함한다.
    input: Math.max(0, (u.input_tokens ?? 0) - (u.cache_read_tokens ?? 0) - (u.cache_write_tokens ?? 0)),
    output: Math.max(0, u.output_tokens ?? 0),
    cacheRead: Math.max(0, u.cache_read_tokens ?? 0),
    cacheWrite: Math.max(0, u.cache_write_tokens ?? 0),
  };
}

export class AgyEventMapper {
  private previousUsage: TokenUsage | null = null;
  private previousTurns = 0;
  private readonly stepUsage = new Map<number, TokenUsage>();
  private readonly stepTexts = new Map<number, string>();
  private readonly toolStarted = new Set<number>();
  private emittedAnyText = false;
  private sessionAnnounced = false;
  private turnSeq = 1;
  private turnId: string;

  constructor(
    private readonly opts: {
      model?: string;
      startedAt: number;
      turnId?: string;
      resumed?: boolean;
    },
  ) {
    this.turnId = opts.turnId ?? `${opts.startedAt}-1`;
  }

  /**
   * 새 턴을 시작할 때 상태와 turnId 를 갱신한다.
   * agy 프로세스가 모델·정책 변경이나 재시작으로 다시 뜨면 step_index 가 1부터 다시 시작하므로,
   * turnId 를 blockId·toolUseId 에 포함해야 이전 턴 블록을 덮어쓰지 않는다.
   */
  resetTurn(startedAt = Date.now(), turnId?: string): void {
    this.stepTexts.clear();
    this.toolStarted.clear();
    this.stepUsage.clear();
    this.emittedAnyText = false;
    this.opts.startedAt = startedAt;
    this.turnSeq += 1;
    this.turnId = turnId ?? `${startedAt}-${this.turnSeq}`;
  }

  mapLine(line: string, ts = Date.now()): { events: ChatEvent[]; turnDone: boolean } {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return { events: [], turnDone: false };
    let parsed: AgyStreamEvent;
    try {
      parsed = JSON.parse(trimmed) as AgyStreamEvent;
    } catch {
      return { events: [], turnDone: false };
    }
    return this.mapEvent(parsed, ts);
  }

  mapEvent(ev: AgyStreamEvent, ts = Date.now()): { events: ChatEvent[]; turnDone: boolean } {
    const out: ChatEvent[] = [];
    if (ev.event === "init") {
      const sessionId = ev.conversation_id;
      if (sessionId && !this.sessionAnnounced) {
        this.sessionAnnounced = true;
        out.push({
          type: "session",
          ts,
          sessionId,
          provider: "agy",
          ...(this.opts.model ? { model: this.opts.model } : {}),
          ...(ev.init?.cwd ? { cwd: ev.init.cwd } : {}),
        });
      }
      return { events: out, turnDone: false };
    }

    if (ev.event === "step_update" && ev.step_update) {
      const step = ev.step_update;
      if (step.conversation_id && !this.sessionAnnounced) {
        this.sessionAnnounced = true;
        out.push({
          type: "session",
          ts,
          sessionId: step.conversation_id,
          provider: "agy",
          ...(this.opts.model ? { model: this.opts.model } : {}),
        });
      }
      const idx = step.step_index ?? 0;
      // 같은 step 의 ACTIVE/DONE 사용량은 최신 값으로 교체한다.
      if (step.usage) this.stepUsage.set(idx, agyUsage(step.usage));
      if (step.step_type === "agent_response") {
        if (typeof step.thinking_delta === "string" && step.thinking_delta.length > 0) {
          out.push({ type: "thinking_delta", ts, text: step.thinking_delta });
        }
        const blockId = `agy-text-${this.turnId}-${idx}`;
        if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
          const prev = this.stepTexts.get(idx) ?? "";
          this.stepTexts.set(idx, prev + step.text_delta);
          this.emittedAnyText = true;
          out.push({ type: "text_delta", ts, blockId, text: step.text_delta });
        }
        if (step.state === "DONE") {
          const full = this.stepTexts.get(idx);
          if (full && full.trim().length > 0) {
            out.push({ type: "assistant_text", ts, blockId, text: full });
          }
        }
      } else if (step.step_type === "tool") {
        const rawName = step.tool_info?.name || step.tool_name || "Tool";
        const rawParams = step.tool_info?.parameters ?? {};
        const { name, input } = normalizeAgyTool(rawName, rawParams);
        const toolUseId = `agy-tool-${this.turnId}-${idx}`;
        if (!this.toolStarted.has(idx)) {
          this.toolStarted.add(idx);
          out.push({ type: "tool_use", ts, toolUseId, name, input });
        }
        if (step.state === "DONE" || step.state === "ERROR" || step.state === "FAILED") {
          const toolError = step.tool_info?.error;
          const isError = step.state === "ERROR" || step.state === "FAILED" || Boolean(step.error || toolError);
          const output = step.error || toolError?.message || toolError?.type || step.tool_info?.output || "";
          out.push({ type: "tool_result", ts, toolUseId, output, isError });
        }
      }
      return { events: out, turnDone: false };
    }

    if (ev.event === "result" && ev.result) {
      const r = ev.result;
      if (r.conversation_id && !this.sessionAnnounced) {
        this.sessionAnnounced = true;
        out.push({
          type: "session",
          ts,
          sessionId: r.conversation_id,
          provider: "agy",
          ...(this.opts.model ? { model: this.opts.model } : {}),
        });
      }
      const isError = r.status === "ERROR" || r.status === "FAILED" || Boolean(r.error);
      if (!this.emittedAnyText && typeof r.response === "string" && r.response.trim().length > 0) {
        out.push({ type: "assistant_text", ts, blockId: `agy-result-${this.turnId}-${ts}`, text: r.response });
      }
      if (isError) {
        out.push({
          type: "error",
          ts,
          ...(r.error ? { message: r.error } : appMsg("session.msg.codexTurnFailed")),
        });
      }
      // result 는 세션 누적값이다. 이전 result 를 빼서 턴마다 중복 집계하지 않는다.
      const cumulative = r.usage ? agyUsage(r.usage) : null;
      const usage = agyUsage(null);
      if (cumulative && (this.previousUsage || !this.opts.resumed)) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          usage[key] = Math.max(0, cumulative[key] - (this.previousUsage?.[key] ?? 0));
        }
      } else {
        // 재개 직후에는 이전 누적값을 모르므로 이번 턴에서 받은 step 만 집계한다.
        for (const step of this.stepUsage.values()) {
          for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[key] += step[key];
        }
      }
      if (cumulative) {
        const previous = this.previousUsage;
        this.previousUsage = { ...cumulative };
        // 입력 검증 오류의 0 카운터가 기존 기준값을 지우지 않게 한다.
        if (previous) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) this.previousUsage[key] = Math.max(previous[key], cumulative[key]);
      }
      const numTurns = r.num_turns === undefined ? 1 : this.opts.resumed && this.previousTurns === 0
        ? Math.min(1, r.num_turns) : Math.max(0, r.num_turns - this.previousTurns);
      this.previousTurns = Math.max(this.previousTurns, r.num_turns ?? this.previousTurns + numTurns);
      const durationMs = Math.max(0, ts - this.opts.startedAt);
      const modelKey = this.opts.model || "gemini-4-argon-medium";
      const modelUsage: Record<string, ModelUsageEntry> = {
        [modelKey]: { ...usage, costUsd: 0 },
      };
      out.push({
        type: "turn_result",
        ts,
        usage,
        costUsd: 0,
        durationMs,
        numTurns,
        modelUsage,
        isError,
        ...(isError && r.error ? { errorText: r.error } : {}),
      });
      return { events: out, turnDone: true };
    }

    return { events: out, turnDone: false };
  }
}
