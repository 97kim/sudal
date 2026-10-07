import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { msgText } from "@shared/i18n/msg";
import type { ToolBlock } from "@shared/session-state";
import { CODEX_PERMISSION_TOOL, isToolActive, isToolFailed, isToolWaiting, toolState } from "@shared/tool-state";
import { DiffView } from "./DiffView";
import { useOpenFile } from "./FileViewer";
import { FileChangeList, questionsOf } from "./PermissionPrompt";
import { Icon, type IconName } from "./Icon";
import { RunInTerminalContext, normalizeCommand } from "../terminal-run";
import { shortenHome } from "@shared/path-display";
import { formatElapsed, useNow } from "../hooks/useNow";

const OUTPUT_PREVIEW_LINES = 12;

type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (v && typeof v === "object" ? (v as Input) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function iconFor(name: string): IconName {
  switch (name) {
    case "Bash":
      return "terminal";
    case "Read":
      return "file";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "ApplyPatch":
      return "edit";
    case "Glob":
    case "Grep":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "globe";
    case "TodoWrite":
      return "list";
    default:
      return "play";
  }
}

function summary(name: string, input: Input, t: TFunction): string {
  switch (name) {
    case "Bash":
      return str(input.description) || str(input.command).split("\n")[0];
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return shortenHome(str(input.file_path) || str(input.notebook_path));
    case "ApplyPatch": {
      const changes = Array.isArray(input.changes) ? (input.changes as { path?: string }[]) : [];
      return changes.map((c) => shortenHome(str(c.path))).join(", ");
    }
    case "Glob":
    case "Grep":
      return str(input.pattern);
    case "Agent":
    case "Task":
      return str(input.description);
    case "WebFetch":
      return str(input.url);
    case "WebSearch":
      return str(input.query);
    case "AskUserQuestion":
      return questionsOf(input).map((q) => q.question).join(" · ");
    case "TodoWrite": {
      const items = todoItems(input);
      const done = items.filter((t) => t.done).length;
      return t("toolCard.todoDone", { done, total: items.length });
    }
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return typeof first === "string" ? first.slice(0, 120) : "";
    }
  }
}


/** 파일을 다루는 툴이면 코드 뷰어로 열 경로. Write 는 결과가 온 뒤(파일이 생긴 뒤)에만. */
function filePathOf(name: string, input: Input): string | null {
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return str(input.file_path) || null;
    case "NotebookEdit":
      return str(input.notebook_path) || null;
    default:
      return null;
  }
}

function todoItems(input: Input): { text: string; done: boolean }[] {
  if (Array.isArray(input.todos)) {
    return (input.todos as { content?: string; status?: string }[]).map((t) => ({
      text: str(t.content),
      done: t.status === "completed",
    }));
  }
  if (Array.isArray(input.items)) {
    return (input.items as { text?: string; completed?: boolean }[]).map((t) => ({
      text: str(t.text),
      done: t.completed === true,
    }));
  }
  return [];
}

// 변경(diff)과 할 일 목록은 결과 자체가 내용이라 펼쳐 두고, 명령 실행·읽기·검색은 필요할 때만 펼친다(길고 매번 볼 것은 아니다).
function isExpandedByDefault(name: string): boolean {
  return ["Edit", "Write", "MultiEdit", "TodoWrite"].includes(name);
}

export function ToolCard({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(() => isExpandedByDefault(block.name));
  const input = asInput(block.input);
  const openFile = useOpenFile();
  const runInTerminal = useContext(RunInTerminalContext);
  const filePath = block.partial ? null : filePathOf(block.name, input);
  // Bash 명령은 이 탭의 터미널에 넣을 수 있다(Enter 는 사용자가, ⌥클릭이면 바로 실행). 아직 입력이 만들어지는 중이면 없다.
  const bashCommand = block.name === "Bash" && !block.partial && runInTerminal ? normalizeCommand(str(input.command)) : "";
  // Read 의 offset/limit(1부터 세는 시작 줄·줄 수)이면 그 범위로 에디터를 연다
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  const readAt = (() => {
    if (block.name !== "Read") return null;
    const offset = num(input.offset);
    const limit = num(input.limit);
    if (offset === null && limit === null) return null;
    const line = Math.max(1, offset ?? 1);
    return { line, endLine: limit !== null && limit > 0 ? line + limit - 1 : undefined };
  })();
  const { t, i18n } = useTranslation();
  const state = toolState(block);
  const waiting = isToolWaiting(state);
  const failed = isToolFailed(state);
  const tone = failed ? "text-err" : state === "done" ? "text-ok" : waiting ? "text-warn" : "text-accent";
  const active = isToolActive(state);
  const now = useNow(active);
  const elapsed = active && block.ts ? Math.max(0, Math.floor((now - block.ts) / 1000)) : 0;

  return (
    <div className="rounded-lg border border-line bg-panel" data-tool-card={block.name} data-tool-open={open ? "true" : "false"}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
        data-tool-toggle
      >
        <span
          className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            state === "done"
              ? "border-ok/40 bg-ok-bg text-ok"
              : failed
                ? "border-err/40 bg-err-bg text-err"
                : active
                  ? "border-accent/40 bg-accent-tint text-accent"
                  : "border-line bg-panel-2 text-muted"
          }`}
        >
          {state === "done" ? (
            <Icon name="check" size={11} strokeWidth={2.4} />
          ) : (
            <Icon name={iconFor(block.name)} size={11} />
          )}
          {active && (
            // 진행 중: 아이콘 둘레를 도는 얇은 링
            <span className="spin pointer-events-none absolute -inset-[3px] rounded-md border border-transparent border-t-accent" aria-hidden />
          )}
        </span>
        {/* MCP 도구 이름은 길고 공백이 없다(mcp__playwright__playwright_evaluate) — flex 항목의 기본
            min-width:auto 로는 줄어들지 못해 카드 밖으로 삐져나온다. 줄이고 말줄임, 전체 이름은 툴팁으로. */}
        <span className="min-w-0 shrink truncate font-medium" title={block.name}>
          {block.name === CODEX_PERMISSION_TOOL ? t("toolCard.permissionTool") : block.name}
        </span>
        {filePath ? (
          // 헤더 버튼(펼치기) 안의 경로만 코드 뷰어로 연결. 펼침 토글은 막는다.
          <span
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              openFile(filePath, readAt);
            }}
            title={readAt ? t("toolCard.openInEditorLines", { range: `${readAt.line}${readAt.endLine ? `–${readAt.endLine}` : ""}` }) : t("toolCard.openInEditor")}
            className="mono min-w-0 flex-1 truncate text-muted underline decoration-line underline-offset-2 hover:text-accent hover:decoration-accent"
          >
            {summary(block.name, input, t)}
          </span>
        ) : (
          <span className="mono min-w-0 flex-1 truncate text-muted">{summary(block.name, input, t)}</span>
        )}
        {bashCommand && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              runInTerminal!(bashCommand, e.altKey);
            }}
            title={t("toolCard.runInTerminalHint")}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg"
            data-run-in-terminal
          >
            <Icon name="terminal" size={11} />
          </span>
        )}
        {block.aiReview && (
          <span
            className="shrink-0 rounded bg-accent-tint px-1 text-[10px] text-accent"
            title={block.aiReview === "approved" ? t("toolCard.aiApprovedHint") : undefined}
            data-ai-review={block.aiReview}
          >
            {t(block.aiReview === "approved" ? "toolCard.aiApproved" : "toolCard.aiReviewing")}
          </span>
        )}
        <span className={`label flex shrink-0 items-center gap-1.5 ${tone}`}>
          <span
            className={active ? "shimmer" : ""}
            style={active ? ({ "--shimmer-base": waiting ? "var(--color-warn)" : "var(--color-accent)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties) : undefined}
          >
            {t(`toolCard.state.${state}`)}
          </span>
          {active && elapsed >= 2 && (
            <span className="mono normal-case tracking-normal text-muted-2" data-tool-elapsed>
              {formatElapsed(t, elapsed)}
            </span>
          )}
        </span>
        <Icon name="chevronDown" size={12} className={`text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {block.subagent && (
        // Skill·Agent 가 띄운 하위 에이전트의 활동. 접혀 있어도 보인다 — 턴을 잡고 있는 게 무엇인지 알 수 있게.
        <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-muted" data-subagent>
          <Icon name="arrowRight" size={11} className="shrink-0 text-muted-2" />
          <span className={`shrink-0 ${active ? "shimmer" : ""}`} style={active ? ({ "--shimmer-base": "var(--color-muted)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties) : undefined}>
            {t("toolCard.subagent")}
          </span>
          {block.subagent.via === "codex" && (
            <span className="shrink-0 rounded bg-accent-tint px-1 text-[10px] text-accent" title={t("toolCard.subagentViaCodexHint")} data-subagent-via="codex">
              Codex
            </span>
          )}
          <span className="mono shrink-0 text-muted-2">{t("toolCard.subagentTools", { count: block.subagent.toolCalls })}</span>
          {block.subagent.lastTool ? (
            <span className="mono min-w-0 flex-1 truncate" title={JSON.stringify(block.subagent.lastTool.input)}>
              {block.subagent.lastTool.name} {summary(block.subagent.lastTool.name, block.subagent.lastTool.input, t)}
            </span>
          ) : block.subagent.lastText ? (
            <span className="min-w-0 flex-1 truncate">{block.subagent.lastText}</span>
          ) : null}
        </div>
      )}
      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <ToolBody name={block.name} input={input} />
          {block.subagent && block.subagent.log.length > 0 && (
            // 하위 에이전트(및 그 아래 Codex)의 최근 활동 — 접혀 있을 땐 마지막 한 줄만, 펼치면 로그
            <ol className="mono mb-2 max-h-40 overflow-y-auto rounded-md bg-inset p-2 text-[10.5px] leading-[1.6] text-muted" data-subagent-log style={{ userSelect: "text" }}>
              {block.subagent.log.map((l, i) => (
                <li key={i} className="truncate" title={l}>
                  {l}
                </li>
              ))}
            </ol>
          )}
          {block.result && <ToolOutput output={msgText(i18n, block.result.outputMsg, block.result.output)} isError={block.result.isError} />}
        </div>
      )}
    </div>
  );
}

function ToolBody({ name, input }: { name: string; input: Input }) {
  switch (name) {
    case "Bash":
      return (
        <pre className="mono whitespace-pre-wrap break-words rounded-md bg-inset p-2.5" style={{ userSelect: "text" }}>
          <span className="text-muted">$ </span>
          {str(input.command)}
        </pre>
      );
    case "Edit":
      return <DiffView oldText={str(input.old_string)} newText={str(input.new_string)} />;
    case "Write":
      return <DiffView oldText="" newText={str(input.content)} />;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      return (
        <div className="flex flex-col gap-2">
          {edits.map((e, i) => (
            <DiffView key={i} oldText={str(e.old_string)} newText={str(e.new_string)} />
          ))}
        </div>
      );
    }
    case "ApplyPatch":
      return <FileChangeList changes={input.changes} />;
    case "AskUserQuestion":
      return (
        <div className="flex flex-col gap-2">
          {questionsOf(input).map((q, i) => (
            <div key={i}>
              <p className="mb-1">{q.question}</p>
              <ul className="flex flex-col gap-0.5 pl-3 text-muted">
                {q.options.map((o) => (
                  <li key={o.label}>· {o.label}{o.description ? ` — ${o.description}` : ""}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    case "TodoWrite":
      return (
        <ul className="flex flex-col gap-1">
          {todoItems(input).map((t, i) => (
            <li key={i} className={`flex items-center gap-2 ${t.done ? "text-muted line-through" : ""}`}>
              <span
                className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
                  t.done ? "border-ok/50 bg-ok-bg text-ok" : "border-line"
                }`}
              >
                {t.done && <Icon name="check" size={9} strokeWidth={3} />}
              </span>
              {t.text}
            </li>
          ))}
        </ul>
      );
    default:
      return (
        <pre className="mono whitespace-pre-wrap break-all text-muted" style={{ userSelect: "text" }}>
          {JSON.stringify(input, null, 2)}
        </pre>
      );
  }
}

function ToolOutput({ output, isError }: { output: string; isError: boolean }) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const lines = output.split("\n");
  const truncated = !full && lines.length > OUTPUT_PREVIEW_LINES;
  const text = truncated ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n") : output;
  if (!output.trim()) return null;
  return (
    <div className="mt-2">
      <pre
        className={`mono max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-inset p-2.5 ${
          isError ? "text-err" : "text-fg/90"
        }`}
        style={{ userSelect: "text" }}
      >
        {text}
      </pre>
      {truncated && (
        <button onClick={() => setFull(true)} className="mt-1 text-[11px] text-muted hover:text-fg">
          {t("toolCard.moreLines", { count: lines.length - OUTPUT_PREVIEW_LINES })}
        </button>
      )}
    </div>
  );
}
