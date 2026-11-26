// 대화 검색·내보내기 순수 함수. 이벤트 로그(threads/*.jsonl)만 입력으로 받는다.
import { Buffer } from "node:buffer";
import type { TFunction } from "i18next";
import type { ChatEvent } from "./chat-events";

export type SearchBlockKind = "user" | "assistant" | "tool";

export interface SearchHit {
  /** 일치한 블록 id — 렌더러가 그 블록으로 스크롤한다(툴은 toolUseId). */
  blockId: string;
  kind: SearchBlockKind;
  ts: number;
  /** 일치 주변 발췌(공백 정리). */
  snippet: string;
}

/** 툴 블록 하나가 검색에 기여하는 최대 글자 수(출력이 수십만 자일 수 있다). */
export const TOOL_TEXT_MAX = 20_000;

/** 텍스트 블록(사용자 메시지·어시스턴트 텍스트·툴 호출+출력)을 모은다. 스트리밍 조각은 blockId 로 합친다. */
export function collectTexts(
  events: Iterable<ChatEvent>,
): { blockId: string; kind: SearchBlockKind; ts: number; text: string }[] {
  const out: { blockId: string; kind: SearchBlockKind; ts: number; text: string }[] = [];
  const idx = new Map<string, number>();
  for (const e of events) {
    if (e.type === "user_message") {
      out.push({ blockId: e.id, kind: "user", ts: e.ts, text: e.text });
    } else if (e.type === "assistant_text" || e.type === "text_delta") {
      const i = idx.get(e.blockId);
      if (i === undefined) {
        idx.set(e.blockId, out.length);
        out.push({ blockId: e.blockId, kind: "assistant", ts: e.ts, text: e.text });
      } else if (e.type === "assistant_text") out[i].text = e.text;
      else out[i].text += e.text;
    } else if (e.type === "tool_use" && !e.partial) {
      // 툴 이름 + 입력 요약(경로·명령·패턴)이 검색 대상. 출력은 tool_result 에서 이어 붙인다.
      const key = `tool:${e.toolUseId}`;
      const head = `${e.name} ${toolLine(e.name, e.input)}`.trim();
      const i = idx.get(key);
      if (i === undefined) {
        idx.set(key, out.length);
        out.push({ blockId: e.toolUseId, kind: "tool", ts: e.ts, text: head });
      } else out[i].text = head + out[i].text.slice(out[i].text.indexOf("\n"));
    } else if (e.type === "tool_result") {
      const key = `tool:${e.toolUseId}`;
      const i = idx.get(key);
      const body = `\n${copiedHead(e.output, TOOL_TEXT_MAX)}`;
      if (i === undefined) {
        idx.set(key, out.length);
        out.push({ blockId: e.toolUseId, kind: "tool", ts: e.ts, text: `tool${body}` });
      } else out[i].text = out[i].text.split("\n")[0] + body;
    }
  }
  return out;
}

export function makeSnippet(text: string, at: number, len: number, radius = 60): string {
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + len + radius);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

export interface IndexedBlock {
  blockId: string;
  kind: SearchBlockKind;
  ts: number;
  text: string;
  /** 검색용 소문자 사본 — 검색마다 toLowerCase 하지 않게 인덱스에 미리 둔다. */
  lower: string;
}

export function indexBlocks(events: Iterable<ChatEvent>): IndexedBlock[] {
  return collectTexts(events).map((b) => ({ ...b, lower: b.text.toLowerCase() }));
}

/** 대소문자 무시 부분 일치. 블록당 첫 일치만. query 는 이미 trim·소문자. */
export function searchBlocks(blocks: IndexedBlock[], q: string, limit = 50): SearchHit[] {
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const b of blocks) {
    const at = b.lower.indexOf(q);
    if (at === -1) continue;
    hits.push({ blockId: b.blockId, kind: b.kind, ts: b.ts, snippet: makeSnippet(b.text, at, q.length) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 대소문자 무시 부분 일치. 블록당 첫 일치만. */
export function searchEvents(events: Iterable<ChatEvent>, query: string, limit = 50): SearchHit[] {
  return searchBlocks(indexBlocks(events), query.trim().toLowerCase(), limit);
}

export interface ExportMeta {
  title: string;
  workspace?: string | null;
  provider: string;
  cwd?: string | null;
  exportedAt: number;
  /** 시각 표시에 쓰는 Intl 로케일 태그(없으면 ko-KR). */
  locale?: string;
}

const TOOL_OUTPUT_MAX = 1500;

// An ordinary slice can retain the entire original V8 string, which defeats
// keeping only a preview after a large event has been consumed. UTF-16 keeps
// the same JS lengths and even lone surrogates at a truncation boundary.
function copiedHead(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return Buffer.from(value.slice(0, limit), "utf16le").toString("utf16le");
}

function firstLine(value: string): string {
  const newline = value.indexOf("\n");
  return newline < 0 ? value : copiedHead(value, newline);
}

function timeOf(ts: number, locale?: string): string {
  return new Date(ts).toLocaleString(locale, { hour12: false });
}

function toolLine(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const detail =
    str(i.description) ||
    firstLine(str(i.command)) ||
    str(i.file_path) ||
    str(i.notebook_path) ||
    str(i.pattern) ||
    str(i.url) ||
    "";
  return detail ? `${name} — ${detail}` : name;
}

/** 이벤트 로그를 읽기 좋은 마크다운으로. 툴 출력은 길면 자른다. */
export function eventsToMarkdown(t: TFunction, events: Iterable<ChatEvent>, meta: ExportMeta): string {
  const lines: string[] = [`# ${meta.title}`, ""];
  const head = [
    meta.workspace ? `${t("repo.export.workspace")}: ${meta.workspace}` : null,
    `provider: ${meta.provider}`,
    meta.cwd ? `${t("repo.export.path")}: ${meta.cwd}` : null,
    `${t("repo.export.exportedAt")}: ${timeOf(meta.exportedAt, meta.locale)}`,
  ].filter(Boolean);
  lines.push(head.map((h) => `- ${h}`).join("\n"), "", "---", "");

  const textBlocks = new Map<string, string>();
  const order: { kind: "user" | "assistant" | "tool" | "turn" | "error"; ref: string; ts: number }[] = [];
  const tools = new Map<string, { line: string; output?: string; omitted?: number; isError?: boolean }>();
  const turns = new Map<string, string>();
  let lastRole: "user" | "assistant" | null = null;

  for (const e of events) {
    switch (e.type) {
      case "user_message":
        order.push({ kind: "user", ref: e.text, ts: e.ts });
        break;
      case "text_delta":
        if (!textBlocks.has(e.blockId)) order.push({ kind: "assistant", ref: e.blockId, ts: e.ts });
        textBlocks.set(e.blockId, (textBlocks.get(e.blockId) ?? "") + e.text);
        break;
      case "assistant_text":
        if (!textBlocks.has(e.blockId)) order.push({ kind: "assistant", ref: e.blockId, ts: e.ts });
        textBlocks.set(e.blockId, e.text);
        break;
      case "tool_use":
        if (!tools.has(e.toolUseId)) order.push({ kind: "tool", ref: e.toolUseId, ts: e.ts });
        tools.set(e.toolUseId, { ...tools.get(e.toolUseId), line: toolLine(e.name, e.input) });
        break;
      case "tool_result": {
        const prev = tools.get(e.toolUseId);
        const hasOutput = /\S/.test(e.output);
        tools.set(e.toolUseId, {
          line: prev?.line ?? "tool",
          output: hasOutput ? copiedHead(e.output, TOOL_OUTPUT_MAX) : undefined,
          omitted: hasOutput ? Math.max(0, e.output.length - TOOL_OUTPUT_MAX) : 0,
          isError: e.isError,
        });
        if (!prev)
          order.push({ kind: "tool", ref: e.toolUseId, ts: e.ts });
        break;
      }
      case "turn_result": {
        const key = `${e.ts}-${order.length}`;
        const stat = `${(e.durationMs / 1000).toFixed(1)}s · in ${e.usage.input} / out ${e.usage.output}${
          e.costUsd > 0 ? ` · $${e.costUsd.toFixed(4)}` : ""
        }${e.isError ? ` · ${t("repo.export.failedTurn")}${e.errorText ? `: ${e.errorText}` : ""}` : ""}`;
        turns.set(key, stat);
        order.push({ kind: "turn", ref: key, ts: e.ts });
        break;
      }
      case "error":
        order.push({ kind: "error", ref: e.message, ts: e.ts });
        break;
      default:
        break;
    }
  }

  for (const o of order) {
    switch (o.kind) {
      case "user":
        lines.push(`## ${t("repo.export.user")} · ${timeOf(o.ts, meta.locale)}`, "", o.ref, "");
        lastRole = "user";
        break;
      case "assistant": {
        const text = (textBlocks.get(o.ref) ?? "").trim();
        if (!text) break;
        if (lastRole !== "assistant") lines.push(`## ${meta.provider}`, "");
        lines.push(text, "");
        lastRole = "assistant";
        break;
      }
      case "tool": {
        const tool = tools.get(o.ref);
        if (!tool) break;
        if (lastRole !== "assistant") {
          lines.push(`## ${meta.provider}`, "");
          lastRole = "assistant";
        }
        lines.push(`> 🔧 ${tool.line}${tool.isError ? ` (${t("repo.export.toolError")})` : ""}`);
        if (tool.output) {
          const out = tool.omitted ? `${tool.output}\n${t("repo.export.truncated", { count: tool.omitted })}` : tool.output;
          lines.push("", "```", out.replace(/```/g, "'''"), "```");
        }
        lines.push("");
        break;
      }
      case "turn":
        lines.push(`_${turns.get(o.ref) ?? ""}_`, "");
        lastRole = null;
        break;
      case "error":
        lines.push(`> ⚠️ ${o.ref}`, "");
        break;
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 파일명에 쓸 수 있게 제목을 다듬는다. */
export function exportFileName(title: string, ts: number): string {
  const safe = title.replace(/[\\/:*?"<>|\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "session";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${safe} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
}
