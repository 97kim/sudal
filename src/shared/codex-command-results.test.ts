import { test } from "node:test";
import assert from "node:assert/strict";
import { codexHooks, codexMcpServers, codexMemory, codexPlugins, codexResultErrorMessage, codexSessionInfo, codexTerminals, codexUsageGroups } from "./codex-command-results";

test("세션 표시는 로컬 상태와 중첩된 native 스레드 정보를 함께 읽는다", () => {
  const info = codexSessionInfo({ session: { sessionId: "live", model: "chosen", status: "running", policy: "ask", pendingPrompts: [] }, thread: { thread: { id: "stored", model: "old", cwd: "C:/repo", gitInfo: { branch: "main" } } } });
  assert.equal(info.id, "live"); assert.equal(info.model, "chosen"); assert.equal(info.branch, "main"); assert.equal(info.pending, 0);
  assert.equal(codexSessionInfo({}).pending, null);
  assert.equal(codexSessionInfo({}).status, null);
});

test("터미널의 자원 사용량 미제공과 실제 0을 구분한다", () => {
  const result = codexTerminals({ data: [{ processId: "p1", command: "node job.js", cpuPercent: 0, rssKb: 1024 }, { processId: "p2", command: "worker", cpuPercent: null, rssKb: null }] });
  assert.equal(result.items[0].cpu, 0); assert.equal(result.items[0].rssKb, 1024);
  assert.equal(result.items[1].cpu, null); assert.equal(result.items[1].rssKb, null);
  assert.equal(codexTerminals({}).available, false);
  assert.equal(codexTerminals({ data: [] }).available, true);
});

test("훅 조회의 경고·오류와 활성·신뢰 상태를 보존한다", () => {
  const result = codexHooks({ data: [{ cwd: "repo", warnings: ["warning"], errors: [{ path: "hooks.json", message: "invalid" }], hooks: [{ key: "hook", eventName: "SessionStart", enabled: false, trustStatus: "modified", matcher: "startup", handlerType: "command", command: "echo hello", sourcePath: "hooks.json" }] }] });
  assert.equal(result.messages.length, 2); assert.equal(result.messages[1].error, true);
  assert.equal(result.items[0].enabled, false); assert.equal(result.items[0].trust, "modified");
  assert.equal(codexHooks({ data: [{ hooks: [{ eventName: "Stop" }] }] }).items[0].enabled, null);
});

test("미설치·관리자 차단 플러그인을 활성 상태로 표시하지 않는다", () => {
  const result = codexPlugins({ marketplaces: [{ name: "Catalog", plugins: [
    { id: "new", name: "Not installed", installed: false, enabled: true },
    { id: "blocked", name: "Blocked", installed: true, enabled: true, availability: "DISABLED_BY_ADMIN" },
    { id: "active", name: "Active", installed: true, enabled: true, interface: { displayName: "Friendly", shortDescription: "Description" } },
    { id: "unknown", name: "Unknown" },
  ] }], marketplaceLoadErrors: [{ marketplacePath: "catalog.json", message: "Read failed" }] });
  assert.deepEqual(result.items.map(row => row.state), ["notInstalled", "unavailable", "enabled", "unknown"]);
  assert.equal(result.items[2].name, "Friendly"); assert.equal(result.errors[0].text, "Read failed");
});

test("메모리 요약이 없다는 이유만으로 메모리가 꺼졌다고 판단하지 않는다", () => {
  assert.deepEqual(codexMemory({ summary: null }), { available: true, summary: null, mode: null });
  assert.equal(codexMemory({}).available, false);
  assert.equal(codexMemory({ mode: "disabled" }).mode, "disabled");
});

test("조회 실패는 내부 IPC 경로 대신 실제 오류 내용을 표시한다", () => {
  assert.equal(codexResultErrorMessage(new Error("Error invoking remote method 'chat:codex-control': Error: Request timed out")), "Request timed out");
  assert.equal(codexResultErrorMessage(new Error("Authentication required")), "Authentication required");
});

test("usage는 최신 복수 한도를 사용하고 중복된 구형 스냅샷을 표시하지 않는다", () => {
  const value = codexUsageGroups({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { limitName: "Codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1800000000 }, credits: { hasCredits: true, unlimited: false, balance: "0" } },
    fast: { limitName: "Fast", primary: { usedPercent: 85, windowDurationMins: 60 } },
  } });
  assert.equal(value.groups.length, 2);
  assert.equal(value.ordinaryUsageAllowed, false);
  assert.equal(value.groups[0].windows[0].usedPercent, 0);
  assert.equal(value.groups[0].windows[0].resetsAt, null);
  assert.equal(value.groups[0].windows[1].minutes, 10080);
  assert.equal(value.groups[0].credits?.balance, "0");
});

test("usage는 구형 응답도 지원하며 누락된 한도를 0%로 만들지 않는다", () => {
  const legacy = codexUsageGroups({ rateLimits: { primary: { usedPercent: 150, windowDurationMins: 0, resetsAt: Infinity }, secondary: { usedPercent: NaN } } });
  assert.deepEqual(legacy.groups[0].windows, [{ kind: "primary", usedPercent: 100, minutes: null, resetsAt: null }]);
  assert.equal(legacy.ordinaryUsageAllowed, null);
  assert.equal(codexUsageGroups({ rateLimits: { primary: null } }).groups[0].windows.length, 0);
  assert.deepEqual(codexUsageGroups(null).groups, []);
});

test("MCP는 연결 상태와 인증 상태를 구분하고 캐시된 도구로 연결을 추측하지 않는다", () => {
  const servers = codexMcpServers([
    { name: "cached", authStatus: "oAuth", tools: { key: { name: "read", title: "Read files", description: "Read a file", inputSchema: { secret: "not needed in UI" } } } },
    { name: "failed", runtimeStatus: "failed", authStatus: "notLoggedIn", tools: {}, toolsError: "Authentication failed" },
    { name: "ready", runtimeStatus: "connected", httpOrigin: "https://user:password@example.com/private?token=secret", serverInfo: { version: "1.2" }, tools: {} },
    { name: "future", runtimeStatus: "new-status", tools: {} },
  ]);
  assert.equal(servers[0].status, "unknown");
  assert.equal(servers[0].auth, "oAuth");
  assert.deepEqual(servers[0].tools, [{ name: "read", title: "Read files", description: "Read a file" }]);
  assert.equal(servers[1].status, "failed");
  assert.equal(servers[1].toolsError, "Authentication failed");
  assert.equal(servers[2].origin, "https://example.com");
  assert.equal(servers[3].status, "unknown");
  assert.deepEqual(codexMcpServers([null, {}, { name: "" }]), []);
});
