import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePaneFocusRef } from "../pane-focus";
import type { PermissionAnswer, PermissionRequestEvent } from "@shared/chat-events";
import { msgText } from "@shared/i18n/msg";
import { DiffView, UnifiedDiff } from "./DiffView";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Codex fileChange 승인: 경로·종류·unified diff. ToolCard 의 ApplyPatch 와 같은 모양. */
export function FileChangeList({ changes }: { changes: unknown }) {
  const list = (Array.isArray(changes) ? changes : []) as { path?: string; kind?: string; diff?: string }[];
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {list.map((c, i) => (
        <div key={i}>
          <p className="mono mb-1 flex gap-2 text-muted">
            <span className={c.kind === "add" ? "text-ok" : c.kind === "delete" ? "text-err" : "text-warn"}>{c.kind ?? "update"}</span>
            <span className="truncate" title={str(c.path)}>{str(c.path)}</span>
          </p>
          {c.diff && <UnifiedDiff diff={c.diff} />}
        </div>
      ))}
    </div>
  );
}

export function PermissionPrompt({
  request,
  onAnswer,
}: {
  request: PermissionRequestEvent;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  const { t, i18n } = useTranslation();
  const isQuestion = request.tool === "AskUserQuestion";
  const paneFocus = usePaneFocusRef();
  const allowBtn = useRef<HTMLButtonElement>(null);
  // "허용" 에 포커스를 준다 — 단, 분할 화면의 다른 칸이면 주지 않는다. 옆 칸에서 쓰던 중에 누른 Enter 가 이 버튼을 누르게 된다.
  useEffect(() => {
    if (paneFocus.current) allowBtn.current?.focus();
  }, []);
  // Enter = 허용, Esc = 거부. 텍스트 입력 중이면 무시. 질문은 Enter 로 빈 답을 보내면 안 되므로 Esc(건너뛰기)만.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      // 분할 화면이면 포커스된 칸의 승인 창만 — 안 그러면 양쪽 승인 창이 키 한 번에 같이 승인된다.
      if (!paneFocus.current) return;
      // 처리한 키는 기본 동작을 막는다 — 포커스가 남아 있는 다른 버튼(옆 칸의 "허용" 등)이 같이 눌리지 않게.
      if (e.key === "Enter" && !isQuestion) {
        e.preventDefault();
        onAnswer({ behavior: "allow" });
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onAnswer({ behavior: "deny" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer, isQuestion]);

  if (isQuestion)
    return <QuestionPrompt request={request} onAnswer={onAnswer} />;

  const { tool, input } = request;
  return (
    <div className="mx-6 mb-2 rounded-xl border border-warn/50 bg-panel p-4 shadow-2xl">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-warn" />
        <span className="font-medium">{request.title ? msgText(i18n, request.titleMsg, request.title) : t("chat.permission.title", { tool })}</span>
      </div>
      {request.description && <p className="mb-2 text-muted">{request.description}</p>}
      <div className="mb-3 max-h-64 overflow-auto">
        <Preview tool={tool} input={input} />
      </div>
      <div className="flex gap-2">
        <button
          ref={allowBtn}
          onClick={() => onAnswer({ behavior: "allow" })}
          className="rounded-md bg-primary px-3.5 py-1.5 font-medium text-on-primary hover:bg-primary-hover"
        >
          {t("chat.permission.allow")} <kbd className="ml-1 text-[10px] opacity-70">⏎</kbd>
        </button>
        {request.canAlwaysAllow && (
          <button
            onClick={() => onAnswer({ behavior: "allow", always: true })}
            className="rounded-md border border-line px-3 py-1 hover:bg-panel-2"
          >
            {t("chat.permission.alwaysAllow")}
          </button>
        )}
        <button
          onClick={() => onAnswer({ behavior: "deny" })}
          className="ml-auto rounded-md border border-line px-3 py-1 text-muted hover:bg-panel-2 hover:text-fg"
        >
          {t("chat.permission.deny")} <kbd className="ml-1 text-[10px] opacity-70">esc</kbd>
        </button>
      </div>
    </div>
  );
}

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
};

/** AskUserQuestion 입력의 questions 를 느슨하게 읽는다(모델이 만든 값이라 형식이 어긋날 수 있다). */
export function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const out: Question[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    if (!q || typeof q !== "object" || typeof q.question !== "string") continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object" && typeof (o as Record<string, unknown>).label === "string")
      .map((o) => ({ label: str(o.label), description: str(o.description) || undefined, preview: str(o.preview) || undefined }));
    out.push({ question: q.question, header: str(q.header) || undefined, multiSelect: q.multiSelect === true, options });
  }
  return out;
}

const OTHER = "\u0000other"; // 선택지 라벨과 겹치지 않는 "직접 입력" 표시

/**
 * AskUserQuestion: 승인이 아니라 답을 고르는 카드. 질문마다 선택지 버튼 + 직접 입력.
 * 질문이 하나이고 단일 선택이면 선택지를 누르는 즉시 보낸다. 그 외엔 모두 답한 뒤 "답변 보내기".
 */
function QuestionPrompt({
  request,
  onAnswer,
}: {
  request: PermissionRequestEvent;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  const { t } = useTranslation();
  const questions = questionsOf(request.input);
  // 질문 index → 고른 라벨 집합(직접 입력은 OTHER 키)
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  // preview 는 고른 선택지에만 보이므로, preview 가 있으면 즉시 전송하지 않고 눌러 본 뒤 확정하게 한다
  const hasPreview = questions.some((q) => q.options.some((o) => o.preview));
  const instant = questions.length === 1 && !questions[0].multiSelect && !hasPreview;

  const answerOf = (i: number): string | null => {
    const set = picked[i] ?? new Set<string>();
    const parts = [...set].filter((l) => l !== OTHER);
    if (set.has(OTHER)) {
      const text = (custom[i] ?? "").trim();
      if (text) parts.push(text);
    }
    return parts.length > 0 ? parts.join(", ") : null;
  };
  const submit = (override?: { index: number; label: string }) => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const a = override && override.index === i ? override.label : answerOf(i);
      if (a) answers[q.question] = a;
    });
    if (Object.keys(answers).length === 0) return;
    onAnswer({ behavior: "allow", answers });
  };
  const toggle = (i: number, label: string, multi: boolean) => {
    if (instant && label !== OTHER) return submit({ index: i, label });
    setPicked((prev) => {
      const cur = new Set(prev[i] ?? []);
      if (multi) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        const had = cur.has(label);
        cur.clear();
        if (!had) cur.add(label);
      }
      return { ...prev, [i]: cur };
    });
  };
  const complete = questions.every((_, i) => answerOf(i) !== null);

  return (
    <div className="mx-6 mb-2 rounded-xl border border-accent/50 bg-panel p-4 shadow-2xl" data-question-prompt>
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-accent" />
        <span className="font-medium">{questions.length > 1 ? t("chat.permission.questionsMany", { count: questions.length }) : t("chat.permission.questionsOne")}</span>
      </div>
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto">
        {questions.map((q, i) => {
          const set = picked[i] ?? new Set<string>();
          return (
            <div key={i} data-question-index={i}>
              <p className="mb-2">
                {q.header && <span className="mr-2 rounded bg-accent-tint px-1.5 py-0.5 text-[10px] text-accent">{q.header}</span>}
                {q.question}
              </p>
              <div className="flex flex-col gap-1.5">
                {q.options.map((o) => {
                  const on = set.has(o.label);
                  return (
                    <button
                      key={o.label}
                      onClick={() => toggle(i, o.label, Boolean(q.multiSelect))}
                      className={`rounded-md border px-3 py-2 text-left ${on ? "border-accent/50 bg-accent-tint" : "border-line hover:bg-panel-2"}`}
                      data-question-option
                    >
                      <span className="flex items-center gap-2">
                        <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${on ? "border-accent bg-accent text-on-primary" : "border-line"}`}>
                          {on && <span className="text-[9px] leading-none">✓</span>}
                        </span>
                        <span className="font-medium">{o.label}</span>
                      </span>
                      {o.description && <span className="mt-0.5 block pl-[22px] text-muted">{o.description}</span>}
                      {on && o.preview && <pre className="mono mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-inset p-2 text-muted">{o.preview}</pre>}
                    </button>
                  );
                })}
                <div
                  className={`rounded-md border px-3 py-2 ${set.has(OTHER) ? "border-accent/50 bg-accent-tint" : "cursor-pointer border-line hover:bg-panel-2"}`}
                  onClick={() => !set.has(OTHER) && toggle(i, OTHER, Boolean(q.multiSelect))}
                  data-question-other
                >
                  <span className="text-muted">{t("chat.permission.other")}</span>
                  {set.has(OTHER) && (
                    <input
                      autoFocus
                      value={custom[i] ?? ""}
                      onChange={(e) => setCustom((c) => ({ ...c, [i]: e.target.value }))}
                      onKeyDown={(e) => {
                        // 한국어 IME 조합 중 Enter 는 조합 확정이지 전송이 아니다(Composer 와 같은 판정)
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter" && complete) submit();
                        if (e.key === "Escape") toggle(i, OTHER, Boolean(q.multiSelect));
                      }}
                      placeholder={t("chat.permission.otherPlaceholder")}
                      className="mt-1.5 w-full rounded border border-line bg-inset px-2 py-1 outline-none focus:border-accent"
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {questions.length === 0 && (
          <pre className="mono whitespace-pre-wrap break-all text-muted">{JSON.stringify(request.input, null, 2)}</pre>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        {!instant && (
          <button
            disabled={!complete}
            onClick={() => submit()}
            className="rounded-md bg-primary px-3.5 py-1.5 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {t("chat.permission.sendAnswers")}
          </button>
        )}
        <button
          onClick={() => onAnswer({ behavior: "deny" })}
          className="ml-auto rounded-md border border-line px-3 py-1 text-muted hover:bg-panel-2 hover:text-fg"
          title={t("chat.permission.skipHint")}
        >
          {t("chat.permission.skip")} <kbd className="ml-1 text-[10px] opacity-70">esc</kbd>
        </button>
      </div>
    </div>
  );
}

function Preview({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (tool === "Bash") {
    return <pre className="mono whitespace-pre-wrap break-words rounded-md bg-inset p-2">$ {str(input.command)}</pre>;
  }
  if (tool === "Edit") {
    return (
      <>
        <p className="mono mb-1 text-muted">{str(input.file_path)}</p>
        <DiffView oldText={str(input.old_string)} newText={str(input.new_string)} />
      </>
    );
  }
  if (tool === "Write") {
    return (
      <>
        <p className="mono mb-1 text-muted">{str(input.file_path)}</p>
        <DiffView oldText="" newText={str(input.content)} />
      </>
    );
  }
  if (tool === "ApplyPatch" && Array.isArray(input.changes) && input.changes.length > 0) {
    return (
      <>
        <FileChangeList changes={input.changes} />
        {str(input.grantRoot) && <p className="mono mt-2 text-[11px] text-muted">{t("chat.permission.grantRoot", { path: str(input.grantRoot) })}</p>}
      </>
    );
  }
  return (
    <pre className="mono whitespace-pre-wrap break-all text-muted">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}
