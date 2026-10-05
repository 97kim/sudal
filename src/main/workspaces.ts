// 워크스페이스/탭 모델의 소유자. 순수 함수(shared/workspace-model)로 바꾸고 → 저장 → 브로드캐스트.
// SessionManager 와는 콜백으로만 엮인다 (resolveConfig / onMeta / onStatus).

import { randomUUID } from "node:crypto";
import type { PermissionPolicy, SessionStatus } from "@shared/chat-events";
import type { Provider, WorkspaceStateDto } from "@shared/ipc";
import {
  activateTab,
  activeWorkspace,
  addWorkspace,
  closeTab,
  deleteTab,
  pruneEmptyClosedTabs,
  createTab,
  createWorkspace,
  tabCwd,
  inheritedCwd,
  updateWorkspace,
  nthOpenTab,
  removeWorkspace,
  reopenTab,
  reorderTabs,
  reorderWorkspaces,
  titleFromMessage,
  updateTab,
  type WorkspaceModel,
  type Workspace,
  type WorktreeMeta,
  type TabMeta,
} from "@shared/workspace-model";
import type { Store } from "./persistence";
import type { SessionConfig, SessionManager } from "./session-manager";
import type { NewTabPolicy } from "@shared/ipc";

export class WorkspaceService {
  private model: WorkspaceModel;
  private sessions: SessionManager | null = null;

  constructor(
    private readonly store: Store,
    private readonly broadcast: (state: WorkspaceStateDto) => void,
  ) {
    this.model = store.loadModel();
    // 이전 버전이 남긴 빈 "새 세션"(닫힘 + 제목·세션 없음) 정리
    const pruned = pruneEmptyClosedTabs(this.model);
    if (pruned !== this.model) {
      this.model = pruned;
      store.saveModel(this.model);
    }
  }

  attach(sessions: SessionManager) {
    this.sessions = sessions;
  }

  /** 응답 필요 표시(AttentionTracker)를 상태에 함께 싣는다. attach 순서 때문에 getter 로 받는다. */
  attentionSource: (() => WorkspaceStateDto["attention"]) | null = null;
  /** 설정의 "새 탭 권한". inherit 면 새 탭을 열 때 보고 있던 탭을 따른다. */
  newTabPolicy: () => NewTabPolicy = () => "inherit";
  private fixedNewTabPolicy(): PermissionPolicy | undefined {
    const p = this.newTabPolicy();
    return p === "inherit" ? undefined : p;
  }

  /** 탭을 봤다(활성화) / 탭이 사라졌다 → AttentionTracker 에 알린다. */
  attentionHooks: { viewed(tabId: string): void; forget(tabId: string): void } | null = null;

  state(): WorkspaceStateDto {
    return {
      model: this.model,
      statuses: this.sessions?.statuses() ?? {},
      attention: this.attentionSource?.() ?? {},
    };
  }

  /** 응답 필요 표시가 바뀌었을 때 상태를 다시 뿌린다. */
  onAttention() {
    this.broadcast(this.state());
  }

  /** 모든 탭의 cwd 와 워크스페이스 경로. 렌더러가 보낸 cwd 가 실제 세션의 것인지 확인할 때 쓴다. */
  knownCwds(): Set<string> {
    const out = new Set<string>();
    for (const w of this.model.workspaces) if (w.path) out.add(w.path);
    for (const t of this.model.tabs) {
      const c = tabCwd(this.model, t);
      if (c) out.add(c);
    }
    return out;
  }

  /** SessionManager 가 모르는 탭을 만났을 때 설정을 준다. */
  resolveConfig(tabId: string): SessionConfig | null {
    const tab = this.model.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    return {
      provider: tab.provider,
      cwd: tabCwd(this.model, tab),
      policy: tab.policy,
      model: tab.model,
      sessionId: tab.sessionId,
    };
  }

  onMeta(
    tabId: string,
    patch: { title?: string; sessionId?: string | null; provider?: Provider; model?: string; policy?: PermissionPolicy; cwd?: string | null },
  ) {
    const p: Parameters<typeof updateTab>[2] = {};
    if (patch.cwd !== undefined) p.cwd = patch.cwd ?? undefined;
    const custom = this.model.tabs.find((t) => t.id === tabId)?.titleCustom === true;
    if (patch.title !== undefined && !custom) p.title = patch.title ? titleFromMessage(patch.title) : null;
    if (patch.sessionId !== undefined) p.sessionId = patch.sessionId;
    if (patch.provider) p.provider = patch.provider;
    if ("model" in patch) p.model = patch.model;
    if (patch.policy) p.policy = patch.policy;
    this.commit(updateTab(this.model, tabId, p, Date.now()));
  }

  onStatus(_tabId: string, _status: SessionStatus) {
    this.broadcast(this.state());
  }

  // ===== mutations =====

  addWorkspace(path: string): { workspaceId: string; tabId: string } {
    const now = Date.now();
    const { model, workspace } = addWorkspace(this.model, path, now, randomUUID());
    // 워크스페이스를 추가하면 바로 쓸 수 있게 탭을 하나 연다.
    const open = model.tabs.find((t) => t.workspaceId === workspace.id && t.open);
    if (open) {
      this.commit(activateTab(model, open.id));
      return { workspaceId: workspace.id, tabId: open.id };
    }
    const created = createTab(model, workspace.id, now, randomUUID(), { policy: this.fixedNewTabPolicy() });
    this.commit(created.model);
    return { workspaceId: workspace.id, tabId: created.tab.id };
  }

  /** 이름만으로 워크스페이스를 만들고 빈 탭을 하나 연다. 작업 경로는 탭에서 정한다. */
  createWorkspace(name: string, builtin?: Workspace["builtin"]): { workspaceId: string; tabId: string } {
    const now = Date.now();
    const { model, workspace } = createWorkspace(this.model, name, now, randomUUID(), builtin);
    const created = createTab(model, workspace.id, now, randomUUID(), { policy: this.fixedNewTabPolicy() });
    this.commit(created.model);
    return { workspaceId: workspace.id, tabId: created.tab.id };
  }

  updateWorkspace(workspaceId: string, patch: { name?: string; path?: string; verifyCommands?: string[]; builtin?: Workspace["builtin"] }) {
    const before = this.model.workspaces.find((w) => w.id === workspaceId)?.path;
    this.commit(updateWorkspace(this.model, workspaceId, patch));
    const after = this.model.workspaces.find((w) => w.id === workspaceId)?.path;
    if (before === after || after === undefined) return;
    // 기본 경로를 물려받는 탭은 이미 떠 있는 세션도 새 경로에서 돌아야 한다. 자기 경로가 있는 탭은 그대로.
    for (const t of this.model.tabs)
      if (t.workspaceId === workspaceId && !t.cwd) this.sessions?.inheritCwd(t.id, after || null);
  }

  removeWorkspace(workspaceId: string) {
    const { model, removedTabIds } = removeWorkspace(this.model, workspaceId);
    for (const id of removedTabIds) {
      this.sessions?.release(id);
      this.store.deleteThread(id);
      this.attentionHooks?.forget(id);
    }
    this.commit(model);
  }

  createTab(workspaceId?: string, extra?: { cwd: string; worktree?: WorktreeMeta; title?: string }): string | null {
    const ws = workspaceId
      ? this.model.workspaces.find((w) => w.id === workspaceId)
      : activeWorkspace(this.model);
    if (!ws) return null;
    // 새 탭은 활성 탭의 provider/모델을 이어받는다. 정책은 설정이 정해 두었으면 그것, 아니면 활성 탭을 따른다.
    // 작업 경로는 inheritedCwd 가 정한다(다른 워크스페이스면 그쪽 최근 경로).
    const active = this.model.tabs.find((t) => t.id === this.model.activeTabId);
    const now = Date.now();
    const { model, tab } = createTab(this.model, ws.id, now, randomUUID(), {
      provider: active?.provider,
      model: active?.model,
      policy: this.fixedNewTabPolicy() ?? active?.policy,
      cwd: extra?.cwd ?? inheritedCwd(this.model, ws.id, this.model.activeTabId),
    });
    // 격리 세션이면 worktree 정보와 브랜치 이름 제목을 함께 저장한다.
    // worktree 없이 경로만 준 경우(예약처럼 활성 탭을 따라가면 안 되는 경우)도 있다.
    const withWt = extra
      ? updateTab(
          model,
          tab.id,
          {
            ...(extra.worktree ? { worktree: extra.worktree } : {}),
            ...(extra.title || extra.worktree ? { title: extra.title ?? extra.worktree!.branch, titleCustom: true } : {}),
          },
          now,
        )
      : model;
    this.commit(withWt);
    return tab.id;
  }

  closeTab(tabId: string) {
    this.attentionHooks?.forget(tabId);
    this.sessions?.release(tabId);
    this.commit(closeTab(this.model, tabId, Date.now()));
    // 빈 탭은 모델에서 버려지므로 스레드 파일도 같이 지운다.
    if (!this.model.tabs.some((t) => t.id === tabId)) this.store.deleteThread(tabId);
  }

  /** worktree 를 정리한 뒤: 탭을 원본 저장소 경로로 돌리고 worktree 정보를 지운다. */
  clearWorktree(tabId: string) {
    const tab = this.model.tabs.find((t) => t.id === tabId);
    if (!tab?.worktree) return;
    this.commit(updateTab(this.model, tabId, { cwd: tab.worktree.repo, worktree: undefined }, Date.now()));
  }

  tab(tabId: string): TabMeta | null {
    return this.model.tabs.find((t) => t.id === tabId) ?? null;
  }

  /** 세션을 "최근" 에서 지우고 스레드 파일도 삭제한다. */
  deleteTab(tabId: string) {
    this.attentionHooks?.forget(tabId);
    this.sessions?.release(tabId);
    this.commit(deleteTab(this.model, tabId, Date.now()));
    this.store.deleteThread(tabId);
  }

  reopenTab(tabId: string) {
    this.commit(reopenTab(this.model, tabId, Date.now()));
  }

  activateTab(tabId: string) {
    this.commit(activateTab(this.model, tabId));
    this.attentionHooks?.viewed(tabId);
  }

  /**
   * 화면에 보이는 채팅 탭. 분할 화면이면 활성 탭 말고 하나가 더 보인다 — "보고 있는 탭" 판정(완료·오류 표시, 완료 알림)이
   * 활성 탭 하나만 보면 오른쪽 칸의 탭에 보고 있는데도 완료 점이 붙는다. 렌더러가 알려 주고, 새로 보이게 된 탭은 표시를 지운다.
   */
  private visible = new Set<string>();
  setVisibleTabs(tabIds: string[]) {
    const next = new Set(tabIds.filter((id) => this.model.tabs.some((t) => t.id === id)));
    for (const id of next) if (!this.visible.has(id)) this.attentionHooks?.viewed(id);
    this.visible = next;
  }

  /** 지금 화면에 보이는 탭인가. 렌더러가 알려 준 목록만 본다 — 설정·사용량 화면이면 비어 있어 채팅을 읽은 것으로 치지 않는다. */
  isVisible(tabId: string): boolean {
    return this.visible.has(tabId);
  }

  visibleTabIds(): string[] {
    return [...this.visible];
  }

  activateNth(n: number) {
    const id = nthOpenTab(this.model, n);
    if (id) this.activateTab(id);
  }

  /** 빈 이름으로 저장하면 사용자 지정을 해제하고 자동 제목으로 돌아간다. */
  renameTab(tabId: string, title: string) {
    const t = title.trim();
    this.commit(updateTab(this.model, tabId, { title: t || null, titleCustom: t.length > 0 }, Date.now()));
  }

  reorderWorkspaces(workspaceIds: string[]) {
    this.commit(reorderWorkspaces(this.model, workspaceIds));
  }

  reorderTabs(openTabIds: string[]) {
    this.commit(reorderTabs(this.model, openTabIds));
  }

  private commit(next: WorkspaceModel) {
    if (next === this.model) return;
    this.model = next;
    try {
      this.store.saveModel(next);
    } catch (e) {
      console.error("[workspaces] 저장 실패:", e);
    }
    this.broadcast(this.state());
  }
}
