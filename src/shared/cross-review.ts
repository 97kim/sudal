// 교차 리뷰: 한 탭의 작업 트리 변경(diff)을 다른 provider 탭에 보내 독립 리뷰를 받는다. 프롬프트는 여기서 만든다.
import type { TFunction } from "i18next";
import type { Provider } from "./ipc";

export const CROSS_REVIEW_DIFF_MAX = 120_000;

export function otherProvider(p: Provider): Provider {
  return p === "claude" ? "codex" : "claude";
}

export function reviewTabTitle(t: TFunction, originTitle: string): string {
  return t("main.review.tabTitle", { title: originTitle });
}

/** 변경 요약 한 줄("3개 파일 · +42 −7")의 값. 문장은 `main.msg.reviewScope` 로 만들고 카드에도 키째 저장한다. */
export function reviewScopeParams(changes: { path: string; added: number; deleted: number }[]): { count: number; added: number; deleted: number } {
  const added = changes.reduce((n, c) => n + c.added, 0);
  const deleted = changes.reduce((n, c) => n + c.deleted, 0);
  return { count: changes.length, added, deleted };
}

export function buildReviewPrompt(t: TFunction, o: { originTitle: string; changes: { path: string; kind: string }[]; diff: string; author: Provider }): string {
  const diff = o.diff.length > CROSS_REVIEW_DIFF_MAX ? `${o.diff.slice(0, CROSS_REVIEW_DIFF_MAX)}\n${t("promptDoc.review.diffClipped", { n: o.diff.length - CROSS_REVIEW_DIFF_MAX })}` : o.diff;
  const files = o.changes.map((c) => `- ${c.path} (${c.kind})`).join("\n");
  const authorLabel = o.author === "claude" ? "Claude Code" : "Codex";
  return [
    t("promptDoc.review.intro", { author: authorLabel, title: o.originTitle }),
    "",
    t("promptDoc.review.rules"),
    "",
    t("promptDoc.review.files"),
    files,
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * 읽기만 하는 셸 명령인지. 완전한 셸 파서가 아니므로 "판단이 안 되면 거부" 로 기운다:
 * - 조각 구분자: 파이프·&&·||·;·&·줄바꿈. 리다이렉션·명령 치환·백틱·프로세스 치환·서브셸은 판단하지 않고 거부.
 * - 조각의 첫 프로그램은 경로 없는 이름이어야 하고(./x/ls 거부) 읽기 전용 목록에 있어야 한다. env·xargs·time 같은 "다른 명령을 실행하는" 래퍼는 목록에 없다.
 * - find 의 -delete/-exec/-ok/-fprint, git 의 --output, sed -i 처럼 허용 프로그램의 쓰기·실행 기능은 플래그로 거른다.
 */
const READ_ONLY_PROGRAMS = new Set(["cat", "head", "tail", "less", "more", "grep", "rg", "ag", "find", "fd", "ls", "wc", "sort", "uniq", "cut", "awk", "tr", "echo", "printf", "pwd", "which", "type", "tree", "stat", "file", "jq", "yq", "diff", "comm", "basename", "dirname", "realpath", "readlink", "date", "true", "nl", "od", "xxd", "hexdump", "strings", "column", "paste", "rev", "expand", "fold", "tac", "du", "df", "shasum", "sha256sum", "md5", "whoami", "hostname", "uname", "test", "["]);
const GIT_READ_ONLY = new Set(["diff", "log", "show", "status", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "branch", "describe", "shortlog", "cat-file", "rev-list", "name-rev", "remote"]);
/** 프로그램별로 거부하는 인자(쓰기·실행 기능). */
const DENY_ARGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  fd: /^(-x|--exec|-X|--exec-batch)$/,
  awk: /^-f$/,
  tree: /^-o$/,
  sort: /^(-o|--output)$/,
  jq: /^(--rawfile|--slurpfile|-f|--from-file)$/,
};

/** 따옴표 밖의 | || && ; & 줄바꿈 에서 명령 조각을 나눈다(따옴표 안의 | 는 grep 패턴 등이므로 구분자가 아니다). */
export function splitShellParts(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n" || ch === "\r") {
      parts.push(cur);
      cur = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function isReadOnlyCommand(command: string): boolean {
  // Codex 는 명령을 `/bin/zsh -lc "<cmd>"` 로 감싸서 보낸다 — 안쪽 명령을 판정한다
  const wrapped = /^\s*(?:\S*\/)?(?:sh|bash|zsh)\s+-[A-Za-z]*c\s+([\s\S]+)$/.exec(command);
  if (wrapped) {
    let inner = wrapped[1].trim();
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) inner = inner.slice(1, -1);
    return isReadOnlyCommand(inner);
  }
  // 작은따옴표 안은 셸이 손대지 않으므로 지우고 본다. 큰따옴표 안의 $( )·백틱은 확장되므로 남겨 두고 본다.
  const noSingle = command.replace(/'[^']*'/g, "''");
  if (/\$\(|`|\$\{/.test(noSingle)) return false; // 명령·변수 치환은 판단하지 않는다
  const noQuotes = noSingle.replace(/"[^"]*"/g, '""');
  if (/[<>()]/.test(noQuotes)) return false; // 리다이렉션·서브셸·프로세스 치환
  const parts = splitShellParts(command);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const words = part.split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // FOO=bar 접두
    let prog = words[i] ?? "";
    // 경로가 붙은 프로그램은 표준 bin 아래 절대 경로만(./x/ls 같은 저장소 안 실행 파일은 거부)
    if (prog.includes("/")) {
      if (!/^\/(usr\/(local\/)?bin|bin|opt\/homebrew\/bin)\/[A-Za-z0-9_.+-]+$/.test(prog)) return false;
      prog = prog.split("/").pop() ?? "";
    } else if (!/^[A-Za-z0-9_.+-]+$|^\[$/.test(prog)) return false;
    const rest = words.slice(i + 1);
    if (prog === "git") {
      const sub = rest[0] ?? "";
      if (!GIT_READ_ONLY.has(sub)) return false;
      if (rest.some((w) => /^(--output|-o)(=|$)|^--exec-path=|^-c$|^-C$|^--git-dir|^--work-tree/.test(w))) return false;
      if (sub === "branch" && rest.slice(1).some((w) => /^-[dDmM]|--delete|--move|--set-upstream|--unset-upstream|-u$/.test(w))) return false;
      if (sub === "remote" && rest.slice(1).some((w) => /^(add|remove|rm|set-url|rename|prune|update)$/.test(w))) return false;
      if (sub === "log" && rest.some((w) => /^--output/.test(w))) return false;
      continue;
    }
    if (prog === "sed") {
      if (rest.some((w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place")) return false;
      // w/W(파일 쓰기)·e(실행) 명령: 스크립트 어딘가에 "w 파일" 꼴이 있으면 거부(거부 쪽으로 기운 근사)
      const script = rest.filter((w) => !w.startsWith("-")).join(" ").replace(/['"]/g, "");
      if (/[wWe](\s|$)/.test(script)) return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(prog)) return false;
    const deny = DENY_ARGS[prog];
    if (deny && rest.some((w) => deny.test(w))) return false;
    if (prog === "awk" && rest.some((w) => /\b(system|print\s*>|printf\s*>|>\s*")/.test(w))) return false;
  }
  return true;
}

/**
 * 리뷰 탭(사람이 안 보는 탭)에 온 권한 요청의 자동 판정. 읽기만 하는 도구·명령은 허용, 나머지는 거부 — 리뷰어는 고치지 않는다.
 * 거부해도 리뷰어는 "그 정보 없이" 계속 진행한다.
 */
export function reviewPermissionDecision(tool: string, input: Record<string, unknown>): "allow" | "deny" {
  if (["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoRead", "WebFetch", "WebSearch", "Task", "Agent"].includes(tool)) return "allow";
  if (tool === "Bash" || tool === "exec" || tool === "shell") {
    const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? (input.command as unknown[]).join(" ") : "";
    return cmd && isReadOnlyCommand(cmd) ? "allow" : "deny";
  }
  return "deny";
}
