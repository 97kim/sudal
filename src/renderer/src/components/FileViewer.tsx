import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import hljs from "highlight.js/lib/common";
import { diffLines } from "diff";

/** 변경 파일 목록·툴카드 어디서든 파일을 열 수 있게 ChatView 가 내려주는 콜백. */
/** 파일 열기. at 을 주면(Read 툴카드의 줄 범위) 에디터가 그 줄을 선택하고 가운데로 스크롤한다. */
export type OpenFile = (path: string, at?: { line?: number; endLine?: number } | null) => void;
export const OpenFileContext = createContext<OpenFile>(() => {});
export const useOpenFile = () => useContext(OpenFileContext);

/** 답변 속 파일 참조("Foo.kt:63")를 실제 경로로 푸는 콜백. cwd 는 캐시 키·표시용. ChatView 가 내려준다. */
export interface LocateFile {
  cwd: string | null;
  locate(ref: string): Promise<string[]>;
}
export const LocateFileContext = createContext<LocateFile>({ cwd: null, locate: async () => [] });
export const useLocateFile = () => useContext(LocateFileContext);

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  lua: "lua",
  r: "r",
  pl: "perl",
  graphql: "graphql",
  gql: "graphql",
  makefile: "makefile",
  diff: "diff",
  patch: "diff",
};

const MAX_AUTO_HIGHLIGHT = 100_000;
const MAX_DIFF_ROWS = 3000;
const CONTEXT = 3;

function languageFor(path: string): string | undefined {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const lang = EXT_LANG[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlight(code: string, path: string): string {
  const lang = languageFor(path);
  try {
    if (lang) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (code.length <= MAX_AUTO_HIGHLIGHT) return hljs.highlightAuto(code).value;
  } catch {
    // 하이라이트 실패는 치명적이지 않다 — 평문으로.
  }
  return escapeHtml(code);
}

export type DiffRow =
  | { kind: " " | "+" | "-"; oldNo: number | null; newNo: number | null; text: string }
  | { kind: "skip"; count: number };

/** 전체 파일 diff 를 hunk 로 접는다: 변경 주변 CONTEXT 줄만 남기고 나머지는 "n줄 생략". */
export function buildDiff(
  oldText: string,
  newText: string,
): { rows: DiffRow[]; flat: Extract<DiffRow, { kind: " " | "+" | "-" }>[]; added: number; deleted: number } {
  const flat: Extract<DiffRow, { kind: " " | "+" | "-" }>[] = [];
  let o = 1;
  let n = 1;
  let added = 0;
  let deleted = 0;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (part.added) {
        flat.push({ kind: "+", oldNo: null, newNo: n++, text });
        added++;
      } else if (part.removed) {
        flat.push({ kind: "-", oldNo: o++, newNo: null, text });
        deleted++;
      } else {
        flat.push({ kind: " ", oldNo: o++, newNo: n++, text });
      }
    }
  }
  const keep = new Array<boolean>(flat.length).fill(false);
  flat.forEach((r, i) => {
    if (r.kind === " ") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(flat.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  for (let i = 0; i < flat.length; i++) {
    if (keep[i]) {
      if (skipped) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(flat[i]);
    } else skipped++;
  }
  if (skipped) rows.push({ kind: "skip", count: skipped });
  return { rows, flat, added, deleted };
}

/** 줄 번호 거터 + 하이라이트된 코드. 둘 다 같은 줄 높이라 세로로 맞물리고, 거터는 가로 스크롤에도 고정. */
export function CodeTable({ html, lines }: { html: string; lines: number }) {
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);
  return (
    <div className="code-view flex min-w-max">
      <pre className="sticky left-0 select-none border-r border-line bg-inset pl-4 pr-3 text-right text-muted-2">
        {numbers}
      </pre>
      <pre className="hljs flex-1 px-4" style={{ background: "none", userSelect: "text" }}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export function DiffTable({ rows }: { rows: DiffRow[] }) {
  const { t } = useTranslation();
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  return (
    <div className="code-view min-w-max">
      {shown.map((r, i) =>
        r.kind === "skip" ? (
          <div key={i} className="flex bg-panel-2 text-muted">
            <span className="w-[5.5rem] shrink-0" />
            <span className="px-4">… {t("panel.viewer.skippedLines", { count: r.count })}</span>
          </div>
        ) : (
          <div
            key={i}
            className={`flex ${r.kind === "+" ? "bg-ok-bg text-ok" : r.kind === "-" ? "bg-err-bg text-err" : "text-fg/90"}`}
          >
            <span className="sticky left-0 flex w-[5.5rem] shrink-0 select-none border-r border-line bg-inset text-muted-2">
              <span className="w-10 pr-1 text-right">{r.oldNo ?? ""}</span>
              <span className="w-10 pr-1 text-right">{r.newNo ?? ""}</span>
            </span>
            <span className="w-5 shrink-0 select-none text-center opacity-70">{r.kind}</span>
            <span className="whitespace-pre pr-4" style={{ userSelect: "text" }}>
              {r.text}
            </span>
          </div>
        ),
      )}
      {rows.length > MAX_DIFF_ROWS && (
        <div className="px-4 py-2 text-muted">… {t("panel.diff.moreLines", { count: rows.length - MAX_DIFF_ROWS })}</div>
      )}
    </div>
  );
}
