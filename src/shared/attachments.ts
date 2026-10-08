import type { TFunction } from "i18next";

// 에디터 선택 영역·터미널 출력을 채팅 입력창에 넣을 때의 형식. 모델이 파일과 줄을 바로 알아보게 "경로:줄" 머리말 + 코드 펜스.
const LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json", yml: "yaml", yaml: "yaml", md: "md", py: "python",
  rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", sh: "bash", zsh: "bash", bash: "bash", css: "css", scss: "scss", html: "html", xml: "xml", sql: "sql",
  toml: "toml", vue: "vue", svelte: "svelte", graphql: "graphql", proto: "proto", tf: "hcl", dockerfile: "dockerfile", txt: "",
};

export function fenceLang(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  return LANG[ext] ?? "";
}

/** 펜스 문자: 본문에 ``` 가 있으면 더 긴 펜스를 쓴다. */
function fenceFor(text: string): string {
  let n = 3;
  for (const m of text.matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1);
  return "`".repeat(n);
}

/** 에디터 선택: "경로:12-20" 머리말 + 코드 펜스. 한 줄이면 "경로:12". */
export function formatCodeAttachment(o: { relPath: string; line: number; endLine?: number; text: string }): string {
  const range = o.endLine && o.endLine !== o.line ? `${o.line}-${o.endLine}` : `${o.line}`;
  const fence = fenceFor(o.text);
  const body = o.text.replace(/\n$/, "");
  return `${o.relPath}:${range}\n${fence}${fenceLang(o.relPath)}\n${body}\n${fence}`;
}

/** 터미널 출력: 어디서 왔는지 한 줄 + 텍스트 펜스. 끝의 빈 줄은 뗀다. */
export function formatTerminalAttachment(t: TFunction, o: { title: string; text: string; selection: boolean }): string {
  const fence = fenceFor(o.text);
  const body = o.text.replace(/\s+$/, "");
  return `${t(o.selection ? "promptDoc.attach.terminalSelection" : "promptDoc.attach.terminalRecent", { title: o.title })}\n${fence}text\n${body}\n${fence}`;
}

/** 검증 실패 출력 등 제목 한 줄 + 텍스트 펜스. */
export function formatOutputAttachment(o: { title: string; text: string }): string {
  const fence = fenceFor(o.text);
  return `${o.title}\n${fence}text\n${o.text.replace(/\s+$/, "")}\n${fence}`;
}

/** 입력창에 이어 붙이기: 기존 글이 있으면 빈 줄 하나 띄운다. */
export function appendToDraft(current: string, block: string): string {
  const head = current.replace(/\s+$/, "");
  return (head ? head + "\n\n" : "") + block + "\n";
}
