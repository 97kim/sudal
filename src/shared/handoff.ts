// provider 전환 시 이전 대화를 새 provider 의 첫 메시지로 넘기기 위한 요약. 순수 함수.
// Codex 는 Claude 세션을 이어받을 수 없으므로(그 반대도), 이벤트 로그를 텍스트로 압축해 전달한다.

import type { TFunction } from "i18next";
import type { ChatEvent } from "./chat-events";
import { joinAny, samePath } from "./any-path";

export interface HandoffStats {
  /** 사용자 메시지 + 완료된 어시스턴트 턴 수. */
  messages: number;
  /** 툴 입력에서 본 파일 경로(중복 제거). */
  files: number;
  /** 마지막 할 일 목록에서 완료되지 않은 항목 수. */
  pendingTasks: number;
  /** 요약 텍스트의 대략적 토큰 수 (문자 수 / 3). */
  tokensEstimate: number;
}

export interface Handoff {
  summary: string;
  stats: HandoffStats;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 토큰 수 어림. 영어는 4글자에 1토큰쯤이지만 한글·CJK 는 글자당 1토큰에 가깝다 —
 * 한 비율로 뭉뚱그리면 한국어 대화에서 몇 배씩 어긋난다. 정확한 값이 아니라 자릿수만 맞추는 용도.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x2e00) cjk += 1;
  }
  return Math.round(cjk + (text.length - cjk) / 4);
}
const clip = (t: TFunction, s: string, n: number) => (s.length > n ? `${s.slice(0, n)}${t("promptDoc.handoff.clipped")}` : s);

export function extractFilePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const i = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "notebook_path", "path"]) if (str(i[k])) out.push(str(i[k]));
  if (Array.isArray(i.changes)) {
    for (const c of i.changes as { path?: unknown }[]) if (str(c?.path)) out.push(str(c.path));
  }
  return out;
}

/** Claude TodoWrite({todos:[{content,status}]}) 와 Codex todo_list({items:[{text,completed}]}) 모두 처리. */
export function pendingTodos(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const i = input as { todos?: unknown; items?: unknown };
  const out: string[] = [];
  if (Array.isArray(i.todos)) {
    for (const t of i.todos as { content?: unknown; status?: unknown }[]) {
      if (t?.status !== "completed" && str(t?.content)) out.push(str(t.content));
    }
  }
  if (Array.isArray(i.items)) {
    for (const t of i.items as { text?: unknown; completed?: unknown }[]) {
      if (t?.completed !== true && str(t?.text)) out.push(str(t.text));
    }
  }
  return out;
}

/** 성공한 툴 결과를 몇 개까지 남길지. 오래된 출력은 다시 볼 일이 없다. */
const RECENT_RESULTS = 12;

export function buildHandoff(
  t: TFunction,
  events: ChatEvent[],
  opts: { cwd?: string | null; fromProvider?: string; maxChars?: number } = {},
): Handoff {
  const maxChars = opts.maxChars ?? 24000;
  // 기록을 만드는 시점의 앱 언어로 머리말을 만든다. 단락 판별은 이 호출 안에서만 한다.
  const assistantHeading = t("promptDoc.handoff.heading.assistant");
  const lines: string[] = [];
  const files = new Set<string>();
  let messages = 0;
  let lastTodoInput: unknown = null;
  const textBlocks = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const results: string[] = [];
  let firstUserMessage = "";

  for (const e of events) {
    switch (e.type) {
      case "user_message":
        messages += 1;
        if (!firstUserMessage) firstUserMessage = e.text.trim();
        lines.push(`${t("promptDoc.handoff.heading.user")}\n${clip(t, e.text, 1200)}`);
        break;
      case "text_delta":
        textBlocks.set(e.blockId, (textBlocks.get(e.blockId) ?? "") + e.text);
        lines.push(` text:${e.blockId}`);
        break;
      case "assistant_text":
        textBlocks.set(e.blockId, e.text);
        lines.push(` text:${e.blockId}`);
        break;
      case "tool_use": {
        if (e.partial) break;
        for (const p of extractFilePaths(e.input)) files.add(p);
        if (e.name === "TodoWrite") lastTodoInput = e.input;
        if (toolNames.has(e.toolUseId)) break;
        toolNames.set(e.toolUseId, e.name);
        lines.push(t("promptDoc.handoff.tool", { name: e.name, summary: clip(t, toolOneLiner(t, e.name, e.input), 160) }));
        break;
      }
      case "tool_result": {
        // 실패는 다 남긴다(같은 실수를 되풀이하지 않게). 성공 결과는 최근 것만 —
        // 오래된 툴 출력은 다시 볼 일이 없고 자리만 차지한다.
        const out = clip(t, e.output.replace(/\s+/g, " "), e.isError ? 160 : 300);
        if (!out) break;
        if (e.isError) lines.push(t("promptDoc.handoff.failed", { output: out }));
        else {
          results.push(out);
          lines.push(` result:${results.length - 1}`);
        }
        break;
      }
      case "turn_result":
        if (!e.isError) messages += 1;
        break;
      default:
        break;
    }
  }

  // text_delta 여러 개를 한 블록으로 합치고, 같은 블록의 중복 마커는 첫 번째만 남긴다.
  const seenText = new Set<string>();
  const body = lines
    .filter((l) => {
      if (!l.startsWith(" text:")) return true;
      if (seenText.has(l)) return false;
      seenText.add(l);
      return true;
    })
    .map((l) =>
      l.startsWith(" text:")
        ? `${assistantHeading}\n${clip(t, (textBlocks.get(l.slice(6)) ?? "").trim(), 1600)}`
        : l,
    )
    // 내용이 빈 단락은 머리말만 남는다 — 버린다
    .filter((l) => l.trim() !== assistantHeading)
    // 성공한 툴 결과는 마지막 RECENT_RESULTS 개만 남긴다.
    .filter((l) => {
      if (!l.startsWith(" result:")) return true;
      return Number(l.slice(8)) >= results.length - RECENT_RESULTS;
    })
    .map((l) => (l.startsWith(" result:") ? `  - ${results[Number(l.slice(8))]}` : l));

  const pending = pendingTodos(lastTodoInput);
  const header = [
    opts.fromProvider ? t("promptDoc.handoff.titleFrom", { provider: opts.fromProvider }) : t("promptDoc.handoff.title"),
    opts.cwd ? t("promptDoc.handoff.cwd", { cwd: opts.cwd }) : "",
    // 무엇을 하려던 세션인지가 제일 중요하다 — 기록이 잘려도 이것만은 남게 머리말로 올린다.
    firstUserMessage ? t("promptDoc.handoff.request", { text: clip(t, firstUserMessage, 600) }) : "",
    files.size > 0 ? t("promptDoc.handoff.files", { list: [...files].slice(0, 30).join(", ") }) : "",
    pending.length > 0 ? t("promptDoc.handoff.pending", { list: pending.map((item) => `- [ ] ${item}`).join("\n") }) : "",
    "",
    // 옛 지시가 원문 그대로 들어 있어 그대로 두면 끝난 일을 다시 할 수 있다.
    t("promptDoc.handoff.notice1"),
    t("promptDoc.handoff.notice2"),
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const text = body.join("\n\n");
  // 넘치면 가운데를 버린다. 앞에는 무엇을 하려 했는지가, 뒤에는 어디까지 왔는지가 있다.
  const budget = maxChars - header.length - 24;
  const summary =
    text.length <= budget
      ? `${header}\n${text}`
      : `${header}\n${text.slice(0, Math.floor(budget * 0.3))}\n\n${t("promptDoc.handoff.middleCut")}\n\n${text.slice(text.length - Math.floor(budget * 0.7))}`;

  return {
    summary,
    stats: {
      messages,
      files: files.size,
      pendingTasks: pending.length,
      tokensEstimate: estimateTokens(summary),
    },
  };
}

function toolOneLiner(t: TFunction, name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return str(i.command).split("\n")[0];
    case "Edit":
    case "Write":
    case "Read":
    case "MultiEdit":
      return str(i.file_path);
    case "ApplyPatch":
      return extractFilePaths(input).join(", ");
    case "TodoWrite":
      return t("promptDoc.handoff.pendingCount", { n: pendingTodos(input).length });
    case "Grep":
    case "Glob":
      return str(i.pattern);
    default: {
      const first = Object.values(i).find((v) => typeof v === "string");
      return typeof first === "string" ? first : JSON.stringify(i).slice(0, 120);
    }
  }
}

/**
 * 떠나는 provider 에게 직접 인수인계서를 쓰게 하는 프롬프트.
 *
 * 우리가 이벤트 로그를 잘라 만드는 요약(buildHandoff)은 무엇이 중요한지 판단하지 못한다.
 * Anthropic 권고는 압축을 모델에게 맡기고, 회수율을 먼저 최대화한 뒤 정밀도를 높이라는 것이다.
 * 항목 순서가 그 회수율 장치다 — 의도·결정·막힌 곳처럼 기록에서 복원할 수 없는 것을 앞에 둔다.
 * 본문은 사전(promptDoc.handoff.brief)에 있고, 여기서는 떠나는 provider 의 노트 파일 이름만 채운다.
 */
export function handoffBriefPrompt(t: TFunction, provider: string): string {
  return t("promptDoc.handoff.brief").replaceAll("{NOTE_FILE}", NOTE_FILE[provider] ?? "AGENTS.md");
}

/** 인계 직전에 오래 남길 것을 적어 두는 파일. 앱이 새 규약을 만들지 않고 각 CLI 의 것을 쓴다. */
export const NOTE_FILE: Record<string, string> = { claude: "CLAUDE.md", codex: "AGENTS.md" };

/** 경로가 cwd 바로 아래의 그 파일인가. 하위 디렉토리·다른 이름은 아니다. */
export function isNoteFile(filePath: string, cwd: string, name: string): boolean {
  const p = filePath.trim();
  if (!p) return false;
  if (p === name) return true; // 상대 경로로 오는 경우
  // Windows 는 C:\a\CLAUDE.md·C:/a/CLAUDE.md 가 섞이고 대소문자를 가리지 않는다 — any-path 로 비교한다.
  return samePath(p, joinAny(cwd, name));
}

/**
 * 인계서 턴에서 올라온 권한 요청의 판정. 기본은 거부다 — 이 턴은 사람이 보고 있지 않다.
 *
 * 딱 하나만 연다: 그 provider 의 노트 파일에 오래 남길 것을 덧붙이는 일. 다만 이미 있는 파일을
 * 통째로 새로 쓰는 것(Write)은 막는다 — 사용자가 쌓아 둔 내용을 날릴 수 있다. 없는 파일은
 * 날릴 것이 없으니 만들게 둔다.
 */
export function handoffNotePermission(
  tool: string,
  input: unknown,
  opts: { cwd: string; note: string; exists: (path: string) => boolean },
): "allow" | "deny" {
  const paths = extractFilePaths(input);
  if (paths.length === 0) return "deny";
  if (!paths.every((p) => isNoteFile(p, opts.cwd, opts.note))) return "deny";
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "ApplyPatch":
      return "allow";
    case "Write":
      // 덮어쓰기는 파일이 없을 때만.
      return paths.every((p) => !opts.exists(p)) ? "allow" : "deny";
    default:
      return "deny";
  }
}
