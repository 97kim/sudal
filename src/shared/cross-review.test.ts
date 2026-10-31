import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, CROSS_REVIEW_DIFF_MAX, otherProvider, validateReviewRequest, reviewPermissionDecision, reviewScopeParams, reviewTabTitle } from "./cross-review";
import { createI18n } from "./i18n";
const { t } = createI18n("ko");

test("교차 리뷰 요청: 세 CLI와 같은 CLI를 명시할 수 있고 모델은 공백을 정리한다", () => {
  for (const author of ["claude", "codex", "agy"] as const) {
    for (const provider of ["claude", "codex", "agy"] as const) {
      assert.deepEqual(validateReviewRequest(t, { provider, model: " custom-model " }, author), { ok: true, provider, model: "custom-model" });
      assert.deepEqual(validateReviewRequest(t, { provider, model: "  " }, author), { ok: true, provider });
    }
    assert.deepEqual(validateReviewRequest(t, undefined, author), { ok: true, provider: otherProvider(author) });
  }
  for (const request of [null, [], "agy", {}, { provider: "unknown" }, { provider: "codex", model: 1 }, { provider: "agy", model: null }]) {
    assert.equal(validateReviewRequest(t, request, "claude").ok, false, JSON.stringify(request));
  }
});

test("cross-review: 상대 provider·제목·범위·프롬프트(긴 diff 는 자른다)", () => {
  assert.equal(otherProvider("claude"), "codex");
  assert.equal(otherProvider("codex"), "claude");
  assert.equal(reviewTabTitle(t, "auth 버그"), "교차 리뷰 · auth 버그");
  assert.equal(t("main.msg.reviewScope", reviewScopeParams([{ path: "a", added: 40, deleted: 2 }, { path: "b", added: 2, deleted: 5 }])), "2개 파일 · +42 −7");
  const p = buildReviewPrompt(t, { originTitle: "auth 버그", author: "claude", changes: [{ path: "src/a.ts", kind: "modified" }], diff: "diff --git a/src/a.ts\n+x" });
  assert.match(p, /Claude Code 와 함께 작업한 "auth 버그"/);
  assert.match(p, /수정과 쓰기 명령은 물론, 테스트·빌드·스크립트 실행/);
  assert.match(p, /- src\/a\.ts \(modified\)/);
  assert.match(p, /```diff\ndiff --git a\/src\/a\.ts\n\+x\n```$/);
  const long = buildReviewPrompt(t, { originTitle: "t", author: "codex", changes: [], diff: "x".repeat(CROSS_REVIEW_DIFF_MAX + 10) });
  assert.match(long, /10자 생략/);
});

test("reviewPermissionDecision: 저장소 안을 읽는 도구만 allow, 셸·웹·하위 에이전트·쓰기는 모두 deny", () => {
  const inside = (p: string) => !p.startsWith("/") || p.startsWith("/repo/");
  assert.equal(reviewPermissionDecision("Read", { file_path: "/repo/a.ts" }, inside), "allow");
  assert.equal(reviewPermissionDecision("Grep", {}, inside), "allow", "경로가 없으면 저장소 기준");
  // 저장소 밖 읽기는 거부 — ~/.ssh 같은 비밀 파일을 읽어 넘길 수 있다
  assert.equal(reviewPermissionDecision("Read", { file_path: "/Users/me/.ssh/id_ed25519" }, inside), "deny");
  assert.equal(reviewPermissionDecision("Grep", { path: "/etc" }, inside), "deny");
  // Glob 은 패턴을 펼치기 전에 저장소 밖인지 알 수 없어 늘 거부
  for (const pattern of ["src/**/*.ts", "{../..,src}/*", "outside-link/*", "/Users/me/.aws/*"])
    assert.equal(reviewPermissionDecision("Glob", { pattern }, inside), "deny", pattern);
  assert.equal(reviewPermissionDecision("Read", { file_path: "/repo/app/[id]/page.tsx" }, inside), "allow", "괄호가 든 실제 파일명");
  assert.equal(reviewPermissionDecision("Read", { file_path: 42 }, inside), "deny");
  // 셸은 읽기처럼 보여도 거부 — 리뷰가 찾은 우회들
  for (const cmd of ["git diff HEAD -- src", "rg --pre=./evil.sh foo", "git grep -O'touch x' foo", "awk 'BEGIN{\"id\" | getline}'", "sort --compress-program=sh x", "GIT_EXTERNAL_DIFF=./evil.sh git diff"])
    assert.equal(reviewPermissionDecision("Bash", { command: cmd }, inside), "deny", cmd);
  assert.equal(reviewPermissionDecision("exec", { command: ["git", "diff"] }, inside), "deny");
  for (const tool of ["WebFetch", "WebSearch", "Task", "Agent", "Edit", "Write", "ApplyPatch", "권한"])
    assert.equal(reviewPermissionDecision(tool, {}, inside), "deny", tool);
});
