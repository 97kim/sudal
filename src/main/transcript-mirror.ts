// 터미널 모드 미러: CLI(TUI)가 세션을 제어하는 동안 그 CLI 가 남기는 기록 파일을 tail 해서 채팅 이벤트로 바꾼다.
//   Claude Code: ~/.claude/projects/<cwd 키>/<sessionId>.jsonl  (user/assistant 항목, assistant 는 content 블록마다 한 줄)
//   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl     (event_msg item_completed 의 item 이 SDK ThreadItem 과 유사)
// 포맷은 CLI 내부 형식이라 방어적으로 읽는다. 못 읽는 줄은 조용히 버린다 — 미러가 멈춰도 터미널은 정상이다.

import fs from "node:fs";
import path from "node:path";
import type { ChatEvent, TokenUsage } from "@shared/chat-events";
import { toolResultText } from "./claude-events";
import { sameCwd } from "@shared/any-path";

export interface MirrorState {
  /** turn_result 를 이미 낸 Claude message.id (블록마다 한 줄이라 중복 방지). */
  seenTurn: Set<string>;
  codexUsage: TokenUsage | null;
  codexTurnStartedAt: number | null;
}

export function newMirrorState(): MirrorState {
  return { seenTurn: new Set(), codexUsage: null, codexTurnStartedAt: null };
}

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tsOf(d: Record<string, unknown>, fallback: number): number {
  const t = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

/** 로컬 커맨드 출력·시스템 리마인더처럼 사용자가 친 말이 아닌 user 항목은 거른다. */
const META_USER_TEXT =
  /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook|task-notification)/;

// ===== Claude Code =====

export function mapClaudeTranscriptLine(
  line: string,
  state: MirrorState,
  now = Date.now(),
): ChatEvent[] {
  const d = safeJson(line);
  if (!d || d.isSidechain === true || d.isMeta === true) return [];
  const msg = d.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return [];
  const ts = tsOf(d, now);
  const out: ChatEvent[] = [];

  if (d.type === "user") {
    const content = msg.content;
    const texts: string[] = [];
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        else if (
          b.type === "tool_result" &&
          typeof b.tool_use_id === "string"
        ) {
          out.push({
            type: "tool_result",
            ts,
            toolUseId: b.tool_use_id,
            output: toolResultText(b.content),
            isError: b.is_error === true,
          });
        }
      }
    }
    const text = texts.join("\n").trim();
    if (text && !META_USER_TEXT.test(text)) {
      out.unshift({
        type: "user_message",
        ts,
        id: String(d.uuid ?? `u-${ts}`),
        text,
      });
    }
    return out;
  }

  if (d.type === "assistant") {
    const id = typeof msg.id === "string" ? msg.id : `m-${ts}`;
    const content = Array.isArray(msg.content)
      ? (msg.content as Record<string, unknown>[])
      : [];
    const blockBase = typeof d.apiBlockIndex === "number" ? d.apiBlockIndex : 0;
    content.forEach((b, i) => {
      const blockId = `${id}:${blockBase + i}`;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ type: "assistant_text", ts, blockId, text: b.text });
      } else if (b.type === "tool_use") {
        out.push({
          type: "tool_use",
          ts,
          toolUseId: typeof b.id === "string" ? b.id : blockId,
          name: typeof b.name === "string" ? b.name : "tool",
          input: b.input ?? {},
        });
      }
    });
    const stop = msg.stop_reason;
    if (
      (stop === "end_turn" ||
        stop === "stop_sequence" ||
        stop === "max_tokens") &&
      !state.seenTurn.has(id)
    ) {
      state.seenTurn.add(id);
      const u = (msg.usage ?? {}) as Partial<Record<string, number>>;
      out.push({
        type: "turn_result",
        ts,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
        // 메시지 하나의 usage 라 그대로 컨텍스트 크기다
        contextTokens:
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        modelUsage: {},
        isError: false,
      });
    }
    return out;
  }
  return [];
}


/** Claude 기록 파일: projects/<키>/<sessionId>.jsonl — 키 계산 대신 파일명으로 찾는다. */
export function findClaudeTranscript(
  root: string,
  sessionId: string,
): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ===== Codex =====

export function mapCodexRolloutLine(
  line: string,
  state: MirrorState,
  now = Date.now(),
): ChatEvent[] {
  const d = safeJson(line);
  if (!d) return [];
  const payload = d.payload as Record<string, unknown> | undefined;
  if (!payload || d.type !== "event_msg") return [];
  const ts = tsOf(d, now);
  const kind = payload.type;

  if (kind === "task_started") {
    state.codexTurnStartedAt = ts;
    return [];
  }
  if (kind === "token_count") {
    const info = payload.info as Record<string, unknown> | null | undefined;
    const last = (info?.last_token_usage ?? null) as Record<
      string,
      number
    > | null;
    if (last) {
      const cached = last.cached_input_tokens ?? 0;
      state.codexUsage = {
        input: Math.max(0, (last.input_tokens ?? 0) - cached),
        output: last.output_tokens ?? 0,
        cacheRead: cached,
        cacheWrite: last.cache_write_input_tokens ?? 0,
      };
    }
    return [];
  }
  if (kind === "task_complete") {
    const started = state.codexTurnStartedAt;
    const duration =
      typeof payload.duration_ms === "number"
        ? payload.duration_ms
        : started
          ? Math.max(0, ts - started)
          : 0;
    state.codexTurnStartedAt = null;
    return [
      {
        type: "turn_result",
        ts,
        usage: state.codexUsage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        costUsd: 0,
        durationMs: duration,
        numTurns: 1,
        modelUsage: {},
        isError: false,
      },
    ];
  }
  if (kind !== "item_completed") return [];
  const item = payload.item as Record<string, unknown> | undefined;
  if (!item) return [];
  const id = String(item.id ?? `i-${ts}`);
  const text = (c: unknown) =>
    Array.isArray(c)
      ? (c as Record<string, unknown>[])
          .map((x) => (typeof x.text === "string" ? x.text : ""))
          .join("")
      : typeof c === "string"
        ? c
        : "";
  switch (item.type) {
    case "UserMessage": {
      const t = text(item.content).trim();
      return t ? [{ type: "user_message", ts, id, text: t }] : [];
    }
    case "AgentMessage": {
      const t = text(item.content);
      return t.trim()
        ? [{ type: "assistant_text", ts, blockId: id, text: t }]
        : [];
    }
    case "CommandExecution": {
      const cmd = Array.isArray(item.command)
        ? (item.command as string[])
        : [String(item.command ?? "")];
      const shown = shownCommand(cmd);
      const output =
        typeof item.aggregated_output === "string"
          ? item.aggregated_output
          : typeof item.stdout === "string"
            ? item.stdout
            : "";
      const exit =
        typeof item.exit_code === "number" ? item.exit_code : undefined;
      return [
        {
          type: "tool_use",
          ts,
          toolUseId: id,
          name: "Bash",
          input: { command: shown },
        },
        {
          type: "tool_result",
          ts,
          toolUseId: id,
          output,
          isError:
            item.status === "failed" || (exit !== undefined && exit !== 0),
        },
      ];
    }
    case "FileChange": {
      const raw = item.changes;
      const changes = Array.isArray(raw)
        ? (raw as Record<string, unknown>[]).map((c) => ({
            kind: String(c.kind ?? c.type ?? "update"),
            path: String(c.path ?? ""),
          }))
        : raw && typeof raw === "object"
          ? Object.entries(raw as Record<string, Record<string, unknown>>).map(
              ([p, c]) => ({
                kind: String(c?.type ?? c?.kind ?? "update"),
                path: p,
              }),
            )
          : [];
      return [
        {
          type: "tool_use",
          ts,
          toolUseId: id,
          name: "ApplyPatch",
          input: { changes },
        },
        {
          type: "tool_result",
          ts,
          toolUseId: id,
          output: changes.map((c) => `${c.kind} ${c.path}`).join("\n"),
          isError: item.status === "failed",
        },
      ];
    }
    default:
      return [];
  }
}

/** rollout 파일의 첫 줄(session_meta)에서 세션 id 와 cwd 를 읽는다. */
/**
 * ["/bin/zsh", "-lc", "실제 명령"] 은 실제 명령만 보여 준다.
 * Windows 의 ["...\\powershell.exe", "-NoProfile", "-Command", "실제 명령"]·["cmd.exe", "/c", "실제 명령"] 도 같다.
 */
export function shownCommand(cmd: string[]): string {
  if (cmd.length >= 3 && /^-l?c$/.test(cmd[1])) return cmd[cmd.length - 1];
  const exe = (cmd[0] ?? "").split(/[\\/]/).pop() ?? "";
  if (/^(powershell|pwsh|cmd)(\.exe)?$/i.test(exe)) {
    const i = cmd.findIndex((a, j) => j > 0 && /^(-command|-c|\/c)$/i.test(a));
    if (i > 0 && i < cmd.length - 1) return cmd.slice(i + 1).join(" ");
  }
  return cmd.join(" ");
}

export function readCodexRolloutMeta(
  file: string,
): { sessionId: string | null; cwd: string | null; originator: string | null } | null {
  try {
    const first = readFirstLine(file);
    const d = first ? safeJson(first) : null;
    const p = d?.payload as Record<string, unknown> | undefined;
    if (!d || d.type !== "session_meta" || !p) return null;
    const id = p.id ?? p.session_id;
    return {
      sessionId: typeof id === "string" ? id : null,
      cwd: typeof p.cwd === "string" ? p.cwd : null,
      originator: typeof p.originator === "string" ? p.originator : null,
    };
  } catch {
    return null;
  }
}

/** 첫 줄만 읽는다. session_meta 는 base_instructions 를 통째로 품어 수십 KB 가 될 수 있어 줄바꿈이 나올 때까지 읽는다. */
function readFirstLine(file: string, maxBytes = 4 * 1024 * 1024): string | null {
  const fd = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      const nl = buf.indexOf(0x0a, 0, "utf8");
      if (nl !== -1 && nl < n) {
        chunks.push(buf.subarray(0, nl));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(buf.subarray(0, n));
      total += n;
    }
    // 줄바꿈이 아직 없다(쓰는 중) — 완전한 줄이 아니면 파싱하지 않는다.
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Codex rollout 파일 찾기. sessionId 가 있으면 파일명에 그 id 가 든 것, 없으면 after 이후 만들어진 것 중 cwd 가 맞는 최신 파일.
 * 날짜 폴더(YYYY/MM/DD)를 최신 순으로 며칠만 본다.
 */
export function findCodexRollout(
  root: string,
  opts: { sessionId?: string | null; cwd?: string | null; after?: number },
): string | null {
  const days: string[] = [];
  try {
    for (const y of fs.readdirSync(root).sort().reverse().slice(0, 2)) {
      const yp = path.join(root, y);
      for (const m of fs.readdirSync(yp).sort().reverse().slice(0, 2)) {
        const mp = path.join(yp, m);
        for (const dd of fs.readdirSync(mp).sort().reverse()) days.push(path.join(mp, dd));
      }
    }
  } catch {
    return null;
  }
  // 파일 이름만 보면 되는 id 검색은 넓게, mtime·cwd 를 봐야 하는 검색은 최근 날짜만(매 초 폴링이라 싸게).
  const scan = opts.sessionId ? days : days.slice(0, 4);
  let best: { file: string; mtime: number } | null = null;
  for (const dir of scan) {
    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      if (opts.sessionId) {
        if (f.includes(opts.sessionId)) return file;
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (
        opts.after &&
        st.birthtimeMs < opts.after - 2000 &&
        st.mtimeMs < opts.after - 2000
      )
        continue;
      if (best && st.mtimeMs <= best.mtime) continue;
      if (opts.cwd) {
        const meta = readCodexRolloutMeta(file);
        // Windows 는 대소문자·\ 표기가 탭 경로와 달라 못 찾으면 다음 메시지가 새 세션이 됐다
        if (!meta?.cwd || !sameCwd(meta.cwd, opts.cwd)) continue;
      }
      best = { file, mtime: st.mtimeMs };
    }
  }
  return best?.file ?? null;
}

// ===== Claude Code 훅 로그 =====
// 터미널 모드로 Claude CLI 를 띄울 때 --settings 로 훅을 주입해, 권한 다이얼로그가 뜨는 순간 등을 파일에 남긴다
// (훅 명령은 stdin JSON 을 그대로 append). 미러(기록 파일)에는 권한 대기가 남지 않아서 이 경로가 필요하다.

export type HookEvent =
  | {
      type: "permission_request";
      ts: number;
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_done"; ts: number; tool: string; toolUseId: string | null }
  | { type: "stop"; ts: number }
  /** 훅이 알려 준 지금 세션. TUI 안에서 /resume 으로 다른 세션에 갈아탔으면 id 가 바뀐다 — 미러가 그 기록 파일을 따라가게. */
  | { type: "session"; ts: number; sessionId: string; transcriptPath: string | null };

export function mapClaudeHookLine(line: string, now = Date.now()): HookEvent[] {
  const d = safeJson(line);
  if (!d) return [];
  const out = mapClaudeHookEvent(d, now);
  if (typeof d.session_id === "string" && d.session_id)
    out.push({ type: "session", ts: now, sessionId: d.session_id, transcriptPath: typeof d.transcript_path === "string" ? d.transcript_path : null });
  return out;
}

function mapClaudeHookEvent(d: Record<string, unknown>, now: number): HookEvent[] {
  const tool = typeof d.tool_name === "string" ? d.tool_name : "tool";
  switch (d.hook_event_name) {
    case "PermissionRequest":
      return [
        {
          type: "permission_request",
          ts: now,
          tool,
          input:
            d.tool_input && typeof d.tool_input === "object"
              ? (d.tool_input as Record<string, unknown>)
              : {},
        },
      ];
    case "PostToolUse":
    case "PostToolUseFailure":
      return [
        {
          type: "tool_done",
          ts: now,
          tool,
          toolUseId: typeof d.tool_use_id === "string" ? d.tool_use_id : null,
        },
      ];
    case "Stop":
      return [{ type: "stop", ts: now }];
    default:
      return [];
  }
}

/**
 * 훅 명령 하나로 이벤트 종류별 설정을 만든다. `--settings` 에 JSON 문자열로 넘긴다.
 * PermissionRequest(다이얼로그가 떴다)·Stop(턴이 끝났다)·UserPromptSubmit(세션 추적)만 건다 — PostToolUse 는 stdin 에 tool_response(파일 내용 등)가
 * 통째로 실려 로그가 무한히 커지고, 허용된 툴의 종료는 기록 파일의 tool_result 로도 알 수 있다.
 */
export function claudeHookSettings(command: string): string {
  const entry = [{ hooks: [{ type: "command", command }] }];
  return JSON.stringify({
    hooks: {
      PermissionRequest: entry,
      Stop: entry,
      // 프롬프트마다 session_id·transcript_path 를 준다(stdin 은 프롬프트 한 줄뿐) — TUI 안 /resume 갈아타기를 첫 턴부터 따라가려고.
      UserPromptSubmit: entry,
    },
  });
}

/**
 * Windows 용 훅: stdin 을 그대로 argv[2] 파일 끝에 붙인다(`cat >>` 와 같은 일).
 * Windows 의 Claude Code 는 훅을 Git Bash 로, 없으면 cmd.exe 로 돌린다고 알려져 있다 — 어느 셸이든 같은 뜻이 되게
 * 셸 문법 없이 .cmd 경로 하나만 명령으로 넘기고, 실제 일은 node 스크립트가 한다.
 */
export const HOOK_APPEND_SCRIPT = `// Sudal 이 만든 Claude Code 훅. stdin 을 기록 파일 끝에 붙인다.
const fs = require("fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  try { fs.appendFileSync(process.argv[2], Buffer.concat(chunks)); } catch {}
});
`;

/** 훅 로그(".jsonl")와 같은 이름의 .cmd. .cmd 는 자기 이름(%~dpn0)으로 로그 경로를 알아 명령 줄에 경로를 한 번만 쓴다. */
export function claudeHookCmdFile(hookLog: string): string | null {
  return /\.jsonl$/i.test(hookLog) ? hookLog.replace(/\.jsonl$/i, ".cmd") : null;
}

/** POSIX 셸 작은따옴표 인용. 훅 명령에 절대 경로를 박을 때 쓴다. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ===== 폴링 워처 =====

export interface WatcherOptions<T = ChatEvent> {
  /** 파일이 아직 없을 수 있으므로 매 폴링마다 다시 찾는다. */
  resolveFile: () => string | null;
  map: (line: string, state: MirrorState) => T[];
  onEvents: (events: T[]) => void;
  /** 처음 파일을 잡았을 때 이미 있는 내용을 건너뛸지. SDK 로 쓰던 세션을 이어받으면 true, 새 세션이면 false. */
  skipExisting: boolean;
  /** 처음 파일을 잡았을 때 이 바이트부터 읽는다(그 앞은 호출자가 이미 읽어 들였다). skipExisting 보다 우선. */
  startOffset?: number;
  intervalMs?: number;
  onFile?: (file: string) => void;
}

/** 기록 파일을 주기적으로 읽어 새 줄만 이벤트로 넘긴다. 줄 경계에서 잘린 조각은 다음 폴링까지 보관한다. */
export class TranscriptWatcher<T = ChatEvent> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private file: string | null = null;
  private offset = 0;
  private partial = "";
  private readonly state = newMirrorState();

  constructor(private readonly opts: WatcherOptions<T>) {}

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 700);
  }

  /** 마지막으로 한 번 더 읽고 멈춘다. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.poll();
  }

  currentFile(): string | null {
    return this.file;
  }

  poll(): void {
    try {
      if (!this.file) {
        const f = this.opts.resolveFile();
        if (!f) return;
        this.file = f;
        this.offset = this.opts.startOffset ?? (this.opts.skipExisting ? fs.statSync(f).size : 0);
        this.opts.onFile?.(f);
      }
      const st = fs.statSync(this.file);
      if (st.size < this.offset) this.offset = 0; // 파일이 새로 쓰였다
      if (st.size === this.offset) return;
      const fd = fs.openSync(this.file, "r");
      const buf = Buffer.alloc(st.size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset += n;
      const chunk = this.partial + buf.toString("utf8", 0, n);
      const lines = chunk.split("\n");
      this.partial = lines.pop() ?? "";
      const events: T[] = [];
      for (const line of lines)
        if (line.trim()) events.push(...this.opts.map(line, this.state));
      if (events.length > 0) this.opts.onEvents(events);
    } catch {
      /* 파일이 잠깐 없거나 읽기 실패 — 다음 폴링에 다시 */
    }
  }
}
