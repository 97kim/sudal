import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateTab,
  addWorkspace,
  closeTab,
  deleteTab,
  pruneEmptyClosedTabs,
  createTab,
  createWorkspace,
  tabCwd,
  tabsUsingPath,
  inheritedCwd,
  updateWorkspace,
  trimWorkspacePath,
  emptyModel,
  MAX_RECENT_TABS,
  nthOpenTab,
  recentGroup,
  recentTabs,
  removeWorkspace,
  reopenTab,
  reorderTabs,
  reorderWorkspaces,
  titleFromMessage,
  updateTab,
  workspaceTabs,
  worstStatus,
} from "./workspace-model";

const T0 = Date.UTC(2026, 8, 4, 3, 0, 0); // 2026-09-04 12:00 KST 근처

function seeded() {
  let m = emptyModel();
  const a = addWorkspace(m, "/repo/a/", T0, "wa");
  m = a.model;
  const b = addWorkspace(m, "/repo/b", T0 + 1, "wb");
  m = b.model;
  m = createTab(m, "wa", T0 + 10, "t1").model;
  m = createTab(m, "wa", T0 + 20, "t2").model;
  m = createTab(m, "wb", T0 + 30, "t3").model;
  return m;
}

test("addWorkspace: 끝 슬래시 정규화, 같은 경로는 lastUsedAt 만 갱신", () => {
  const m = seeded();
  assert.equal(m.workspaces[0].path, "/repo/a");
  assert.equal(m.workspaces[0].name, "a");
  const again = addWorkspace(m, "/repo/a", T0 + 999, "ignored");
  assert.equal(again.model.workspaces.length, 2);
  assert.equal(again.workspace.id, "wa");
  assert.equal(again.workspace.lastUsedAt, T0 + 999);
});

test("addWorkspace: Windows 경로는 끝 구분자·대소문자·구분자 종류가 달라도 같은 워크스페이스", () => {
  let m = addWorkspace(seeded(), "C:\\Users\\me\\repo\\", T0, "ww").model;
  const w = m.workspaces.find((x) => x.id === "ww")!;
  assert.equal(w.path, "C:\\Users\\me\\repo");
  assert.equal(w.name, "repo");
  const again = addWorkspace(m, "c:/users/me/Repo", T0 + 5, "ignored");
  assert.equal(again.workspace.id, "ww");
  m = again.model;
  assert.equal(addWorkspace(m, "/repo/A", T0, "wz").workspace.id, "wz", "macOS 경로는 글자 그대로 비교한다");
  assert.equal(trimWorkspacePath("D:\\"), "D:\\");
  assert.equal(trimWorkspacePath("/repo/a//"), "/repo/a");
});

test("createTab: 열린 탭 목록 끝에 추가되고 활성화, 워크스페이스 lastUsedAt 갱신", () => {
  const m = seeded();
  assert.deepEqual(m.openTabIds, ["t1", "t2", "t3"]);
  assert.equal(m.activeTabId, "t3");
  assert.equal(m.workspaces.find((w) => w.id === "wb")?.lastUsedAt, T0 + 30);
  assert.equal(m.tabs[0].provider, "claude");
  assert.equal(m.tabs[0].policy, "ask");
});

test("closeTab: 활성 탭을 닫으면 오른쪽 이웃, 없으면 왼쭉 이웃이 활성", () => {
  let m = activateTab(seeded(), "t2");
  // t2 는 메시지를 보낸 탭(제목 있음) → 닫아도 "최근" 에 남는다.
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t2" ? { ...t, title: "질문" } : t)) };
  m = closeTab(m, "t2", T0 + 100);
  assert.deepEqual(m.openTabIds, ["t1", "t3"]);
  assert.equal(m.activeTabId, "t3");
  assert.equal(m.tabs.find((t) => t.id === "t2")?.open, false);
  m = closeTab(m, "t3", T0 + 101);
  assert.equal(m.activeTabId, "t1");
  m = closeTab(m, "t1", T0 + 102);
  assert.equal(m.activeTabId, null);
  assert.deepEqual(m.openTabIds, []);
});

test("closeTab: 비활성 탭을 닫아도 활성 탭은 유지", () => {
  const m = closeTab(seeded(), "t1", T0 + 100);
  assert.equal(m.activeTabId, "t3");
});

test("pruneEmptyClosedTabs: 닫힌 빈 탭만 제거, 없으면 같은 객체", () => {
  let m = seeded();
  assert.equal(pruneEmptyClosedTabs(m), m);
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t1" ? { ...t, open: false } : t.id === "t2" ? { ...t, open: false, title: "q" } : t)) };
  const pruned = pruneEmptyClosedTabs(m);
  assert.deepEqual(pruned.tabs.map((t) => t.id), ["t2", "t3"]);
});

test("closeTab: 메시지를 보낸 적 없는 탭(제목·세션 없음)은 최근에 남기지 않고 버린다", () => {
  let m = seeded();
  m = closeTab(m, "t1", T0 + 100);
  assert.equal(m.tabs.find((t) => t.id === "t1"), undefined);
  // sessionId 만 있어도(제목 없이 provider 세션이 생긴 경우) 남긴다.
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t2" ? { ...t, sessionId: "s2" } : t)) };
  m = closeTab(m, "t2", T0 + 101);
  assert.equal(m.tabs.find((t) => t.id === "t2")?.open, false);
});

test("reopenTab: 닫힌 탭을 다시 열고 활성화, 이미 열린 탭이면 활성화만", () => {
  let m = seeded();
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t1" ? { ...t, title: "질문" } : t)) };
  m = closeTab(m, "t1", T0 + 100);
  m = reopenTab(m, "t1", T0 + 200);
  assert.deepEqual(m.openTabIds, ["t2", "t3", "t1"]);
  assert.equal(m.activeTabId, "t1");
  m = reopenTab(m, "t2", T0 + 300);
  assert.deepEqual(m.openTabIds, ["t2", "t3", "t1"]);
  assert.equal(m.activeTabId, "t2");
});

test("removeWorkspace: 탭까지 제거하고 제거된 탭 id 를 돌려준다", () => {
  const { model, removedTabIds } = removeWorkspace(seeded(), "wa");
  assert.deepEqual(removedTabIds, ["t1", "t2"]);
  assert.deepEqual(model.openTabIds, ["t3"]);
  assert.equal(model.activeTabId, "t3");
  assert.equal(model.workspaces.length, 1);
});

test("removeWorkspace: 활성 탭이 지워지면 남은 첫 탭이 활성", () => {
  const { model } = removeWorkspace(seeded(), "wb");
  assert.equal(model.activeTabId, "t1");
});

test("updateTab / reorderTabs / nthOpenTab", () => {
  let m = updateTab(seeded(), "t1", { title: "제목", sessionId: "s" }, T0 + 500);
  const t1 = m.tabs.find((t) => t.id === "t1")!;
  assert.equal(t1.title, "제목");
  assert.equal(t1.sessionId, "s");
  assert.equal(t1.updatedAt, T0 + 500);
  m = reorderTabs(m, ["t3", "t1"]);
  assert.deepEqual(m.openTabIds, ["t3", "t1", "t2"]);
  assert.equal(nthOpenTab(m, 2), "t1");
  assert.equal(nthOpenTab(m, 9), null);
});

test("닫힌 탭은 MAX_RECENT_TABS 개까지만 보관", () => {
  let m = emptyModel();
  m = addWorkspace(m, "/r", T0, "w").model;
  for (let i = 0; i < MAX_RECENT_TABS + 5; i++) {
    m = createTab(m, "w", T0 + i, `t${i}`).model;
    // 메시지를 보낸 탭만 "최근" 에 남으므로 제목을 붙여 둔다.
    m = { ...m, tabs: m.tabs.map((t) => (t.id === `t${i}` ? { ...t, title: `q${i}` } : t)) };
    m = closeTab(m, `t${i}`, T0 + i);
  }
  m = createTab(m, "w", T0 + 1000, "last").model;
  assert.equal(m.tabs.filter((t) => !t.open).length, MAX_RECENT_TABS);
  assert.ok(!m.tabs.some((t) => t.id === "t0"));
  assert.ok(m.tabs.some((t) => t.id === `t${MAX_RECENT_TABS + 4}`));
});

test("titleFromMessage: 첫 비공백 줄, 60자 컷", () => {
  assert.equal(titleFromMessage("\n\n  버그  고쳐줘 \n둘째줄"), "버그 고쳐줘");
  assert.equal(titleFromMessage("가".repeat(70)).length, 61);
});

test("recentGroup / recentTabs", () => {
  const now = new Date(2026, 8, 4, 15, 0, 0).getTime();
  const today = new Date(2026, 8, 4, 1, 0, 0).getTime();
  const yesterday = new Date(2026, 8, 3, 23, 0, 0).getTime();
  const fiveDays = new Date(2026, 7, 30, 12, 0, 0).getTime();
  const old = new Date(2026, 7, 20, 12, 0, 0).getTime();
  assert.equal(recentGroup(today, now), "today");
  assert.equal(recentGroup(yesterday, now), "yesterday");
  assert.equal(recentGroup(fiveDays, now), "week");
  assert.equal(recentGroup(old, now), "older");

  let m = emptyModel();
  m = addWorkspace(m, "/r", old, "w").model;
  m = createTab(m, "w", old, "a").model;
  m = createTab(m, "w", today, "b").model;
  const r = recentTabs(m, now);
  assert.deepEqual(
    r.map((e) => [e.tab.id, e.group, e.workspace?.name]),
    [
      ["b", "today", "r"],
      ["a", "older", "r"],
    ],
  );
});

test("worstStatus 우선순위", () => {
  assert.equal(worstStatus(["idle", "running"]), "running");
  assert.equal(worstStatus(["running", "waiting_permission"]), "waiting_permission");
  assert.equal(worstStatus(["queued", "idle"]), "queued");
  assert.equal(worstStatus([]), "idle");
});

test("deleteTab: 열린 활성 탭을 지우면 이웃이 활성되고 목록에서도 사라진다, 닫힌 탭도 지워진다", () => {
  let m = activateTab(seeded(), "t2");
  m = deleteTab(m, "t2", T0 + 100);
  assert.deepEqual(m.openTabIds, ["t1", "t3"]);
  assert.equal(m.activeTabId, "t3");
  assert.equal(m.tabs.some((t) => t.id === "t2"), false);
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t1" ? { ...t, title: "질문" } : t)) };
  m = closeTab(m, "t1", T0 + 101);
  assert.equal(m.tabs.find((t) => t.id === "t1")?.open, false);
  m = deleteTab(m, "t1", T0 + 102);
  assert.equal(m.tabs.some((t) => t.id === "t1"), false);
  assert.equal(deleteTab(m, "nope", T0), m);
});

test("workspaceTabs: 열린 탭은 탭바 순서, 닫힌 탭은 최근 순으로 뒤에, 다른 워크스페이스는 제외", () => {
  let m = seeded();
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t1" ? { ...t, title: "a" } : t)) };
  m = closeTab(m, "t1", T0 + 500);
  m = reorderTabs(m, ["t3", "t2"]);
  const ids = workspaceTabs(m, "wa").map((t) => t.id);
  assert.deepEqual(ids.filter((id) => ["t1", "t2", "t3"].includes(id)), ids); // wa 소속만
  assert.equal(ids[ids.length - 1], "t1"); // 닫힌 탭이 맨 뒤
  assert.equal(ids.indexOf("t3") < ids.indexOf("t2"), true); // 탭바 순서
  assert.deepEqual(workspaceTabs(m, "nope"), []);
});

test("createWorkspace/updateWorkspace/tabCwd: 이름만으로 만들고, 탭 경로 → 기본 경로 → 없음 순으로 해석", () => {
  let m = emptyModel();
  const c = createWorkspace(m, "  결제 개편 ", T0, "w1");
  m = c.model;
  assert.equal(c.workspace.name, "결제 개편");
  assert.equal(c.workspace.path, "");
  const t = createTab(m, "w1", T0 + 1, "t1");
  m = t.model;
  assert.equal(tabCwd(m, t.tab), null);
  m = updateWorkspace(m, "w1", { path: "/repo/pay/" });
  assert.equal(tabCwd(m, m.tabs[0]), "/repo/pay");
  m = updateTab(m, "t1", { cwd: "/repo/other" }, T0 + 2);
  assert.equal(tabCwd(m, m.tabs[0]), "/repo/other");
  m = updateWorkspace(m, "w1", { name: "   " });
  assert.equal(m.workspaces[0].name, "결제 개편"); // 빈 이름은 무시
  assert.equal(updateWorkspace(m, "nope", { name: "x" }), m);
});

test("reorderWorkspaces: 끌어 옮긴 순서대로, 빠진 것은 뒤에", () => {
  let m = emptyModel();
  m = addWorkspace(m, "/a", 1, "wa").model;
  m = addWorkspace(m, "/b", 2, "wb").model;
  m = addWorkspace(m, "/c", 3, "wc").model;
  const ids = () => m.workspaces.map((w) => w.id);
  assert.deepEqual(ids(), ["wa", "wb", "wc"]);

  m = reorderWorkspaces(m, ["wc", "wa", "wb"]);
  assert.deepEqual(ids(), ["wc", "wa", "wb"]);

  // 낡은 요청: 모르는 id 는 무시하고, 안 적힌 것은 원래 순서를 지켜 뒤에 붙인다
  m = reorderWorkspaces(m, ["없는id", "wb"]);
  assert.deepEqual(ids(), ["wb", "wc", "wa"]);

  // 빈 요청이면 그대로
  m = reorderWorkspaces(m, []);
  assert.deepEqual(ids(), ["wb", "wc", "wa"]);
});

test("inheritedCwd: 같은 워크스페이스면 활성 탭 경로, 다른 워크스페이스면 그쪽 기본 경로나 최근 탭 경로", () => {
  let m = emptyModel();
  m = createWorkspace(m, "A", T0, "wa").model;
  m = createWorkspace(m, "B", T0 + 1, "wb").model;
  m = createTab(m, "wa", T0 + 10, "a1", { cwd: "/repo/a-old" }).model;
  m = createTab(m, "wa", T0 + 20, "a2", { cwd: "/repo/a" }).model;
  m = updateTab(m, "a2", { worktree: undefined }, T0 + 30);
  m = createTab(m, "wa", T0 + 40, "a3", { cwd: "/wt/a-branch" }).model;
  m = updateTab(m, "a3", { worktree: { path: "/wt/a-branch", repo: "/repo/a", branch: "x", base: "main" } as never }, T0 + 50);
  m = createTab(m, "wb", T0 + 60, "b1", { cwd: "/repo/b" }).model;

  assert.equal(inheritedCwd(m, "wb", "b1"), "/repo/b", "같은 워크스페이스면 활성 탭 경로");
  assert.equal(inheritedCwd(m, "wa", "b1"), "/repo/a", "B 탭에서 A 새 탭: A 의 최근 탭 경로(worktree 탭은 건너뜀)");
  assert.equal(inheritedCwd(m, "wa", null), "/repo/a", "활성 탭이 없어도 같다");
  m = createWorkspace(m, "C", T0 + 70, "wc").model;
  assert.equal(inheritedCwd(m, "wc", "b1"), undefined, "쓴 탭이 없으면 비운다");
  const withPath = addWorkspace(m, "/repo/d", T0 + 80, "wd");
  m = createTab(withPath.model, "wd", T0 + 90, "d1", { cwd: "/elsewhere" }).model;
  assert.equal(inheritedCwd(m, "wd", "b1"), undefined, "기본 경로가 있으면 그걸 따르게 비운다");
});

test("tabsUsingPath: worktree 정보가 없는 분기 탭도 같은 경로면 쓰는 탭이고, 열린 탭이 앞에 온다", () => {
  const WT = "/wt/repo/feat";
  let m = seeded();
  m = { ...m, tabs: m.tabs.map((t) => (t.id === "t1" ? { ...t, cwd: WT, worktree: { repo: "/repo/a", path: WT, branch: "sudal/feat", base: "main" }, open: false } : t.id === "t2" ? { ...t, cwd: WT } : t)) };
  const users = tabsUsingPath(m, WT);
  assert.deepEqual(users.map((t) => t.id), ["t2", "t1"], "닫힌 원본(t1)보다 열린 분기 탭(t2)이 먼저");
  assert.equal(users.filter((t) => t.open !== false).length, 1);
  assert.deepEqual(tabsUsingPath(m, "/elsewhere"), []);
});
