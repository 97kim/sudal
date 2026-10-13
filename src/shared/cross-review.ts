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

/** 경로를 받는 읽기 도구와 그 경로 칸. 이 밖의 도구(셸·웹·하위 에이전트·쓰기)는 모두 거부한다. */
const READ_TOOL_PATHS: Record<string, string[]> = {
  Read: ["file_path"],
  Grep: ["path"],
  Glob: ["path", "pattern"],
  LS: ["path"],
  NotebookRead: ["notebook_path"],
};

/**
 * 리뷰 탭(사람이 안 보는 탭)에 온 권한 요청의 자동 판정. 저장소 안을 읽는 도구만 허용하고 나머지는 거부한다.
 * 셸 명령은 판정하지 않고 모두 거부한다 — rg --pre·awk 의 파이프·git 환경변수처럼 "읽기" 프로그램도 명령을 실행할 수 있어
 * 목록으로 막는 방식은 계속 뚫렸다. 웹 요청은 읽은 내용을 밖으로 보낼 수 있고, 하위 에이전트는 저장소가 정한 권한 모드로 돌 수 있다.
 * 리뷰어는 diff 를 프롬프트로 이미 받으므로 거부돼도 그 정보 없이 계속 진행한다.
 * inside: 경로가 리뷰하는 저장소 안인지(심볼릭 링크까지 푼 판정은 부르는 쪽이 한다).
 */
export function reviewPermissionDecision(tool: string, input: Record<string, unknown>, inside: (path: string) => boolean): "allow" | "deny" {
  const fields = READ_TOOL_PATHS[tool];
  if (!fields) return "deny";
  for (const field of fields) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== "string") return "deny";
    // Glob 패턴은 저장소 기준 상대 패턴만: 위로 올라가는 조각이 있으면 밖을 가리킬 수 있다
    if (field === "pattern" && !/^(?:[A-Za-z]:)?[\\/]|^~/.test(v)) {
      if (v.split(/[\\/]/).includes("..")) return "deny";
      continue;
    }
    if (!inside(v)) return "deny";
  }
  return "allow";
}
