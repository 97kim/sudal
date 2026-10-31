import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import type { Provider } from "@shared/ipc";
import { createI18n } from "@shared/i18n";
import { buildReviewPrompt, validateReviewRequest, reviewPermissionDecision, reviewScopeParams, reviewTabTitle } from "@shared/cross-review";
import { lastReplyText } from "@shared/session-state";

// 실제 시작 함수와 IPC 핸들러를 실행하되 CLI·파일·세션만 대체한다. 외부 모델을 호출하지 않는다.
const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const startCode = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "startCrossReview")!.getText(source);
let ipcCode = "";
function visit(node: ts.Node) {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "ipcMain.handle" && node.expression.arguments[0]?.getText(source) === "IPC.chatCrossReview") ipcCode = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(ipcCode);

function harness(author: Provider, missing?: Provider) {
  const configured: { tabId: string; provider: Provider; model?: string; policy: string; cwd: string }[] = [];
  const notes: { reviewer: Provider; status: string; text: string }[] = [];
  const sent: { tabId: string; text: string }[] = [];
  const model: { activeTabId: string | null } = { activeTabId: "origin" };
  let created = 0, gitReads = 0;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const events: unknown[] = [];
  const { t } = createI18n("ko");
  const ctx = createContext({
    mt: t, buildReviewPrompt, validateReviewRequest, reviewPermissionDecision, reviewScopeParams, reviewTabTitle, lastReplyText,
    Date, console, setTimeout: (fn: () => void) => queueMicrotask(fn),
    workspaces: {
      tab: () => ({ id: "origin", workspaceId: "workspace" }),
      state: () => ({ model }),
      createTab: (ws: string) => { assert.equal(ws, "workspace"); created++; model.activeTabId = "review"; return "review"; },
      renameTab: () => {}, activateTab: (id: string) => { model.activeTabId = id; },
    },
    sessions: {
      snapshot: (id: string) => id === "origin" ? { provider: author, cwd: "/repo" } : { status: "idle", limitWait: null },
      configure: (tabId: string, config: typeof configured[number]) => configured.push({ ...config, tabId }),
      note: (_id: string, note: typeof notes[number]) => { notes.push(note); if (note.status === "done" || note.status === "failed") finish(); },
      events: () => events, pendingPermissions: () => [],
    },
    cliDiscovery: () => ({
      find: async (provider: Provider) => ({ installed: provider !== missing, path: provider === missing ? null : `/${provider}`, error: provider === missing ? "CLI missing" : undefined }),
      buildEnv: async () => ({}),
    }),
    gitChanges: async () => { gitReads++; return [{ path: "src/example.ts", kind: "modified", added: 1, deleted: 0 }]; },
    gitDiffFor: async () => "+changed", tabTitleOf: () => "원래 작업",
    handleChatSend: async (tabId: string, payload: { text: string }) => {
      sent.push({ tabId, ...payload });
      events.push({ type: "assistant_text", ts: 1, blockId: "answer", text: "리뷰 결과" }, {
        type: "turn_result", ts: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        modelUsage: {}, costUsd: 0, durationMs: 1, numTurns: 1, isError: false,
      });
      return { ok: true };
    },
    realpathSync: (path: string) => path, resolve: (path: string) => path, homedir: () => "/home", isWithin: () => true,
    IPC: { chatCrossReview: "cross-review" }, ipcMain: { handle: (_channel: string, fn: unknown) => { ctx.handler = fn; } },
  });
  runInContext(ts.transpileModule(`${startCode}\n${ipcCode}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return {
    run: (request?: unknown) => ctx.handler(null, "origin", request) as Promise<{ ok: boolean; error?: string }>,
    configured, notes, sent, completed, model,
    created: () => created, gitReads: () => gitReads,
  };
}

for (const author of ["claude", "codex", "agy"] as const) {
  test(`교차 리뷰 IPC: ${author}에서 선택한 세 CLI·모델로 새 탭을 열고 결과 카드를 돌려준다`, async () => {
    for (const provider of ["claude", "codex", "agy"] as const) {
      const h = harness(author);
      assert.equal((await h.run({ provider, model: " review-model " })).ok, true);
      await h.completed;
      assert.equal(h.created(), 1);
      assert.deepEqual(h.configured, [{ tabId: "review", cwd: "/repo", provider, policy: "ask", model: "review-model" }]);
      assert.equal(h.model.activeTabId, "origin");
      assert.deepEqual(h.notes.map((n) => ({ provider: n.reviewer, status: n.status })), [{ provider, status: "requested" }, { provider, status: "done" }]);
      assert.equal(h.notes.at(-1)?.text, "리뷰 결과");
      assert.equal(h.sent[0].tabId, "review");
      assert.match(h.sent[0].text, /\+changed/);
    }
  });
}

test("교차 리뷰 기본 모델은 원래 탭에서 상속하지 않고 비우며 기존 무인자 호출을 유지한다", async () => {
  const h = harness("claude");
  assert.equal((await h.run()).ok, true);
  await h.completed;
  assert.equal(h.configured[0].provider, "codex");
  assert.equal(Object.hasOwn(h.configured[0], "model"), true);
  assert.equal(h.configured[0].model, undefined);
});

test("교차 리뷰: 잘못된 선택·미설치 CLI는 diff를 읽거나 탭을 만들기 전에 거절한다", async () => {
  for (const request of [null, {}, { provider: "wrong" }, { provider: "agy", model: [] }, { provider: "agy" }]) {
    const h = harness("codex", "agy");
    assert.equal((await h.run(request)).ok, false);
    assert.equal(h.created(), 0);
    assert.equal(h.gitReads(), 0);
    assert.equal(h.notes.length, 0);
  }
});
