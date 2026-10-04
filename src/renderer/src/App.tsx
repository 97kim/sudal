import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppInfoDto, ShortcutName } from "@shared/ipc";
import { activeWorkspace, tabCwd } from "@shared/workspace-model";
import { Icon } from "./components/Icon";
import { Sidebar, type View } from "./components/Sidebar";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { SearchPalette } from "./components/SearchPalette";
import { kvGet, kvSet } from "./kv-store";
import { requestReveal } from "./reveal";
import { browserHasKeys } from "./browser-active";
import { closeTarget } from "./close-target";
import { isBrowserTab } from "./editor-tabs";
import { forgetEditorTabs, getEditorTabs, getLastPane, openBrowserTab, openEditorFile, pruneEditorTabs, reopenClosedEditorTab, setEditorMaximized } from "./editor-tabs";
import { clearComposerDraft, pruneComposerDrafts } from "./composer-draft";
import { pruneTerminalState } from "./terminal-panes";
import { closePane, loadSplit, openSplit, pruneSplit, saveSplit, syncActive, type SplitState } from "./split-view";
import { PaneFocusContext, PaneSplitContext } from "./pane-focus";
import { nextAttentionTab } from "@shared/attention-nav";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { ChatView } from "./views/ChatView";
import { SettingsView, type SettingsSection } from "./views/SettingsView";
import { UsageView } from "./views/UsageView";

export function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("chat");
  // 사이드바 접힘. 아주 없애지 않고 얇은 띠로 두는 이유는 macOS 신호등 버튼 자리를 지켜야 해서다.
  const [railed, setRailed] = useState(() => kvGet("sidebar.railed") === "1");
  const toggleRail = useCallback(
    () => setRailed((v) => {
      kvSet("sidebar.railed", v ? null : "1");
      return !v;
    }),
    [],
  );
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [search, setSearch] = useState(false);
  // 짧은 알림(오류 등). 몇 초 뒤 사라진다.
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.error ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [notice]);
  const ws = useWorkspaces();
  const api = window.workbench.workspaces;

  useEffect(() => {
    window.workbench.app.info().then(setInfo).catch(console.error);
  }, []);

  const { model } = ws;
  const activeTab = model.tabs.find((t) => t.id === model.activeTabId) ?? null;
  const activeWs = activeTab
    ? (model.workspaces.find((w) => w.id === activeTab.workspaceId) ?? null)
    : null;

  // ===== 채팅 화면 분할 =====
  // 좌우 두 칸에 각각 다른 탭. 활성 탭 = 포커스된 칸의 탭. 규칙은 split-view.ts 에 모여 있다.
  const [split, setSplit] = useState<SplitState | null>(null);
  const [splitRatio, setSplitRatio] = useState(50);
  const splitLoaded = useRef(false);
  const splitArea = useRef<HTMLDivElement>(null);
  /**
   * 분할을 푼 직후 남길 탭. 활성화는 main 을 거쳐 비동기로 돌아오므로, 그동안 활성 탭(빠진 칸)을 그리면
   * 남을 칸이 사라졌다 다시 마운트된다(입력 중이던 글·스크롤이 날아간다). 모델이 따라오면 비운다.
   */
  const [solo, setSolo] = useState<string | null>(null);
  useEffect(() => {
    if (solo && (model.activeTabId === solo || !model.openTabIds.includes(solo))) setSolo(null);
  }, [solo, model.activeTabId, model.openTabIds]);
  useEffect(() => {
    if (splitLoaded.current || model.tabs.length === 0) return; // 모델을 받기 전(빈 모델)에 판단하면 저장된 분할을 버린다
    const r = loadSplit(model.openTabIds, model.activeTabId);
    splitLoaded.current = true;
    setSplit(r.state);
    setSplitRatio(r.ratio);
  }, [model.tabs.length, model.openTabIds, model.activeTabId]);
  useEffect(() => {
    if (!splitLoaded.current) return;
    // 닫기·삭제를 먼저 본다 — 탭을 닫으면 모델이 이웃 탭을 활성화하는데, 그걸 칸 교체로 받으면 남은 칸 대신 제3의 탭이 들어온다.
    const pruned = pruneSplit(split, model.openTabIds);
    if (!pruned.state) {
      if (split) {
        setSplit(null);
        if (pruned.keep && pruned.keep !== model.activeTabId) {
          setSolo(pruned.keep);
          void api.activateTab(pruned.keep);
        }
      }
      return;
    }
    const next = syncActive(pruned.state, model.activeTabId);
    if (next !== split) setSplit(next);
  }, [split, model.openTabIds, model.activeTabId, api]);
  useEffect(() => {
    if (splitLoaded.current) saveSplit(split, splitRatio);
  }, [split, splitRatio]);
  // main 이 "보고 있는 탭" 을 알게 한다 — 분할이면 둘 다(완료·오류 표시와 완료 알림이 이걸로 판단한다).
  useEffect(() => {
    const single = solo ?? model.activeTabId;
    const ids = view !== "chat" ? [] : split ? [split.left, split.right] : single ? [single] : [];
    api.setVisibleTabs(ids);
  }, [view, split, solo, model.activeTabId, api]);
  // 키보드로 칸을 바꾸면(⌃Tab, ⌘1~9, 응답 필요 이동) DOM 포커스는 이전 칸에 남는다. 거기가 승인 창의 "허용" 버튼이면
  // 다음 Enter 가 엉뚱한 칸을 승인한다 — 포커스가 포커스되지 않은 칸 안에 남아 있으면 풀어 준다.
  useEffect(() => {
    if (!split) return;
    const el = document.activeElement as HTMLElement | null;
    const pane = el?.closest?.("[data-chat-pane]");
    if (pane && pane.getAttribute("data-focused") !== "true") el?.blur();
  }, [split]);
  const openSplitTab = (tabId: string) => {
    const next = openSplit(split, model.activeTabId, tabId);
    if (!next) return;
    setView("chat");
    setSplit(next);
    if (model.activeTabId !== tabId) void api.activateTab(tabId);
  };
  const unsplitPane = (pane: 0 | 1) => {
    if (!split) return;
    const keep = closePane(split, pane);
    setSplit(null);
    if (model.activeTabId !== keep) {
      setSolo(keep);
      void api.activateTab(keep);
    }
  };
  // ⌘⌥← / ⌘⌥→: 왼쪽·오른쪽 칸으로(터미널 분할과 같은 손놀림). 그 칸 입력창에 포커스를 주면 onFocusCapture 가 칸을 활성화한다.
  // 입력창·에디터는 자기 keydown 에서 전파를 막을 수 있어 캡처로 받는다. 터미널은 자기 칸 이동이 먼저라 버블에서,
  // 터미널이 옮겼으면(defaultPrevented) 받지 않는다.
  useEffect(() => {
    if (!split || view !== "chat") return;
    const move = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey) return;
      if (e.code !== "ArrowLeft" && e.code !== "ArrowRight") return;
      e.preventDefault();
      const pane: 0 | 1 = e.code === "ArrowLeft" ? 0 : 1;
      if (split.focused === pane) return;
      const input = document.querySelector<HTMLTextAreaElement>(`[data-chat-pane='${pane === 0 ? "left" : "right"}'] [data-composer] textarea`);
      input?.focus();
      if (document.activeElement !== input) void api.activateTab(pane === 0 ? split.left : split.right);
    };
    const inTerminal = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest(".xterm");
    const onCapture = (e: KeyboardEvent) => {
      if (!inTerminal(e)) move(e);
    };
    const onBubble = (e: KeyboardEvent) => {
      if (inTerminal(e) && !e.defaultPrevented) move(e);
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
    };
  }, [split, view, api]);
  const onSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const area = splitArea.current;
    if (!area) return;
    const move = (ev: MouseEvent) => {
      const r = area.getBoundingClientRect();
      setSplitRatio(Math.min(80, Math.max(20, ((ev.clientX - r.left) / r.width) * 100)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const newTab = useCallback(async () => {
    const wsId = activeWorkspace(model)?.id;
    if (!wsId) {
      await api.create(t("nav.empty.newWorkspace"));
      setView("chat");
      return;
    }
    await api.createTab(wsId);
    setView("chat");
  }, [model, api, t]);

  const openTab = useCallback(
    async (tabId: string) => {
      const tab = model.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.open) await api.activateTab(tabId);
      else await api.reopenTab(tabId);
      setView("chat");
    },
    [model, api],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      await api.closeTab(tabId);
    },
    [api],
  );

  // 삭제된 탭의 입력창 초안·에디터 상태를 정리한다(삭제가 어느 경로로 일어났든). 모델이 아직 비어 있으면(로딩 전) 건드리지 않는다.
  useEffect(() => {
    if (model.tabs.length === 0) return;
    const live = new Set(model.tabs.map((t) => t.id));
    pruneEditorTabs(live);
    pruneComposerDrafts(live);
    pruneTerminalState(live);
  }, [model.tabs]);

  const newWorktreeIn = useCallback(
    async (wsId: string) => {
      const active = model.tabs.find((t) => t.id === model.activeTabId);
      const r = await window.workbench.worktree.create(wsId, active?.workspaceId === wsId ? active.id : null);
      if (r.ok) setView("chat");
      else setNotice({ text: r.error, error: true });
    },
    [model.tabs, model.activeTabId],
  );

  // 응답 필요(권한 대기·미확인 완료) 세션으로 점프. 열린 탭 순서로 순환.
  const jumpAttention = useCallback(
    (dir: 1 | -1) => {
      const id = nextAttentionTab(model.openTabIds, ws.attention, model.activeTabId, dir);
      if (id) void openTab(id);
    },
    [model.openTabIds, model.activeTabId, ws.attention, openTab],
  );

  // `sudal` CLI 가 밀어 넣는 화면 동작: 그 탭으로 가서 파일·브라우저를 연다
  useEffect(
    () =>
      window.workbench.app.onControlOpen((req) => {
        setView("chat"); // 설정·사용량 화면에 있어도 요청한 탭이 보이게
        void api.activateTab(req.tabId);
        if (req.kind === "file") openEditorFile(req.tabId, req.path, req.line ? { line: req.line } : null);
        else openBrowserTab(req.tabId, req.url);
      }),
    [],
  );

  // 메뉴 단축키 (⌘T/⌘W/⌘K/⌘1~9/⌃Tab)
  useEffect(() => {
    /** 지금 브라우저를 보고 있나 — ⌘F·⌘L·⌘R 을 그쪽으로 보낼지 판단한다. */
    const browserKeysActive = () => {
      const tabId = model.activeTabId;
      if (!tabId) return false;
      const t = getEditorTabs(tabId);
      return browserHasKeys({
        editorShown: t.visible && t.files.length > 0,
        editorMaximized: t.maximized,
        focusInEditor: !!document.activeElement?.closest?.("[data-editor-pane-shell]"),
        lastPane: getLastPane(tabId),
        hasEditorTab: !!t.active,
        activeIsBrowser: !!t.active && isBrowserTab(t.active),
      });
    };
    /** 통합 터미널에 포커스가 있나(xterm 의 입력 textarea 나 찾기 입력창). */
    const terminalFocused = () => !!document.activeElement?.closest?.("[data-terminal-panel]");
    const handle = (name: ShortcutName) => {
      // 터미널 안에서 ⌘W·⌘K·⌘F 는 터미널 관례대로 — 세션 닫기·워크스페이스 전환·대화 검색이 아니라
      // 터미널 닫기·화면 지우기·터미널 안 찾기. 터미널에서 습관처럼 누른 ⌘W 로 세션이 통째로 사라지면 안 된다.
      if ((name === "close-tab" || name === "switch-workspace" || name === "search") && terminalFocused()) {
        const cmd = name === "close-tab" ? "close" : name === "switch-workspace" ? "clear" : "find";
        window.dispatchEvent(new CustomEvent("sudal:terminal-command", { detail: cmd }));
        return;
      }
      if (name === "new-tab") void newTab();
      else if (name === "close-tab" && model.activeTabId) {
        const tabId = model.activeTabId;
        const t = getEditorTabs(tabId);
        // 포커스가 에디터 패널 안이면(CodeMirror·브라우저 webview·도구막대) 그 탭을 닫는다.
        // webview 안을 클릭하면 호스트의 activeElement 가 그 <webview> 요소가 되므로 이 검사로 잡힌다.
        const focusInEditor = !!document.activeElement?.closest?.("[data-editor-pane-shell]");
        const where = closeTarget({
          editorShown: t.visible && t.files.length > 0,
          editorMaximized: t.maximized,
          focusInEditor,
          lastPane: getLastPane(tabId),
          hasEditorTab: !!t.active,
        });
        if (where === "editor") window.dispatchEvent(new CustomEvent("sudal:editor-close-active", { detail: tabId }));
        else void closeTab(tabId);
      }
      else if (name === "toggle-sidebar") toggleRail();
      else if (name === "switch-workspace") setSwitcher((s) => !s);
      else if (name === "search") {
        // ⌘F: 브라우저를 보고 있으면 그 페이지에서 찾기, 아니면 대화 검색
        if (browserKeysActive()) window.dispatchEvent(new CustomEvent("sudal:browser-command", { detail: "find" }));
        else setSearch((s) => !s);
      } else if (name === "reopen-tab") {
        if (model.activeTabId) reopenClosedEditorTab(model.activeTabId);
      } else if (name === "browser-address" || name === "browser-reload" || name === "browser-hard-reload") {
        if (browserKeysActive())
          window.dispatchEvent(
            new CustomEvent("sudal:browser-command", {
              detail: name === "browser-address" ? "address" : name === "browser-hard-reload" ? "hard-reload" : "reload",
            }),
          );
      }
      else if (name === "toggle-editor-maximize" && model.activeTabId) {
        const t = getEditorTabs(model.activeTabId);
        // 열린 파일이 없으면 넓힐 것도 없다
        if (t.files.length > 0) setEditorMaximized(model.activeTabId, !t.maximized);
      }
      else if (name === "next-attention" || name === "prev-attention")
        jumpAttention(name === "next-attention" ? 1 : -1);
      else if (name === "next-tab" || name === "prev-tab") {
        const ids = model.openTabIds;
        if (ids.length === 0) return;
        const i = ids.indexOf(model.activeTabId ?? "");
        const next =
          name === "next-tab"
            ? (i + 1) % ids.length
            : (i - 1 + ids.length) % ids.length;
        void api.activateTab(ids[next]);
        setView("chat");
      } else if (name.startsWith("tab-")) {
        const id = model.openTabIds[Number(name.slice(4)) - 1];
        if (id) {
          void api.activateTab(id);
          setView("chat");
        }
      }
    };
    // 네이티브 메뉴 가속기는 자동화로 못 누른다 — e2e 가 같은 경로를 타도록 열어 둔다.
    void 0;
    (window as unknown as { __sudalShortcut?: (n: ShortcutName) => void }).__sudalShortcut = handle;
    // ⌘⇧↓/↑(응답 필요 세션으로)는 입력창·에디터·터미널에 포커스가 있으면 편집 명령("끝까지 선택")이 먼저 처리해
    // 메뉴 가속기까지 오지 않는다. 캡처 단계에서 먼저 받아 막는다 — 막힌 키는 메뉴로도 가지 않으니 두 번 돌지 않는다.
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation();
      handle(e.key === "ArrowDown" ? "next-attention" : "prev-attention");
    };
    window.addEventListener("keydown", onKey, true);
    const off = window.workbench.app.onShortcut(handle);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      off();
    };
  }, [model, newTab, closeTab, api]);

  return (
    <div className="relative flex h-full">
      <Sidebar
        railed={railed}
        onToggleRail={toggleRail}
        view={view}
        onView={setView}
        onOpenUpdate={() => {
          setSettingsSection("general");
          setView("settings");
        }}
        ws={ws}
        info={info}
        onNewTab={() => void newTab()}
        onOpenTab={(id) => void openTab(id)}
        onNewTabIn={(wsId) =>
          void api.createTab(wsId).then(() => setView("chat"))
        }
        onRemoveWorkspace={(wsId) => void api.remove(wsId)}
        onCloseTab={(id) => void closeTab(id)}
        onRenameTab={(id, title) => void api.renameTab(id, title)}
        onReorderTabs={(ids) => void api.reorderTabs(ids)}
        onReorderWorkspaces={(ids) => void api.reorderWorkspaces(ids)}
        onDeleteTab={(id) =>
          void api.deleteTab(id).then((r) => {
            if (r.ok) {
              forgetEditorTabs(id);
              clearComposerDraft(id);
            }
            else setNotice({ text: r.error, error: true });
          })
        }
        onCreateWorkspace={(name) =>
          void api.create(name).then(() => setView("chat"))
        }
        onRenameWorkspace={(id, name) => void api.update(id, { name })}
        onSetWorkspacePath={(id) =>
          void window.workbench.dialog.pickDirectory().then((dir) => {
            if (dir) void api.update(id, { path: dir });
          })
        }
        onClearWorkspacePath={(id) => void api.update(id, { path: "" })}
        onSwitchWorkspace={() => setSwitcher(true)}
        onSearch={() => setSearch(true)}
        onJumpAttention={() => jumpAttention(1)}
        onNewWorktreeIn={(wsId) => void newWorktreeIn(wsId)}
        onExportTab={(id) => void window.workbench.chat.exportMarkdown(id)}
        onSplitTab={openSplitTab}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "chat" && (
          <>
            <div className="min-h-0 flex-1">
              {activeTab && activeWs ? (
                <div ref={splitArea} className="flex h-full min-h-0" data-chat-split={split ? "on" : "off"}>
                  {/* 칸들은 같은 부모 아래 탭 id 로 key 를 준 형제로, DOM 순서는 id 순으로 고정하고 좌우는 CSS order 로만 바꾼다 —
                      자리를 옮기면 인앱 브라우저(webview)가 페이지를 다시 읽고, 부모가 바뀌면 ChatView 가 다시 마운트된다. */}
                  {(split ? [split.left, split.right] : [solo ?? activeTab.id])
                    .slice()
                    .sort()
                    .map((id) => {
                      const t = model.tabs.find((x) => x.id === id);
                      const w = t ? model.workspaces.find((x) => x.id === t.workspaceId) : null;
                      if (!t || !w) return null;
                      const pane: 0 | 1 = split && id === split.right ? 1 : 0;
                      const focused = !split || split.focused === pane;
                      const activateThis = () => {
                        if (model.activeTabId !== id) void api.activateTab(id);
                      };
                      return (
                        <div
                          key={id}
                          className={`relative flex min-h-0 min-w-0 flex-col ${split && pane === 1 ? "flex-1" : split ? "" : "flex-1"}`}
                          style={{ order: pane * 2, ...(split && pane === 0 ? { width: `${splitRatio}%`, flexShrink: 0 } : {}) }}
                          onMouseDownCapture={split ? activateThis : undefined}
                          onFocusCapture={split ? activateThis : undefined}
                          data-chat-pane={pane === 0 ? "left" : "right"}
                          data-focused={focused ? "true" : "false"}
                        >
                          {split && focused && <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 bg-accent/60" />}
                          <PaneFocusContext.Provider value={focused}>
                          <PaneSplitContext.Provider value={!!split}>
                          <ChatView
                            tab={t}
                            workspace={w}
                            ws={ws}
                            focused={focused}
                            showTabStrip={!split || pane === 0}
                            onUnsplit={split ? () => unsplitPane(pane) : undefined}
                            onActivateTab={(tid) => void api.activateTab(tid)}
                            onCloseTab={(tid) => void closeTab(tid)}
                            onNewTab={() => void newTab()}
                            onOpenMcp={() => {
                              setSettingsSection("mcp");
                              setView("settings");
                            }}
                            onOpenSettings={(section) => {
                              setSettingsSection(section ?? "cli");
                              setView("settings");
                            }}
                            onIsolate={() => void newWorktreeIn(w.id)}
                          />
                          </PaneSplitContext.Provider>
                          </PaneFocusContext.Provider>
                        </div>
                      );
                    })}
                  {split && (
                    <div
                      onMouseDown={onSplitDrag}
                      onDoubleClick={() => setSplitRatio(50)}
                      className="w-1 shrink-0 cursor-col-resize bg-line/60 hover:bg-accent/40"
                      style={{ order: 1 }}
                      title={t("nav.empty.resizeHint")}
                      data-chat-split-resizer
                    />
                  )}
                </div>
              ) : (
                <EmptyState
                  hasWorkspace={model.workspaces.length > 0}
                  onAdd={() =>
                    void api
                      .create(t("nav.empty.newWorkspace"))
                      .then(() => setView("chat"))
                  }
                  onNew={() => void newTab()}
                />
              )}
            </div>
          </>
        )}
        {view === "settings" && (
          <SettingsView
            info={info}
            workspaces={model.workspaces.map((w) => ({ id: w.id, name: w.name }))}
            // MCP 상태는 Claude 가 실제로 도는 디렉토리 기준 — 활성 세션의 cwd 를 먼저, 없으면 워크스페이스 기본 경로.
            workspacePath={
              (activeTab && tabCwd(model, activeTab)) ||
              activeWs?.path ||
              model.tabs.find((t) => t.workspaceId === activeWs?.id && t.cwd)?.cwd ||
              null
            }
            section={settingsSection}
            onSection={setSettingsSection}
          />
        )}
        {view === "usage" && <UsageView />}
      </main>

      {notice && (
        <div
          className={`pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-3 py-2 text-[12px] shadow-lg ${
            notice.error ? "border-err/40 bg-err-bg text-err" : "border-line bg-panel text-fg"
          }`}
          data-notice
        >
          {notice.text}
        </div>
      )}
      {search && (
        <SearchPalette
          onClose={() => setSearch(false)}
          onPick={(tabId, blockId) => {
            setSearch(false);
            // 먼저 예약해 두면 그 탭의 MessageList 가 (이미 있든, 새로 마운트되든) 블록이 생기는 순간 이동한다.
            requestReveal(tabId, blockId);
            void openTab(tabId);
          }}
        />
      )}
      {switcher && (
        <WorkspaceSwitcher
          ws={ws}
          onClose={() => setSwitcher(false)}
          onPick={(id) => {
            setSwitcher(false);
            void api.createTab(id).then(() => setView("chat"));
          }}
          onAdd={(name) => {
            setSwitcher(false);
            void api
              .create(name || t("nav.empty.newWorkspace"))
              .then(() => setView("chat"));
          }}
          onRemove={(id) => void api.remove(id)}
        />
      )}
    </div>
  );
}

function EmptyState({
  hasWorkspace,
  onAdd,
  onNew,
}: {
  hasWorkspace: boolean;
  onAdd: () => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-panel text-accent">
        <Icon name="folder" size={22} />
      </div>
      <div>
        <div className="text-[15px] font-semibold">
          {hasWorkspace ? t("nav.empty.noSessions") : t("nav.empty.addWorkspace")}
        </div>
        <p className="mt-1 text-muted">
          {hasWorkspace
            ? t("nav.empty.noSessionsHint")
            : t("nav.empty.addWorkspaceHint")}
        </p>
      </div>
      <button
        onClick={hasWorkspace ? onNew : onAdd}
        className="no-drag flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-medium text-on-primary hover:bg-primary-hover"
      >
        <Icon name={hasWorkspace ? "edit" : "folder"} size={14} />
        {hasWorkspace ? t("nav.empty.newSession") : t("nav.empty.createWorkspace")}
      </button>
    </div>
  );
}
