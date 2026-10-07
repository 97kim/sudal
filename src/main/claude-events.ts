// Claude Agent SDK 메시지 → 공통 ChatEvent 매핑. 부수효과 없는 상태 머신이라 단위 테스트 가능.
//
// includePartialMessages:true 로 돌리면 stream_event(토큰 단위)와 최종 assistant 메시지가
// 둘 다 온다. 스트림에서 본 message id 는 기억해 두고, 같은 id 의 최종 assistant 메시지는
// 버린다(dedupe). 스트림이 없던 메시지(파셜 미지원 등)만 최종 메시지로 블록을 만든다.

import type { ChatEvent } from "@shared/chat-events";
import type { Msg, MsgKey } from "@shared/i18n/msg";
import { appMsg } from "./i18n";
import { aiReviewNotice } from "./ai-review";
import type { ProviderRateLimitDto, RateLimitWindowDto } from "@shared/ipc";

type SDKMessage = import("@anthropic-ai/claude-agent-sdk").SDKMessage;

interface StreamBlock {
  kind: "text" | "tool_use" | "thinking" | "other";
  blockId: string;
  toolUseId?: string;
  name?: string;
  json: string;
  /** 마지막으로 흘린 미리보기(JSON 문자열). 같으면 다시 보내지 않는다. */
  previewKey?: string;
}

/** 기억해 둘 툴 호출 id 수. 긴 대화에서 무한정 늘지 않게. */
const EMITTED_TOOLS_MAX = 2000;

export class ClaudeEventMapper {
  private messageId: string | null = null;
  private readonly seenStreamMessages = new Set<string>();
  /**
   * 스트림으로 이미 완성해 내보낸 툴 호출. 메시지 단위로 "봤다" 를 판단하면,
   * 스트림이 중간에 끊겨 블록 이벤트가 안 온 호출은 완성 메시지에서도 건너뛰어 영영 사라진다
   * (결과만 남아 이름 없는 카드가 된다). 블록 단위로 본다.
   */
  private readonly emittedTools = new Set<string>();
  /** 메인 루프의 마지막 assistant 메시지가 든 입력 컨텍스트 크기. result 의 usage 는 턴 누적치라 따로 든다. */
  private lastContextTokens: number | null = null;
  /**
   * 이 턴에서 본 마지막 최상위 체인 항목(assistant, 또는 도구 결과를 담은 user)의 uuid. 턴 끝의 분기 지점이다.
   * 서브에이전트 메시지(parent_tool_use_id)는 본 세션 체인이 아니라 뺀다. 결과를 낸 뒤 비운다(예열 매퍼는 여러 턴을 산다).
   */
  private lastChainUuid: string | null = null;
  private readonly blocks = new Map<number, StreamBlock>();
  private counter = 0;
  /** 텍스트로 이미 내보낸 진행 설명(thinking 블록). 스트림과 완성 메시지에서 두 번 내지 않게 "메시지 id\n내용" 으로 본다. */
  private readonly emittedNotes = new Set<string>();

  /**
   * progressNotes: thinking 블록에 담겨 오는 도구 사이 진행 설명을 채팅 텍스트로 남긴다. Claude Code 는 기본으로
   * thinking 을 display "updates" 로 요청해, 한두 문장을 넘는 진행 설명이 text 대신 thinking 블록으로 온다(Opus 5.5·Fable 5.1).
   * 그대로 두면 "생각 중" 꼬리로만 잠깐 보이고 기록에 남지 않는다. 사용자가 showThinkingSummaries 를 켜면 같은 블록에
   * 추론 요약이 담기므로 그때는 끈다(호출자가 판단).
   */
  constructor(private readonly opts: { progressNotes?: boolean } = {}) {}

  map(msg: SDKMessage, ts: number): ChatEvent[] {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          return [
            {
              type: "session",
              ts,
              sessionId: msg.session_id,
              provider: "claude",
              model: msg.model,
              cwd: msg.cwd,
            },
            ...pluginErrorNotice((msg as { plugin_errors?: unknown }).plugin_errors, ts),
          ];
        }
        // /usage, /help 같은 로컬 슬래시 커맨드 출력은 모델을 거치지 않고 텍스트로만 온다.
        if (msg.subtype === "local_command_output") {
          const text = msg.content.trim();
          return text
            ? [
                {
                  type: "assistant_text",
                  ts,
                  blockId: `local:${msg.uuid}`,
                  text,
                },
              ]
            : [];
        }
        // 턴 도중의 안내·경고(0.3.283+). info 는 CLI 도 기록 보기에서만 보여 주는 것이라 버린다.
        if (msg.subtype === "informational") {
          const m = msg as { content?: unknown; level?: unknown; tool_use_id?: unknown };
          const text = typeof m.content === "string" ? m.content.trim() : "";
          const level = m.level === "notice" || m.level === "suggestion" || m.level === "warning" ? m.level : null;
          if (!text || !level) return [];
          return [{ type: "notice", ts, message: text, level, ...(typeof m.tool_use_id === "string" ? { key: m.tool_use_id } : {}) }];
        }
        // auto 모드(권한 "AI 판단으로 승인")에서 분류기가 거절했다. 규칙·모드로 거절된 것은 도구 결과에 이미 나오므로
        // 분류기가 정한 것만 "AI 가 거절" 로 보여 준다. 하위 에이전트 안의 거절도 같다(그 도구 카드는 없지만 이유는 알 만하다).
        if (msg.subtype === "permission_denied") {
          const m = msg as { tool_name?: unknown; tool_use_id?: unknown; decision_reason_type?: unknown; decision_reason?: unknown; message?: unknown };
          if (m.decision_reason_type !== "classifier" || typeof m.tool_use_id !== "string") return [];
          const reason = typeof m.decision_reason === "string" ? m.decision_reason : typeof m.message === "string" ? m.message : null;
          return [aiReviewNotice({ key: m.tool_use_id, ts, outcome: "denied", action: typeof m.tool_name === "string" ? m.tool_name : "?", reason })];
        }
        return [];
      case "stream_event":
        if (msg.parent_tool_use_id) return []; // 서브에이전트 스트림은 노출하지 않는다
        return this.mapStreamEvent(msg.event, ts);
      case "assistant":
      case "user":
        if (!msg.parent_tool_use_id && typeof msg.uuid === "string" && msg.uuid) this.lastChainUuid = msg.uuid;
        return msg.type === "assistant" ? this.mapAssistant(msg, ts) : this.mapUser(msg, ts);
      case "result": {
        const ev = this.mapResult(msg, ts);
        this.lastChainUuid = null;
        return [ev];
      }
      default:
        return [];
    }
  }

  private mapStreamEvent(
    event: { type: string; [k: string]: unknown },
    ts: number,
  ): ChatEvent[] {
    switch (event.type) {
      case "message_start": {
        const id =
          (event.message as { id?: string } | undefined)?.id ??
          `m${++this.counter}`;
        this.messageId = id;
        this.seenStreamMessages.add(id);
        this.blocks.clear();
        return [];
      }
      case "content_block_start": {
        const index = event.index as number;
        const cb = event.content_block as {
          type: string;
          id?: string;
          name?: string;
        };
        const blockId = `${this.messageId ?? "m"}:${index}`;
        if (cb.type === "text") {
          this.blocks.set(index, { kind: "text", blockId, json: "" });
          return [];
        }
        if (cb.type === "thinking") {
          this.blocks.set(index, { kind: "thinking", blockId, json: "" });
          return [];
        }
        if (cb.type === "tool_use") {
          const toolUseId = cb.id ?? blockId;
          this.blocks.set(index, {
            kind: "tool_use",
            blockId,
            toolUseId,
            name: cb.name ?? "tool",
            json: "",
          });
          return [
            {
              type: "tool_use",
              ts,
              toolUseId,
              name: cb.name ?? "tool",
              input: {},
              partial: true,
            },
          ];
        }
        this.blocks.set(index, { kind: "other", blockId, json: "" });
        return [];
      }
      case "content_block_delta": {
        const block = this.blocks.get(event.index as number);
        if (!block) return [];
        const delta = event.delta as {
          type: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
        };
        if (
          block.kind === "text" &&
          delta.type === "text_delta" &&
          delta.text
        ) {
          return [
            {
              type: "text_delta",
              ts,
              blockId: block.blockId,
              text: delta.text,
            },
          ];
        }
        if (block.kind === "tool_use" && delta.type === "input_json_delta") {
          block.json += delta.partial_json ?? "";
          // 명령·경로가 만들어지는 대로 카드에 보이게 — 뽑힌 값이 바뀌었을 때만 흘린다
          const preview = previewToolInput(block.json);
          const key = JSON.stringify(preview);
          if (key !== block.previewKey && Object.keys(preview).length > 0) {
            block.previewKey = key;
            return [{ type: "tool_use", ts, toolUseId: block.toolUseId!, name: block.name!, input: preview, partial: true, preview: true }];
          }
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          if (block.kind === "thinking") block.json += delta.thinking;
          return [{ type: "thinking_delta", ts, text: delta.thinking }];
        }
        return [];
      }
      case "content_block_stop": {
        const block = this.blocks.get(event.index as number);
        if (block?.kind === "thinking") return this.noteEvent(block.blockId, block.json, ts);
        if (!block || block.kind !== "tool_use") return [];
        this.emittedTools.add(block.toolUseId!);
        if (this.emittedTools.size > EMITTED_TOOLS_MAX) this.emittedTools.delete(this.emittedTools.values().next().value as string);
        return [
          {
            type: "tool_use",
            ts,
            toolUseId: block.toolUseId!,
            name: block.name!,
            input: parseJsonLoose(block.json),
          },
        ];
      }
      default:
        return [];
    }
  }

  private mapAssistant(
    msg: Extract<SDKMessage, { type: "assistant" }>,
    ts: number,
  ): ChatEvent[] {
    const events: ChatEvent[] = [];
    if (msg.error) {
      events.push({
        type: "error",
        ts,
        message: describeAssistantError(msg.error),
      });
    }
    if (msg.parent_tool_use_id) return [...events, ...subagentActivity(msg.parent_tool_use_id, msg.message.content, ts)];
    const mu = (msg.message as { usage?: Partial<Record<string, number>> }).usage;
    if (mu)
      this.lastContextTokens =
        (mu.input_tokens ?? 0) + (mu.cache_read_input_tokens ?? 0) + (mu.cache_creation_input_tokens ?? 0);
    // 스트림으로 흘린 메시지라도 블록 하나하나는 다시 본다 — 흘리지 못한 블록이 있으면 여기서 메운다.
    const streamed = this.seenStreamMessages.has(msg.message.id);
    const raw: unknown = msg.message.content;
    const content: unknown[] = Array.isArray(raw) ? raw : [];
    content.forEach((block: unknown, i: number) => {
      const b = block as {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      const blockId = `${msg.message.id}:${i}`;
      if (b.type === "text" && typeof b.text === "string") {
        if (streamed) return; // 글자는 delta 로 이미 흘렀다
        events.push({ type: "assistant_text", ts, blockId, text: b.text });
      } else if (b.type === "thinking") {
        // 스트림이 끊겨 블록 끝을 못 봤어도 여기서 메운다(블록 단위로 이미 냈는지 본다)
        events.push(...this.noteEvent(blockId, (b as { thinking?: unknown }).thinking, ts));
      } else if (b.type === "tool_use") {
        const toolUseId = b.id ?? blockId;
        if (this.emittedTools.has(toolUseId)) return; // 스트림으로 이미 완성해 냈다
        this.emittedTools.add(toolUseId);
        events.push({
          type: "tool_use",
          ts,
          toolUseId,
          name: b.name ?? "tool",
          input: b.input ?? {},
        });
      }
    });
    return events;
  }

  /**
   * 진행 설명 하나를 채팅 텍스트로. 꺼져 있거나 비었거나 이미 냈으면 없다.
   * "이미 냈나" 는 블록 순번이 아니라 메시지 id + 내용으로 본다 — CLI 는 완성 메시지를 블록마다 따로 쪼개 보내서
   * 스트림의 순번(msg:1)과 쪼갠 메시지 안의 순번(msg:0)이 다르다.
   */
  private noteEvent(blockId: string, text: unknown, ts: number): ChatEvent[] {
    if (!this.opts.progressNotes || typeof text !== "string" || !text.trim()) return [];
    const note = text.trim();
    const key = `${blockId.slice(0, blockId.lastIndexOf(":"))}\n${note}`;
    if (this.emittedNotes.has(key)) return [];
    this.emittedNotes.add(key);
    if (this.emittedNotes.size > EMITTED_TOOLS_MAX) this.emittedNotes.delete(this.emittedNotes.values().next().value as string);
    return [{ type: "assistant_text", ts, blockId, text: note }];
  }

  private mapUser(
    msg: Extract<SDKMessage, { type: "user" }>,
    ts: number,
  ): ChatEvent[] {
    if (msg.parent_tool_use_id) return [];
    const content = msg.message.content;
    if (!Array.isArray(content)) return [];
    const events: ChatEvent[] = [];
    for (const block of content) {
      const b = block as {
        type: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      events.push({
        type: "tool_result",
        ts,
        toolUseId: b.tool_use_id,
        output: toolResultText(b.content),
        isError: b.is_error === true,
      });
    }
    return events;
  }

  private mapResult(
    msg: Extract<SDKMessage, { type: "result" }>,
    ts: number,
  ): ChatEvent {
    const u = msg.usage as Partial<Record<string, number>>;
    const modelUsage: Record<
      string,
      import("@shared/chat-events").ModelUsageEntry
    > = {};
    for (const [model, mu] of Object.entries(msg.modelUsage ?? {})) {
      modelUsage[model] = {
        input: mu.inputTokens ?? 0,
        output: mu.outputTokens ?? 0,
        cacheRead: mu.cacheReadInputTokens ?? 0,
        cacheWrite: mu.cacheCreationInputTokens ?? 0,
        costUsd: mu.costUSD ?? 0,
        contextWindow: mu.contextWindow || undefined,
      };
    }
    const isError = msg.is_error || msg.subtype !== "success";
    let errorText: string | undefined;
    let errorMsg: Msg | undefined;
    if (msg.subtype !== "success") {
      const key = RESULT_ERROR_KEY[msg.subtype];
      if (key) ({ message: errorText, msg: errorMsg } = appMsg(key));
      else errorText = msg.subtype;
    } else if (msg.is_error) errorText = msg.result;
    return {
      type: "turn_result",
      ts,
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      ...(this.lastContextTokens !== null ? { contextTokens: this.lastContextTokens } : {}),
      costUsd: msg.total_cost_usd ?? 0,
      durationMs: msg.duration_ms ?? 0,
      numTurns: msg.num_turns ?? 0,
      sessionId: msg.session_id,
      modelUsage,
      isError,
      errorText,
      ...(errorMsg ? { errorMsg } : {}),
      // 정상으로 끝난 일반 턴만. 중단·오류·압축만 한 턴(체인 항목 없음)은 분기 지점이 없다.
      ...(!isError && this.lastChainUuid && msg.session_id
        ? { forkPoint: { provider: "claude" as const, sessionId: msg.session_id, pointId: this.lastChainUuid } }
        : {}),
    };
  }
}

const RESULT_ERROR_KEY: Record<string, MsgKey> = {
  error_during_execution: "session.msg.result.duringExecution",
  error_max_turns: "session.msg.result.maxTurns",
  error_max_budget_usd: "session.msg.result.maxBudget",
  error_max_structured_output_retries: "session.msg.result.structuredRetries",
};

function describeAssistantError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as { message?: string; type?: string };
    return e.message || e.type || JSON.stringify(error);
  }
  return String(error);
}

/**
 * rate_limit_event 의 rate_limit_info → 구독 한도. unifiedWindows(5시간/주간/모델별 주간, utilization 0~1) 가 있으면
 * 그걸 쓰고, 없으면 최상위 rateLimitType/utilization 하나만 채운다. SDK 타입에 unifiedWindows 가 없어 느슨하게 읽는다.
 * seven_day_overage_included 는 CLI 가 "Fable limit" 으로 부르는 모델별 주간 창(/usage 의 "Current week (Fable)").
 */
export function parseClaudeRateLimit(
  info: unknown,
  observedAt: number,
): ProviderRateLimitDto | null {
  const i = info as Record<string, unknown> | null | undefined;
  if (!i || typeof i !== "object") return null;
  const windows = i.unifiedWindows as Record<string, unknown> | undefined;
  let session = claudeWindow(windows?.five_hour, 300);
  let weekly = claudeWindow(windows?.seven_day, 10_080);
  const modelBucket = claudeWindow(windows?.seven_day_overage_included, 10_080);
  let modelWeekly = modelBucket
    ? { ...modelBucket, label: MODEL_WINDOW_LABEL.seven_day_overage_included }
    : null;
  const rejected = i.status === "rejected" && typeof i.resetsAt === "number" ? i.resetsAt : undefined;
  if (!session && !weekly && !modelWeekly) {
    const type = typeof i.rateLimitType === "string" ? i.rateLimitType : "";
    // 거절된 창은 utilization 이 없어도 다 쓴 것이다. 그 창을 100% 로 채워 목록에서 사라지지 않게 한다.
    const single = claudeWindow(
      { utilization: rejected ? 1 : i.utilization, resetsAt: i.resetsAt },
      type === "five_hour" ? 300 : 10_080,
    );
    if (type === "five_hour") session = single;
    else if (type in MODEL_WINDOW_LABEL)
      modelWeekly = single && { ...single, label: MODEL_WINDOW_LABEL[type] };
    else if (type.startsWith("seven_day")) weekly = single;
  }
  if (!session && !weekly && !modelWeekly) {
    // 창 정보 없이 거절만 온 경우에도 재시도 예약은 할 수 있어야 한다.
    return rejected ? { session: null, weekly: null, modelWeekly: null, observedAt, rejectedResetsAt: rejected } : null;
  }
  return { session, weekly, modelWeekly, observedAt, ...(rejected ? { rejectedResetsAt: rejected } : {}) };
}

/**
 * rate_limit_event 는 그 순간 알려 준 창만 담는다(거절 이벤트는 걸린 창 하나뿐). 그대로 저장하면 나머지 창이
 * 화면에서 사라지므로, 새 값에 없는 창은 이전 관측값을 유지한다. 새 값이 없으면 이전 값을 그대로 돌려준다.
 */
export function mergeRateLimit(
  prev: ProviderRateLimitDto | null | undefined,
  next: ProviderRateLimitDto | null,
): ProviderRateLimitDto | null {
  if (!next) return prev ?? null;
  if (!prev) return next;
  return {
    ...next,
    session: next.session ?? prev.session,
    weekly: next.weekly ?? prev.weekly,
    modelWeekly: next.modelWeekly ?? prev.modelWeekly,
  };
}

/**
 * `/usage` 로컬 커맨드 출력 텍스트 → 구독 한도. 모델 호출 없이(비용 0) 현재 값을 얻는 유일한 통로라 새로고침에 쓴다.
 *   Current session: 3% used · resets Sep 4 at 11:10pm (Asia/Seoul)
 *   Current week (all models): 25% used · resets Sep 9 at 8pm (Asia/Seoul)
 *   Current week (Fable): 37% used · resets Sep 9 at 8pm (Asia/Seoul)
 * 초기화 시각은 CLI 가 이 PC 의 시간대로 찍으므로 로컬 시간으로 해석한다. 못 읽으면 resetsAt=0 (화면에서 생략).
 */
export function parseUsageText(
  text: string,
  now: number,
): ProviderRateLimitDto | null {
  let session: RateLimitWindowDto | null = null;
  let weekly: RateLimitWindowDto | null = null;
  let modelWeekly: (RateLimitWindowDto & { label: string }) | null = null;
  const re =
    /^Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+?))?\s*$/;
  for (const raw of text.split("\n")) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const [, kind, scope, pct, resets] = m;
    const w: RateLimitWindowDto = {
      usedPercent: Number(pct),
      windowMinutes: kind === "session" ? 300 : 10_080,
      resetsAt: resets ? parseResetTime(resets, now) : 0,
    };
    if (kind === "session") session = w;
    else if (!scope || /all models/i.test(scope)) weekly = w;
    else modelWeekly = { ...w, label: scope.replace(/\s+only$/i, "").trim() };
  }
  if (!session && !weekly && !modelWeekly) return null;
  return { session, weekly, modelWeekly, observedAt: now };
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** "Sep 4 at 11:10pm (Asia/Seoul)" → epoch 초. 연도는 now 기준, 이미 하루 넘게 지났으면 다음 해. 실패하면 0. */
export function parseResetTime(s: string, now: number): number {
  const m =
    /^([A-Za-z]{3})\w*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(
      s.trim(),
    );
  if (!m) return 0;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return 0;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const d = new Date(now);
  d.setMonth(month, Number(m[2]));
  d.setHours(hour, Number(m[4] ?? 0), 0, 0);
  if (d.getTime() < now - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}

/** 모델 한정 주간 창의 rateLimitType → 표시명 (CLI 의 limit 이름과 맞춤). */
const MODEL_WINDOW_LABEL: Record<string, string> = {
  seven_day_overage_included: "Fable",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
};

function claudeWindow(
  raw: unknown,
  windowMinutes: number,
): RateLimitWindowDto | null {
  const w = raw as Record<string, unknown> | null | undefined;
  if (!w || typeof w.utilization !== "number" || typeof w.resetsAt !== "number")
    return null;
  return {
    usedPercent: Math.max(0, Math.min(100, w.utilization * 100)),
    windowMinutes,
    resetsAt: w.resetsAt,
  };
}

export function parseJsonLoose(json: string): unknown {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { _raw: trimmed };
  }
}

/** tool_result content(string | block[]) 를 표시용 문자열로. 이미지는 placeholder. */
export function toolResultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string };
        if (b.type === "text") return b.text ?? "";
        if (b.type === "image") return "[image]";
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * 스트리밍 중인(아직 닫히지 않은) 툴 입력 JSON 에서 문자열 필드만 뽑는다: {"command":"cd ~ && ls -la /Us → { command: "cd ~ && ls -la /Us" }.
 * 정확한 파서가 아니라 `"키": "값…` 모양을 정규식으로 찾는 것이라, 문자열 안에 든 따옴표는 이스케이프(\") 로만 구분한다.
 * 끝이 잘린 이스케이프(\ 하나로 끝남)는 떼어 낸다. 값이 없는 키·문자열이 아닌 값은 뺀다.
 */
export function previewToolInput(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"([A-Za-z_][\w-]*)"\s*:\s*"((?:[^"\\]|\\.)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json))) {
    let raw = m[2];
    if (raw.endsWith("\\")) raw = raw.slice(0, -1);
    try {
      out[m[1]] = JSON.parse(`"${raw}"`) as string;
    } catch {
      out[m[1]] = raw;
    }
  }
  return out;
}

/** 하위 에이전트의 assistant 메시지에서 도구 호출과 말을 뽑아 카드에 흘릴 활동 이벤트로. 입력은 문자열 필드만 200자로 잘라 보낸다. */
export function subagentActivity(parentToolUseId: string, content: unknown, ts: number): ChatEvent[] {
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  const out: ChatEvent[] = [];
  for (const raw of blocks) {
    const b = raw as { type: string; name?: string; input?: unknown; text?: string };
    if (b.type === "tool_use") {
      const input: Record<string, string> = {};
      const src = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
      for (const [k, v] of Object.entries(src)) if (typeof v === "string") input[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
      out.push({ type: "subagent_activity", ts, parentToolUseId, tool: b.name ?? "tool", input });
    } else if (b.type === "text" && typeof b.text === "string") {
      const line = b.text.trim().split("\n").filter(Boolean).pop() ?? "";
      if (line) out.push({ type: "subagent_activity", ts, parentToolUseId, text: line.length > 160 ? line.slice(0, 160) + "…" : line });
    }
  }
  return out;
}

/**
 * 세션 시작 때 불러오지 못한 플러그인(SDK 0.3.283+ plugin_errors). 조용히 빠진 플러그인은 명령·훅이 왜 없는지
 * 알 길이 없어 경고 한 줄로 알린다. 시작 메시지는 프로세스가 다시 뜰 때마다 오므로 key 를 고정해 한 줄로 둔다.
 */
function pluginErrorNotice(raw: unknown, ts: number): ChatEvent[] {
  if (!Array.isArray(raw)) return [];
  const items = raw
    .map((e) => {
      const o = (e ?? {}) as { plugin?: unknown; message?: unknown };
      const name = typeof o.plugin === "string" ? o.plugin : "";
      const message = typeof o.message === "string" ? o.message.trim() : "";
      return name ? `${name}${message ? ` (${message})` : ""}` : "";
    })
    .filter(Boolean);
  if (items.length === 0) return [];
  const shown = items.slice(0, 3).join(", ");
  const more = items.length - 3;
  const note =
    more > 0
      ? appMsg("session.msg.pluginErrors.more", { total: items.length, shown, more })
      : appMsg("session.msg.pluginErrors.all", { count: items.length, shown });
  return [{ type: "notice", ts, level: "warning", key: "plugin-errors", ...note }];
}
