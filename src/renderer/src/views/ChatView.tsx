import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import {
  CONTEXT_WARN_PCT,
  contextUsage,
  contextWarnLevel,
} from "@shared/session-state";
import type { PermissionAnswer, PermissionPolicy } from "@shared/chat-events";
import type {
  ChatImageDto,
  LimitWaitDto,
  PendingPromptDto,
  Provider,
  SessionSnapshotDto,
  WorkspaceStateDto,
  WorktreeStatusDto,
  FanoutStartDto,
} from "@shared/ipc";
import type { SlashCommandDto } from "@shared/slash-commands";
import { type WorktreeMeta,
  tabCwd,
  tabTitle,
  type TabMeta,
  type Workspace,
} from "@shared/workspace-model";
import { BackgroundJobsBar } from "../components/BackgroundJobsBar";
import { Composer } from "../components/Composer";
import { ContextPanel } from "../components/ContextPanel";
import { shortenHome } from "@shared/path-display";
import { LocateFileContext, OpenFileContext, type LocateFile, type OpenFile } from "../components/FileViewer";
import { EditorPane } from "../components/EditorPane";
import { isBrowserTab, openBrowserTab, openEditorFile, setEditorPaneVisible, setLastPane, useEditorTabs } from "../editor-tabs";
import { appendComposerDraft, loadComposerDraft } from "../composer-draft";
import { loadTerminalDock, loadTerminalOpen, loadTerminalWidth, requestCliFocus, saveTerminalDock, saveTerminalOpen, saveTerminalWidth, TERMINAL_DOCK_EVENT, type TerminalDock } from "../terminal-panes";
import { RunInTerminalContext, requestTerminalRun } from "../terminal-run";
import { Icon } from "../components/Icon";
import { scApp } from "../platform";
import { ProviderLogo } from "../components/ProviderLogo";
import { MessageList } from "../components/MessageList";
import { PermissionPrompt } from "../components/PermissionPrompt";
import { HeaderMenu } from "../components/HeaderMenu";
import { ProviderSwitchModal } from "../components/ProviderSwitchModal";
import { ModelPickerModal } from "../components/ModelPickerModal";
import { headerModelLabel } from "@shared/models";
import { VerifyPopover } from "../components/VerifyPopover";
import { FanoutModal } from "../components/FanoutModal";
import { FanoutCompare } from "../components/FanoutCompare";
import { OrchestrationPanel } from "../components/OrchestrationPanel";
import { modelFromArg, parseAppCommand } from "@shared/app-commands";
import { RightPanel } from "../components/RightPanel";
import { TabBar } from "../components/TabBar";
import { TerminalPanel } from "../components/TerminalPanel";
import { useSnippets } from "../hooks/useSnippets";
import { useSession } from "../hooks/useSession";
import {
  getCtxDismissed,
  setCtxDismissed,
  shouldShowCtxBanner,
} from "../ctx-dismiss";
import { startDrag } from "../drag";

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const EDITOR_W_KEY = "sudal.editorPane.width";
/** "작업 중" 으로 보는 세션 상태 — 같은 디렉토리 충돌 알림용. */
const BUSY_STATUS = new Set(["running", "waiting_permission", "queued"]);
const shortTitle = (t: string) => (t.length > 28 ? `${t.slice(0, 28)}…` : t);
/** 탭별로 닫아 둔 충돌 배너의 세션 조합 — ChatView 는 탭을 오갈 때마다 다시 마운트되므로 컴포넌트 밖에 둔다. */
const dismissedConcurrent = new Map<string, string>();

export function ChatView({
  tab,
  workspace,
  ws,
  onActivateTab,
  onCloseTab,
  onNewTab,
  onOpenMcp,
  onOpenSettings,
  onIsolate,
  focused = true,
  onUnsplit,
  showTabStrip = true,
}: {
  /** 분할 화면에서 이 칸이 포커스된 칸인가. 창 전체 단축키(⌘J 등)는 포커스된 칸만 받는다. */
  focused?: boolean;
  /** 분할 화면이면 이 칸을 분할에서 뺀다(탭은 열린 채로). */
  onUnsplit?: () => void;
  /** 탭 줄. 분할이면 왼쪽 칸에만 — 같은 줄이 두 번 보이지 않게. */
  showTabStrip?: boolean;
  tab: TabMeta;
  workspace: Workspace;
  /** 같은 디렉토리에서 다른 세션이 작업 중일 때 "격리 세션으로": 워크스페이스 저장소에 worktree 를 만들어 새 세션을 연다. */
  onIsolate: () => void;
  /** 탭 스트립은 헤더(타이틀바 줄) 아래에 붙으므로 여기서 그린다. */
  ws: WorkspaceStateDto;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /** "/mcp" 는 CLI 로 보내지 않고 설정의 MCP 서버 화면을 연다 (SDK 모드의 /mcp 는 요약 한 줄만 준다). */
  onOpenMcp: () => void;
  /** "/config" 는 CLI 로 보내지 않고 설정 화면을 연다. */
  /** 설정 화면으로. 섹션을 주지 않으면 CLI 탐지(/config). */
  onOpenSettings: (section?: "general" | "cli") => void;
}) {
  const { t } = useTranslation();
  const tabId = tab.id;
  const { state, config, setConfig, loaded, reload } = useSession(tabId);
  const [switching, setSwitching] = useState(false);
  // 에디터 패널(채팅 옆 분할). 변경 파일 목록·파일 트리·툴카드 경로 클릭으로 파일을 연다. 열린 파일은 탭마다 기억.
  const editorTabs = useEditorTabs(tabId);
  const openFile = useCallback<OpenFile>((path, at) => openEditorFile(tabId, path, at), [tabId]);
  // 에디터 선택·터미널 출력 → 입력창(마운트돼 있으면 바로 잇고 포커스, 아니면 초안에)
  const attachToChat = useCallback((block: string, images?: ChatImageDto[]) => appendComposerDraft(tabId, block, images), [tabId]);
  const [editorWidth, setEditorWidth] = useState(() => {
    try {
      return Math.min(1200, Math.max(360, Number(localStorage.getItem(EDITOR_W_KEY)) || 620));
    } catch {
      return 620;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_W_KEY, String(editorWidth));
    } catch {
      /* 무시 */
    }
  }, [editorWidth]);
  // 왼쪽 가장자리를 끌어 에디터 폭 조절 (왼쪽으로 끌면 넓어진다)
  const onEditorDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = editorWidth;
      const move = (ev: MouseEvent) =>
        setEditorWidth(Math.min(1200, Math.max(360, startW + (startX - ev.clientX))));
      startDrag(move, "col-resize");
    },
    [editorWidth],
  );

  // 막대를 두 번 누르면 반반으로. 끌어서 눈대중으로 맞추는 것보다 빠르고,
  // 돌아올 기준점이 있으면 마음 놓고 끌 수 있다.
  const onEditorSplitEven = useCallback((e: React.MouseEvent) => {
    const bar = e.currentTarget as HTMLElement;
    // 막대 양옆 두 영역만 반으로 나눈다. 같은 행에 우측 패널도 들어 있어 "행의 절반" 은 답이 아니다.
    const left = bar.previousElementSibling as HTMLElement | null;
    const right = bar.nextElementSibling as HTMLElement | null;
    if (!left || !right) return;
    const half = (left.getBoundingClientRect().width + right.getBoundingClientRect().width) / 2;
    setEditorWidth(Math.min(1200, Math.max(360, Math.round(half))));
  }, []);

  // 통합 터미널 패널. 한 번 열리면 닫아도 마운트를 유지해 스크롤백을 보존한다.
  // 열어 둔 채 다른 채팅 탭에 갔다 오면(이 컴포넌트가 다시 마운트된다) 열린 채로 돌아온다.
  const [terminalOpen, setTerminalOpen] = useState(() => loadTerminalOpen(tabId));
  const [terminalMounted, setTerminalMounted] = useState(terminalOpen);
  useEffect(() => saveTerminalOpen(tabId, terminalOpen), [tabId, terminalOpen]);
  // 터미널 자리(아래/오른쪽)와 오른쪽 폭. 앱 전체에서 하나 — 다른 칸이 바꾸면 따라온다.
  const [terminalDock, setTerminalDock] = useState(loadTerminalDock);
  const [terminalWidth, setTerminalWidth] = useState(loadTerminalWidth);
  useEffect(() => {
    const sync = () => setTerminalDock(loadTerminalDock());
    window.addEventListener(TERMINAL_DOCK_EVENT, sync);
    return () => window.removeEventListener(TERMINAL_DOCK_EVENT, sync);
  }, []);
  useEffect(() => saveTerminalWidth(terminalWidth), [terminalWidth]);
  // 도구 카드·코드 블록의 "터미널에서 실행": 패널을 열고 요청을 큐에 둔다. 패널이 마운트되고 셸이 붙으면 가져간다.
  const runInTerminal = useCallback(
    (command: string, run: boolean) => {
      setTerminalMounted(true);
      setTerminalOpen(true);
      requestTerminalRun(tabId, { command, run });
    },
    [tabId],
  );
  const terminalAnchor = useRef<HTMLDivElement>(null);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const openTerminalAt = (d: TerminalDock) => {
    setTerminalDock(d);
    saveTerminalDock(d);
    setTerminalMounted(true);
    setTerminalOpen(true);
  };
  const toggleTerminal = useCallback(() => {
    setTerminalMounted(true);
    setTerminalOpen((o) => !o);
  }, []);
  useEffect(
    () =>
      window.sudal.app.onShortcut((name) => {
        if (name === "toggle-terminal" && focused) toggleTerminal();
      }),
    [toggleTerminal, focused],
  );
  // CLI 를 띄우는 중. 이때 패널이 빈 터미널 목록을 받아 기본 셸을 만들면 CLI 탭 옆에 셸(Windows 는 PowerShell)이
  // 하나 더 생긴다 — CLI 를 띄우는 데 오래 걸리는 Windows 에서 매번 그랬다. 패널에 셸을 만들지 말라고 알린다(holdShell).
  const [attaching, setAttaching] = useState(false);
  const attachTerminal = async () => {
    setAttachError(null);
    requestCliFocus(tabId);
    setAttaching(true);
    setTerminalMounted(true);
    setTerminalOpen(true);
    const r = await window.sudal.chat.attachTerminal(tabId).finally(() => setAttaching(false));
    if (r.ok) setConfig(r.snapshot);
    else setAttachError(r.error);
  };
  const detachTerminal = () => void window.sudal.chat.detachTerminal(tabId);
  // 교차 리뷰: main 이 diff 를 모아 다른 provider 탭에 보내고 결과 카드를 이 탭에 남긴다
  const [reviewBusy, setReviewBusy] = useState(false);
  const requestCrossReview = async () => {
    setReviewBusy(true);
    setAttachError(null);
    try {
      const r = await window.sudal.chat.crossReview(tabId);
      if (!r.ok) setAttachError(r.error);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  };
  // 검증: 워크스페이스에 저장한 명령을 이 탭의 cwd 에서 돌리고 결과 카드를 이 탭에 남긴다(main 의 VerifyRunner)
  const [verifyOpen, setVerifyOpen] = useState(false);
  const verifyRunning = state.blocks.some((b) => b.kind === "verify" && b.status === "running");
  const savedVerify = workspace.verifyCommands ?? [];
  const runVerify = async (commands?: string[]) => {
    setAttachError(null);
    try {
      const r = await window.sudal.chat.verify(tabId, commands ? { commands } : undefined);
      if (!r.ok) setAttachError(r.error);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveVerify = (commands: string[]) => void window.sudal.workspaces.update(workspace.id, { verifyCommands: commands });
  const onVerifyClick = () => {
    if (verifyRunning) return;
    if (savedVerify.length > 0) void runVerify();
    else setVerifyOpen(true);
  };
  const closeVerify = useCallback(() => setVerifyOpen(false), []);
  const verifyAnchor = useRef<HTMLDivElement>(null);
  const verifyToggle = useRef<HTMLButtonElement>(null);
  const moreAnchor = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // 팬아웃: 지시 하나를 격리 세션 N개에 — 시작 창과 비교 오버레이
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [compareFanoutId, setCompareFanoutId] = useState<string | null>(null);
  const closeFanout = useCallback(() => setFanoutOpen(false), []);
  const closeCompare = useCallback(() => setCompareFanoutId(null), []);
  // 오케스트레이션 패널(Run 인박스·워커). 헤더 버튼 또는 카드에서 연다
  const [orchPanel, setOrchPanel] = useState<{ runId: string | null } | null>(null);
  const closeOrch = useCallback(() => setOrchPanel(null), []);
  const startFanout = useCallback(
    async (req: FanoutStartDto): Promise<string | null> => {
      try {
        const r = await window.sudal.chat.fanout(tabId, req);
        return r.ok ? null : r.error;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [tabId],
  );
  const running = state.status !== "idle" && state.status !== "error";
  // Skill·Agent 카드가 결과 없이 열려 있으면 하위 에이전트(예: codex:rescue → Codex)가 턴을 잡고 있는 것
  const agentBlock = running ? state.blocks.find((b) => b.kind === "tool" && !b.result && ["Skill", "Agent", "Task"].includes(b.name)) : undefined;
  const agentBusy = agentBlock && agentBlock.kind === "tool" ? agentBlock.name : null;
  // companion 이 띄운 Codex 가 일하는 중이면 힌트에 그렇게 적는다(카드의 Codex 배지와 같은 근거)
  const agentViaCodex = agentBlock && agentBlock.kind === "tool" && agentBlock.subagent?.via === "codex";
  // 하이브리드: 터미널(CLI TUI)이 세션을 제어 중이면 채팅은 미러만 하고 입력은 잠근다.
  const terminalControlled = config?.controller === "terminal";
  // 터미널 모드에서 CLI 가 권한 승인을 기다리는 중 (Claude 훅으로 감지). 배너를 경고색으로 바꾼다.
  const attention = terminalControlled
    ? (config?.terminalAttention ?? null)
    : null;
  const [attachError, setAttachError] = useState<string | null>(null);
  // 컨텍스트 창 경고: 80% 부터. 닫음 상태는 탭 id 로 컴포넌트 밖에 기억한다(탭을 오가도 유지).
  // 경고 구간 아래로 내려오면(새 세션의 첫 턴 등) 닫음이 풀린다.
  const ctx = contextUsage(state);
  const ctxPct = ctx?.pct ?? null;
  const ctxLevel = contextWarnLevel(ctxPct);
  const [ctxDismissTick, setCtxDismissTick] = useState(0);
  const ctxDismissed = getCtxDismissed(tabId);
  useEffect(() => {
    // pct 가 null 인 순간(마운트 직후 재생 전)은 판단 보류 — 그때 풀면 탭을 오갈 때마다 닫음이 사라진다.
    if (ctxDismissed && ctxPct !== null && ctxPct < CONTEXT_WARN_PCT) {
      setCtxDismissed(tabId, null);
      setCtxDismissTick((n) => n + 1);
    }
  }, [tabId, ctxPct, ctxDismissed]);
  const dismissCtx = () => {
    if (ctxPct !== null && ctxLevel) setCtxDismissed(tabId, { pct: ctxPct, level: ctxLevel });
    setCtxDismissTick((n) => n + 1);
  };
  void ctxDismissTick;
  const ctxBanner =
    ctxLevel !== null &&
    ctxPct !== null &&
    !terminalControlled &&
    shouldShowCtxBanner(ctxPct, ctxLevel, ctxDismissed);
  const [ctxBusy, setCtxBusy] = useState(false);
  // 같은 provider 로 "요약 + 새 세션": 기존 handoff 경로를 그대로 쓴다 (다음 메시지 앞에 요약이 붙는다).
  // 압축은 provider 에게 맡긴다 — 모델이 무엇을 남길지 정하고 세션도 끊기지 않는다.
  // Codex 처럼 압축이 없는 provider 면 main 이 알아서 요약 후 새 세션으로 넘어간다.
  const compactContext = async () => {
    setCtxBusy(true);
    try {
      const r = await window.sudal.chat.compact(tabId);
      if (!r.ok) setAttachError(r.error);
      else if (r.config) setConfig(r.config);
      // 네이티브 압축이면 compacted 이벤트가, 폴백이면 session_reset 이 게이지를 정리한다.
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setCtxBusy(false);
    }
  };

  // "/model" 피커. "/model opus" 처럼 인자가 있으면 피커 없이 바로 바꾼다.
  const [modelPicker, setModelPicker] = useState(false);
  const setModel = useCallback(
    async (model: string) => {
      setConfig(await window.sudal.chat.configure(tabId, { model }));
    },
    [tabId, setConfig],
  );

  const onSend = useCallback(
    async (text: string, images: ChatImageDto[]) => {
      const cmd = images.length === 0 ? parseAppCommand(text) : null;
      if (cmd?.name === "mcp") return onOpenMcp();
      if (cmd?.name === "config") return onOpenSettings();
      if (cmd?.name === "model") {
        if (cmd.arg) await setModel(modelFromArg(cmd.arg));
        else setModelPicker(true);
        return;
      }
      const r = await window.sudal.chat.send(tabId, { text, images });
      if (!r.ok) throw new Error(r.error);
      setConfig(await window.sudal.chat.snapshot(tabId));
    },
    [tabId, setConfig, onOpenMcp, onOpenSettings, setModel],
  );

  const onAnswer = useCallback(
    (answer: PermissionAnswer) => {
      const req = state.pendingPermission;
      if (req)
        void window.sudal.chat.answerPermission(
          tabId,
          req.requestId,
          answer,
        );
    },
    [tabId, state.pendingPermission],
  );

  // 세션 작업 경로: 디렉토리 선택 → configure(cwd). 바뀌면 provider 세션은 새로 시작한다.
  const pickCwd = async () => {
    const dir = await window.sudal.dialog.pickDirectory();
    if (dir)
      setConfig(await window.sudal.chat.configure(tabId, { cwd: dir }));
  };

  const onPolicy = (policy: PermissionPolicy) =>
    void window.sudal.chat.configure(tabId, { policy }).then(setConfig);

  const onClear = async () => {
    setConfig(await window.sudal.chat.clear(tabId));
    // 리듀서 상태는 main 의 이벤트 로그 재생으로 맞춘다.
    reload();
  };

  const loadHandoff = useCallback(
    () => window.sudal.chat.handoffPreview(tabId),
    [tabId],
  );

  const title = tabTitle(tab, t("shared.untitledTab"));
  // 세션 이름 인라인 편집: 제목 클릭 또는 탭 더블클릭. Enter 저장, esc 취소, 빈 값이면 자동 제목으로.
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const startRename = useCallback(() => {
    setDraftTitle(tab.title ?? "");
    setEditingTitle(true);
  }, [tab.title]);
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select();
  }, [editingTitle]);
  const commitRename = useCallback(async () => {
    setEditingTitle(false);
    if (draftTitle.trim() === (tab.title ?? "").trim()) return;
    await window.sudal.workspaces.renameTab(tabId, draftTitle);
  }, [draftTitle, tab.title, tabId]);
  const cwd = config?.cwd ?? workspace.path;
  const terminalRight = terminalDock === "right" && terminalMounted && terminalOpen && !!cwd;
  // 답변 속 파일 참조 → 실제 경로. Markdown 의 FileRef 가 부른다(결과 캐시는 FileRef 쪽).
  const locateFile = useMemo<LocateFile>(
    () => ({ cwd: cwd || null, locate: (ref) => (cwd ? window.sudal.files.locate(cwd, ref) : Promise.resolve([])) }),
    [cwd],
  );
  // 같은 디렉토리에서 작업 중인 다른 세션 — 같은 파일을 고치면 서로 덮어쓸 수 있어 알린다. 닫으면 그 조합이 바뀔 때까지 다시 안 띄운다
  // (닫은 조합은 모듈에 기억해 탭을 오가며 다시 마운트돼도 유지). 세션 스냅샷이 오기 전엔 cwd 를 모르므로 계산하지 않는다(격리 탭 오탐 방지).
  const concurrent =
    cwd && config
      ? ws.model.tabs.filter((x) => x.id !== tabId && x.open && tabCwd(ws.model, x) === cwd && BUSY_STATUS.has(ws.statuses[x.id] ?? ""))
      : [];
  const concurrentKey = concurrent.map((x) => x.id).sort().join(",");
  const [concurrentDismissed, setConcurrentDismissedState] = useState(() => dismissedConcurrent.get(tabId) ?? "");
  const setConcurrentDismissed = (key: string) => {
    dismissedConcurrent.set(tabId, key);
    setConcurrentDismissedState(key);
  };
  const editorShown = editorTabs.visible && editorTabs.files.length > 0 && !!cwd;
  // 최대화: 채팅·오른쪽 패널을 잠시 숨기고 에디터/브라우저가 창 전체를 쓴다. 상태는 그대로 살아 있다(언마운트하지 않는다).
  const editorMaximized = editorShown && editorTabs.maximized;
  // 패널 토글 라벨: 파일 탭과 브라우저 탭을 따로 센다(브라우저만 열려 있는데 "코드 1" 로 보이지 않게).
  const fileTabCount = editorTabs.files.filter((f) => !isBrowserTab(f)).length;
  const browserTabCount = editorTabs.files.length - fileTabCount;
  const paneLabel = [fileTabCount > 0 ? t("chat.header.codeCount", { count: fileTabCount }) : null, browserTabCount > 0 ? t("chat.header.browserCount", { count: browserTabCount }) : null].filter(Boolean).join(" · ");
  const provider = config?.provider ?? tab.provider;

  const snippets = useSnippets();
  // "/" 자동완성용 슬래시 커맨드 목록. null = 해당 없음(Codex), [] = 아직 로딩 중.
  const [commands, setCommands] = useState<SlashCommandDto[] | null>(null);
  useEffect(() => {
    if (provider !== "claude" || !config) {
      setCommands(null);
      return;
    }
    let alive = true;
    setCommands([]);
    const load = () =>
      window.sudal.chat
        .commands(tabId)
        .then((c) => alive && setCommands(c))
        .catch(console.error);
    load();
    const off = window.sudal.chat.onCommandsChanged((changed) => {
      if (changed === cwd) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [tabId, provider, cwd, config !== null]);

  return (
    <OpenFileContext.Provider value={openFile}>
    <LocateFileContext.Provider value={locateFile}>
    <RunInTerminalContext.Provider value={cwd ? runInTerminal : null}>
      <div className="relative flex h-full flex-col">
        {/* 타이틀바 줄: 세션 제목·경로·모델과 버튼. 제목 중심 56px = 사이드바 로고 줄. 탭 스트립은 이 아래. */}
        {/* 헤더 폭이 800px 보다 좁으면(분할 칸·좁은 창) 버튼 글자를 숨기고 아이콘만 남긴다 — 글자는 툴팁. 안 그러면 오른쪽 버튼이 잘린다. */}
        <header className="@container/chathead drag flex h-[52px] shrink-0 items-center gap-3 overflow-hidden px-6 mac:h-[68px] mac:pt-4">
          {/* 제목·경로는 버튼에 밀려 사라지면 안 된다 — 최소 폭을 확보한다(버튼은 shrink-0 이라 제목만 줄어든다) */}
          <div className="min-w-[140px] flex-1 @min-[800px]/chathead:min-w-[220px]">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void commitRename();
                  else if (e.key === "Escape") setEditingTitle(false);
                }}
                placeholder={t("chat.header.sessionName")}
                className="no-drag -mx-1.5 w-full max-w-[480px] rounded-md border border-accent/50 bg-panel px-1.5 text-[15px] font-semibold outline-none"
                style={{ userSelect: "text" }}
              />
            ) : (
              <button
                onClick={startRename}
                title={t("chat.header.renameHint")}
                className="no-drag group -mx-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-panel-2"
              >
                <span className="truncate text-[15px] font-semibold">
                  {title}
                </span>
                <Icon
                  name="edit"
                  size={11}
                  className="shrink-0 text-muted opacity-0 group-hover:opacity-100"
                />
              </button>
            )}
            <div className="mono mt-0.5 flex items-center gap-2 overflow-hidden whitespace-nowrap text-[10.5px] text-muted">
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusDot(state.status)}`}
              />
              <span className="shrink-0">{workspace.name}</span>
              {/* 불러오기 전엔 세션 설정이 없어 워크스페이스 경로가 보인다. 이때 바꾸면 이어 갈 대화가 새로 시작되므로 숨긴다 */}
              {loaded && <span className="shrink-0">·</span>}
              {!loaded ? null : cwd ? (
                <button
                  onClick={() => void pickCwd()}
                  disabled={running}
                  className="no-drag flex min-w-0 items-center gap-1 truncate rounded px-1 hover:bg-panel-2 hover:text-fg disabled:hover:bg-transparent"
                  title={
                    running
                      ? cwd
                      : `${cwd}\n${t("chat.header.changeCwdHint")}`
                  }
                  data-cwd
                >
                  <Icon name="folder" size={10} className="shrink-0" />
                  <span className="truncate">{shortenHome(cwd)}</span>
                </button>
              ) : (
                <button
                  onClick={() => void pickCwd()}
                  className="no-drag flex shrink-0 items-center gap-1 rounded bg-accent-tint px-1.5 py-0.5 text-accent hover:bg-accent/15"
                  title={t("chat.header.pickCwdHint")}
                  data-cwd
                >
                  <Icon name="folder" size={10} />
                  {t("chat.header.pickCwd")}
                </button>
              )}
              {tab.worktree && (
                <WorktreeChip
                  tabId={tabId}
                  worktree={tab.worktree}
                  running={running}
                  onChanged={(snap) => snap && setConfig(snap)}
                />
              )}
              {(config?.model || state.model) && (
                <>
                  <span className="shrink-0">·</span>
                  <span
                    className="shrink-0"
                    title={t(`chat.header.modelTitle.${config?.model ? "set" : "default"}${state.model ? "Last" : ""}`, { model: config?.model, last: state.model })}
                    data-header-model
                  >
                    {headerModelLabel(config?.model, state.model)}
                  </span>
                </>
              )}
              {state.status === "queued" && (
                <>
                  <span className="shrink-0">·</span>
                  <span
                    className="shrink-0 text-accent-2"
                    title={t("chat.header.queuedHint")}
                    data-queue-status
                  >
                    {config?.queueInfo
                      ? t(config.queueInfo.waitingPermission > 0 ? "chat.header.queuePositionWaiting" : "chat.header.queuePosition", {
                          position: config.queueInfo.position,
                          running: config.queueInfo.running,
                          max: config.queueInfo.max,
                          waiting: config.queueInfo.waitingPermission,
                        })
                      : t("chat.header.queued")}
                  </span>
                  <button
                    onClick={() => onOpenSettings("general")}
                    className="no-drag shrink-0 text-muted underline-offset-2 hover:text-fg hover:underline"
                    title={t("chat.header.limitSettingHint")}
                  >
                    {t("chat.header.limitSetting")}
                  </button>
                </>
              )}
              {config?.handoffPending && (
                <>
                  <span>·</span>
                  <span className="text-accent">{t("chat.header.handoffPending")}</span>
                </>
              )}
            </div>
          </div>
          {editorTabs.files.length > 0 && (
            <button
              onClick={() => setEditorPaneVisible(tabId, !editorTabs.visible)}
              className={`no-drag flex min-h-[31px] shrink-0 items-center gap-2 rounded-md border py-1.5 px-2 @min-[800px]/chathead:px-3 ${
                editorShown
                  ? "border-accent/40 bg-accent-tint text-accent"
                  : "border-line bg-panel hover:bg-panel-2"
              }`}
              title={t(editorShown ? "chat.header.editorCollapse" : "chat.header.editorExpand", { label: paneLabel })}
              data-editor-toggle={editorShown ? "open" : "closed"}
            >
              {/* 옆의 "브라우저"(새 탭 열기) 버튼과 헷갈리지 않게 패널 아이콘 — 이 버튼은 패널을 접고 펴는 것 */}
              <Icon name="panelRight" size={11} className="size-[13px] @min-[800px]/chathead:size-[11px]" />
              <span className="hidden @min-[920px]/chathead:inline">{paneLabel}</span>
            </button>
          )}
          <button
            onClick={() => openBrowserTab(tabId)}
            className={`no-drag flex min-h-[31px] shrink-0 items-center gap-2 rounded-md border border-line bg-panel py-1.5 hover:bg-panel-2 px-2 @min-[800px]/chathead:px-3`}
            title={t("chat.header.openBrowserHint")}
            data-browser-open
          >
            <Icon name="globe" size={11} className="size-[13px] @min-[800px]/chathead:size-[11px]" />
            <span className="hidden @min-[800px]/chathead:inline">{browserTabCount > 0 ? t("chat.header.newBrowser") : t("chat.header.browser")}</span>
          </button>
          <div className="relative flex shrink-0 items-stretch" ref={verifyAnchor}>
            <button
              onClick={onVerifyClick}
              disabled={!cwd || verifyRunning}
              className={`no-drag flex min-h-[31px] items-center gap-2 rounded-l-md border border-line bg-panel py-1.5 hover:bg-panel-2 disabled:opacity-40 px-2 @min-[800px]/chathead:px-3`}
              title={savedVerify.length > 0 ? t("chat.header.runVerifyHint", { commands: savedVerify.join(" → ") }) : t("chat.header.setVerifyHint")}
              data-verify={verifyRunning ? "running" : savedVerify.length > 0 ? "ready" : "empty"}
            >
              {verifyRunning ? <span className="spin inline-block h-3 w-3 rounded-full border-[1.5px] border-accent border-t-transparent" /> : <Icon name="check" size={11} className="size-[13px] @min-[800px]/chathead:size-[11px]" />}
              <span className="hidden @min-[800px]/chathead:inline">{verifyRunning ? t("chat.header.verifying") : t("chat.header.verify")}</span>
            </button>
            <button
              ref={verifyToggle}
              onClick={() => setVerifyOpen((o) => !o)}
              disabled={!cwd}
              className={`no-drag flex min-h-[31px] items-center rounded-r-md border border-l-0 border-line px-1.5 py-1.5 hover:bg-panel-2 disabled:opacity-40 ${verifyOpen ? "bg-accent-tint text-accent" : "bg-panel text-muted"}`}
              title={t("chat.header.editVerify")}
              data-verify-edit
            >
              <Icon name="edit" size={10} />
            </button>
            {verifyOpen && <VerifyPopover tabId={tabId} anchor={verifyAnchor.current} toggle={verifyToggle.current} saved={savedVerify} onSave={saveVerify} onRun={(cmds) => void runVerify(cmds)} onClose={closeVerify} />}
          </div>
          <div className="relative flex shrink-0" ref={terminalAnchor}>
          <button
            onClick={() => (terminalOpen ? setTerminalOpen(false) : setTerminalMenuOpen((o) => !o))}
            disabled={!cwd}
            className={`no-drag flex min-h-[31px] shrink-0 items-center gap-2 rounded-md border py-1.5 disabled:opacity-40 px-1.5 @min-[800px]/chathead:px-3 ${
              terminalOpen
                ? "border-accent/40 bg-accent-tint text-accent hover:bg-accent/15"
                : "border-line bg-panel hover:bg-panel-2"
            }`}
            title={terminalOpen ? t("chat.header.closeTerminalHint") : t("chat.header.openTerminalHint")}
            data-terminal-toggle={terminalOpen ? "open" : "closed"}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded ${
                terminalOpen
                  ? "bg-accent text-on-accent"
                  : "bg-panel-2 text-muted"
              }`}
            >
              <Icon name="terminal" size={11} />
            </span>
            <span className="hidden @min-[800px]/chathead:inline">{t("chat.header.terminal")}</span>
          </button>
          {terminalMenuOpen && (
            <HeaderMenu
              anchor={terminalAnchor.current}
              onClose={() => setTerminalMenuOpen(false)}
              items={(["bottom", "right"] as const).map((d) => ({
                key: `terminal-${d}`,
                label: `${t(`chat.header.terminalDock.${d}.label`)}${d === terminalDock ? ` · ${scApp("terminal")}` : ""}`,
                icon: d === "bottom" ? "panelBottom" : "panelRight",
                hint: t(`chat.header.terminalDock.${d}.hint`),
                onSelect: () => openTerminalAt(d),
              }))}
            />
          )}
          </div>
          {terminalControlled && config?.terminalExternal ? (
            <span
              className="no-drag flex shrink-0 items-center gap-2 rounded-md border border-accent/40 bg-accent-tint px-3 py-1.5 text-accent"
              title={t("chat.header.externalHint")}
              data-external-terminal
            >
              <Icon name="terminal" size={12} />
              <span className="@min-[800px]/chathead:hidden">CLI</span>
              <span className="hidden @min-[800px]/chathead:inline">{t("chat.header.externalLabel")}</span>
            </span>
          ) : terminalControlled ? (
            <button
              onClick={detachTerminal}
              className="no-drag flex shrink-0 items-center gap-2 rounded-md border border-accent/40 bg-accent-tint px-3 py-1.5 text-accent hover:bg-accent/15"
              title={t("chat.header.detachHint")}
              data-detach-terminal
            >
              <Icon name="chat" size={12} />
              <span className="@min-[800px]/chathead:hidden">{t("chat.header.backToChatShort")}</span>
              <span className="hidden @min-[800px]/chathead:inline">{t("chat.header.backToChat")}</span>
            </button>
          ) : null}
          <div className="relative flex shrink-0" ref={moreAnchor}>
            <button
              onClick={() => setMoreOpen((o) => !o)}
              className={`no-drag flex min-h-[31px] items-center rounded-md border px-2 py-1.5 ${moreOpen ? "border-accent/40 bg-accent-tint text-accent" : "border-line bg-panel text-muted hover:bg-panel-2 hover:text-fg"}`}
              title={t("chat.header.moreHint")}
              data-header-more={moreOpen ? "open" : "closed"}
            >
              <Icon name="more" size={14} strokeWidth={3} />
            </button>
            {moreOpen && (
              <HeaderMenu
                anchor={moreAnchor.current}
                onClose={() => setMoreOpen(false)}
                items={[
                  {
                    key: "fanout",
                    label: t("chat.header.fanout.label"),
                    icon: "sparkles",
                    hint: t("chat.header.fanout.hint"),
                    disabled: !cwd || terminalControlled,
                    disabledReason: !cwd ? t("chat.header.needCwd") : t("chat.header.terminalControlled"),
                    onSelect: () => setFanoutOpen(true),
                  },
                  {
                    key: "cross-review",
                    label: t("chat.header.crossReview.label"),
                    icon: "switch",
                    hint: t("chat.header.crossReview.hint", { target: provider === "claude" ? "Codex" : "Claude Code" }),
                    disabled: !cwd || terminalControlled || reviewBusy,
                    disabledReason: reviewBusy ? t("chat.header.crossReview.busy") : !cwd ? t("chat.header.needCwd") : t("chat.header.terminalControlled"),
                    onSelect: () => void requestCrossReview(),
                  },
                  {
                    key: "orchestration",
                    label: t("chat.header.orchestration.label"),
                    icon: "list",
                    hint: t("chat.header.orchestration.hint"),
                    onSelect: () => setOrchPanel({ runId: null }),
                  },
                  {
                    key: "attach-terminal",
                    label: t("chat.header.attachTerminal.label"),
                    icon: "play",
                    hint: t("chat.header.attachTerminal.hint"),
                    disabled: !cwd || running || terminalControlled,
                    disabledReason: terminalControlled ? t("chat.header.attachTerminal.already") : running ? t("chat.header.attachTerminal.waitIdle") : t("chat.header.needCwd"),
                    onSelect: () => void attachTerminal(),
                  },
                ]}
              />
            )}
          </div>
          <button
            onClick={() => setSwitching(true)}
            className={`no-drag flex min-h-[31px] shrink-0 items-center rounded-md border border-line bg-panel py-1.5 hover:bg-panel-2 gap-1 px-1.5 @min-[800px]/chathead:gap-2 @min-[800px]/chathead:px-3`}
            title={PROVIDER_LABEL[provider]}
          >
            <ProviderLogo provider={provider} size={20} />
            <span className="hidden @min-[800px]/chathead:inline">{PROVIDER_LABEL[provider]}</span>
            <Icon name="chevronDown" size={12} className="text-muted" />
          </button>
          {onUnsplit && (
            <button
              onClick={onUnsplit}
              className="no-drag flex shrink-0 items-center rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
              title={t("chat.header.unsplit")}
              data-unsplit
            >
              <Icon name="x" size={13} />
            </button>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 채팅 칼럼은 340px 아래로 눌리지 않는다 — 공간이 모자라면 에디터 패널이 먼저 줄어든다(아래 flex-basis/shrink).
              최대화 때는 숨기기만 한다 — 언마운트하면 스크롤 위치·입력 중이던 글이 날아간다. */}
          {/* 격자 세 칸: a = 탭 줄·메시지, t = 터미널, b = 배너·입력창. 터미널이 아래면 a/t/b 로 쌓고, 오른쪽이면
              a·b 옆에 t 가 세로로 걸친다. 터미널은 자리를 바꿔도 같은 부모에 남는다 — 부모가 바뀌면 xterm 이 새로 만들어진다.
              오른쪽 열은 minmax(0, 폭) 이라 창이 좁으면 채팅(340px)보다 터미널이 먼저 줄어든다. */}
          <div
            className={`grid min-w-[340px] flex-1 ${editorMaximized ? "hidden" : ""}`}
            style={
              terminalRight
                ? { gridTemplateAreas: '"a t" "b t"', gridTemplateColumns: `minmax(340px, 1fr) minmax(0, ${terminalWidth}px)`, gridTemplateRows: "minmax(0, 1fr) auto" }
                : { gridTemplateAreas: '"a" "t" "b"', gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr) auto auto" }
            }
            onMouseDownCapture={() => setLastPane(tabId, "chat")}
            onFocusCapture={() => setLastPane(tabId, "chat")}
            data-chat-column
          >
            <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: "a" }}>
            {showTabStrip && <TabBar
              ws={ws}
              onActivate={onActivateTab}
              onClose={onCloseTab}
              onNew={onNewTab}
              onRename={(id) =>
                id === tabId ? startRename() : onActivateTab(id)
              }
            />}

            <div className="min-h-0 flex-1">
              <MessageList
                tabId={tabId}
                blocks={state.blocks}
                loading={!loaded}
                status={state.status}
                provider={provider}
                reasoning={state.reasoning}
                onRerunVerify={(cmds) => void runVerify(cmds)}
                onCompareFanout={setCompareFanoutId}
                onOpenOrchestration={(runId) => setOrchPanel({ runId })}
                turnStartedAt={config?.turnStartedAt ?? null}
                ambientFromBg={config?.ambientFromBg ?? false}
                sessionId={config?.sessionId ?? null}
                queuedCount={config?.pendingPrompts.length ?? 0}
              />
            </div>
            </div>

            {terminalMounted && cwd && (
              <TerminalPanel
                tabId={tabId}
                cwd={cwd}
                open={terminalOpen}
                onClose={() => setTerminalOpen(false)}
                onAttach={attachToChat}
                // 터미널이 세션을 쥐었으면(앱은 CLI 를 띄우기 전에 바꿔 둔다 — 다른 탭에 다녀와도 남는다) 셸을 만들지 않는다
                holdShell={attaching || terminalControlled}
                dock={terminalDock}
                onWidth={setTerminalWidth}
              />
            )}

            <div className="flex min-w-0 flex-col" style={{ gridArea: "b" }}>

            {state.pendingPermission && (
              <PermissionPrompt
                // 앞 요청이 남긴 선택이 새 질문의 답으로 새지 않게 요청마다 새로 만든다
                key={state.pendingPermission.requestId}
                request={state.pendingPermission}
                onAnswer={onAnswer}
              />
            )}

            {config?.limitWait && (
              <LimitWaitBanner tabId={tabId} wait={config.limitWait} onChanged={setConfig} />
            )}

            {concurrent.length > 0 && concurrentDismissed !== concurrentKey && (
              <div className="mx-6 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-[12px] text-warn" data-concurrent-banner>
                <Icon name="alert" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("chat.concurrent.message", { count: concurrent.length, titles: concurrent.map((x) => shortTitle(tabTitle(x, t("shared.untitledTab")))).join(", ") })}
                </span>
                <button onClick={() => onActivateTab(concurrent[0].id)} className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10" data-concurrent-view>
                  {t("chat.concurrent.view")}
                </button>
                <button onClick={onIsolate} className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10" title={t("chat.concurrent.isolateHint")} data-concurrent-isolate>
                  {t("chat.concurrent.isolate")}
                </button>
                <button onClick={() => setConcurrentDismissed(concurrentKey)} className="shrink-0 rounded p-0.5 hover:bg-warn/10" title={t("common.close")} data-concurrent-dismiss>
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}

            {(config?.pendingPrompts.length ?? 0) > 0 && (
              <PendingQueue
                tabId={tabId}
                items={config!.pendingPrompts}
                idle={(config!.status === "idle" || config!.status === "error") && !config!.limitWait}
                steerable={provider === "codex" && (config!.status === "running" || config!.status === "waiting_permission") && !terminalControlled}
                onChanged={setConfig}
              />
            )}

            {ctxBanner && (
              <div
                className={`mx-6 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${
                  ctxLevel === "critical"
                    ? "border-err/40 bg-err-bg text-err"
                    : "border-warn/40 bg-warn-bg text-warn"
                }`}
                data-context-banner={ctxLevel}
              >
                <Icon name="alert" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  {ctx?.window
                    ? t("chat.context.usedWithWindow", { pct: ctxPct, used: Math.round(Math.min(ctx.used, ctx.window) / 1000), window: Math.round(ctx.window / 1000) })
                    : t("chat.context.used", { pct: ctxPct })}{" "}
                  {ctxLevel === "critical" ? t("chat.context.adviceCritical") : t("chat.context.adviceWarn")}
                </span>
                <button
                  onClick={() => void compactContext()}
                  disabled={ctxBusy || running || terminalControlled}
                  className={`shrink-0 rounded border px-2 py-0.5 disabled:opacity-40 ${
                    ctxLevel === "critical"
                      ? "border-err/40 hover:bg-err/10"
                      : "border-warn/40 hover:bg-warn/10"
                  }`}
                  title={t("chat.context.compactHint")}
                  data-context-compact
                >
                  {ctxBusy ? t("chat.context.compacting") : t("chat.context.compact")}
                </button>
                <button
                  onClick={dismissCtx}
                  className="shrink-0 rounded p-0.5 hover:bg-fg/5"
                  data-context-dismiss
                  title={t("chat.context.dismissHint")}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}

            {(terminalControlled || attachError) && (
              <div
                className={`mx-6 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${
                  attachError
                    ? "border-err/40 bg-err-bg text-err"
                    : attention
                      ? "border-warn/40 bg-warn-bg text-warn"
                      : "border-accent/30 bg-accent-tint text-accent"
                }`}
                data-terminal-banner
                data-terminal-attention={attention ? attention.kind : undefined}
              >
                <Icon
                  name={attachError || attention ? "alert" : "terminal"}
                  size={13}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">
                  {attachError ??
                    (attention ? (
                      <>
                        {t("chat.terminalBanner.attention")}{" "}
                        <span className="font-medium">{attention.tool}</span>
                        {attention.summary && (
                          <code className="ml-1.5 rounded bg-fg/10 px-1 py-px font-mono text-[11px]">
                            {attention.summary}
                          </code>
                        )}
                      </>
                    ) : (
                      config?.terminalExternal
                        ? t("chat.terminalBanner.external")
                        : t("chat.terminalBanner.mirrored")
                    ))}
                </span>
                {attention && !terminalOpen && (
                  <button
                    onClick={toggleTerminal}
                    className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10"
                  >
                    {t("chat.terminalBanner.show")}
                  </button>
                )}
                {attachError && (
                  <button
                    onClick={() => setAttachError(null)}
                    className="rounded p-0.5 hover:bg-err/10"
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            )}

            <BackgroundJobsBar sessionId={config?.sessionId ?? null} />

            <Composer
              disabled={!cwd || terminalControlled}
              disabledText={
                terminalControlled ? t("chat.terminalBanner.controlled") : undefined
              }
              running={running}
              runningHint={agentBusy ? t(agentViaCodex ? "chat.composerHint.codex" : "chat.composerHint.subagent", { name: agentBusy }) : undefined}
              providerLabel={PROVIDER_LABEL[provider]}
              policy={config?.policy ?? "ask"}
              commands={commands}
              snippets={snippets}
              workspaceId={tab.workspaceId}
              draftKey={tabId}
              onSaveSnippet={(input) => window.sudal.snippets.save(input)}
              onSend={onSend}
              onAbort={() => void window.sudal.chat.abort(tabId)}
              onClear={() => void onClear()}
            />
            </div>
          </div>

          {editorShown && (
            <>
              {/* 최대화면 경계선을 숨긴다 — 끌 것이 없다 */}
              {!editorMaximized && (
                <div
                  onMouseDown={onEditorDragStart}
                  onDoubleClick={onEditorSplitEven}
                  title={t("chat.header.resizeHint")}
                  className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30"
                  data-editor-resizer
                />
              )}
              <div
                className={`mb-3 flex flex-col overflow-hidden rounded-xl bg-panel ${editorMaximized ? "ml-3 flex-1" : ""}`}
                style={editorMaximized ? undefined : { flex: `0 1 ${editorWidth}px`, minWidth: 360 }}
                onMouseDownCapture={() => setLastPane(tabId, "editor")}
                onFocusCapture={() => setLastPane(tabId, "editor")}
                data-editor-pane-shell
                data-editor-maximized={editorMaximized ? "true" : "false"}
              >
                <EditorPane tabId={tabId} cwd={cwd} tabs={editorTabs} onAttach={attachToChat} />
              </div>
            </>
          )}

          <div className={editorMaximized ? "hidden" : "contents"} data-right-panel-wrap>
          <RightPanel
            cwd={cwd}
            context={
              <ContextPanel
                state={state}
                config={config}
                onPolicy={onPolicy}
                onClear={() => void onClear()}
              />
            }
          />
          </div>
        </div>

        {fanoutOpen && <FanoutModal initialPrompt={loadComposerDraft(tabId)} defaultProvider={provider} onStart={startFanout} onClose={closeFanout} />}
        {orchPanel && <OrchestrationPanel initialRunId={orchPanel.runId} onClose={closeOrch} />}
        {compareFanoutId && (
          <FanoutCompare
            tabId={tabId}
            fanoutId={compareFanoutId}
            adoptedTabId={(state.blocks.find((b) => b.kind === "fanout" && b.id === compareFanoutId) as { adoptedTabId?: string } | undefined)?.adoptedTabId}
            onClose={closeCompare}
          />
        )}

        {modelPicker && config && (
          <ModelPickerModal
            provider={config.provider}
            current={config.model}
            onClose={() => setModelPicker(false)}
            onPick={setModel}
          />
        )}

        {switching && (
          <ProviderSwitchModal
            current={provider}
            running={running}
            onClose={() => setSwitching(false)}
            loadHandoff={loadHandoff}
            onSwitch={async (opts) => {
              setConfig(
                await window.sudal.chat.switchProvider(tabId, opts),
              );
            }}
          />
        )}

      </div>
    </RunInTerminalContext.Provider>
    </LocateFileContext.Provider>
    </OpenFileContext.Provider>
  );
}

function statusDot(status: string): string {
  switch (status) {
    case "running":
      return "bg-accent animate-pulse";
    case "queued":
      return "bg-accent-2";
    case "waiting_permission":
      return "bg-warn";
    case "error":
      return "bg-err";
    default:
      return "bg-ok";
  }
}

/** 격리 세션 표시: 브랜치 이름 칩. 누르면 상태(ahead/dirty)와 "가져오기"·"정리" 메뉴. */
function WorktreeChip({
  tabId,
  worktree,
  running,
  onChanged,
}: {
  tabId: string;
  worktree: WorktreeMeta;
  running: boolean;
  onChanged: (snapshot: SessionSnapshotDto | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WorktreeStatusDto | null>(null);
  const [busy, setBusy] = useState<"merge" | "remove" | null>(null);
  // 문구는 값으로 두고 그릴 때 번역한다(언어를 바꾸면 따라온다). text 는 main 이 준 오류 문구
  const [msg, setMsg] = useState<{ ok: true; merged: number } | { ok: false; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStatus(null);
    window.sudal.worktree.status(tabId).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [open, tabId, msg]);
  const merge = async () => {
    setBusy("merge");
    const r = await window.sudal.worktree.merge(tabId);
    setBusy(null);
    setMsg(r.ok ? { ok: true, merged: r.merged } : { ok: false, text: r.error });
  };
  const remove = async (force: boolean) => {
    setBusy("remove");
    const r = await window.sudal.worktree.remove(tabId, { force });
    setBusy(null);
    setConfirmRemove(false);
    if (r.ok) {
      setOpen(false);
      onChanged(await window.sudal.chat.snapshot(tabId));
    } else setMsg({ ok: false, text: r.error });
  };
  return (
    <span className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="no-drag flex items-center gap-1 rounded bg-accent-tint px-1.5 py-0.5 text-accent hover:bg-accent/15"
        title={t("chat.worktree.chipTitle", { branch: worktree.branch, path: worktree.path })}
        data-worktree-chip
      >
        <Icon name="branch" size={10} />
        {worktree.branch.replace(/^sudal\//, "")}
      </button>
      {open && (
        <div
          className="no-drag absolute left-0 top-full z-30 mt-1 w-[320px] rounded-md border border-line bg-panel p-2 text-[11.5px] shadow-xl"
          data-worktree-menu
        >
          <div className="mono px-1 pb-1.5 text-[10.5px] text-muted">
            {worktree.branch} → {worktree.base}
            {status ? (
              <>
                {" · "}
                {status.exists ? (
                  <>
                    <Trans i18nKey="chat.worktree.ahead" values={{ count: status.ahead }} components={{ n: <span className="text-fg" /> }} />
                    {status.behind > 0 && t("chat.worktree.behind", { count: status.behind })}
                    {status.dirty > 0 && <span className="text-warn">{t("chat.worktree.dirty", { count: status.dirty })}</span>}
                  </>
                ) : (
                  <span className="text-err">{t("chat.worktree.missing")}</span>
                )}
              </>
            ) : (
              ` · ${t("chat.worktree.checking")}`
            )}
          </div>
          <button
            onClick={() => void merge()}
            disabled={busy !== null || running || !status?.exists || status.ahead === 0 || status.dirty > 0}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2 disabled:opacity-40"
            title={status?.dirty ? t("chat.worktree.mergeBlocked") : t("chat.worktree.mergeHint", { base: worktree.base })}
            data-worktree-merge
          >
            <Icon name="check" size={12} className="text-accent" />
            {busy === "merge" ? t("chat.worktree.merging") : t("chat.worktree.merge", { base: worktree.base })}
          </button>
          {!confirmRemove ? (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={busy !== null || running}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2 disabled:opacity-40"
              title={t("chat.worktree.removeHint")}
              data-worktree-remove
            >
              <Icon name="trash" size={12} className="text-muted" />
              {t("chat.worktree.remove")}
            </button>
          ) : (
            <div className="mt-1 flex items-center gap-2 rounded-md border border-err/40 bg-err-bg px-2 py-1.5 text-err" data-worktree-confirm>
              <span className="min-w-0 flex-1">
                {status?.dirty ? t("chat.worktree.confirmDirty", { count: status.dirty }) : t("chat.worktree.confirmPlain")}
                {status && status.ahead > 0 ? ` ${t("chat.worktree.confirmAhead")}` : ""}
              </span>
              <button
                onClick={() => void remove(Boolean(status?.dirty))}
                className="rounded bg-err px-2 py-0.5 font-medium text-white hover:opacity-90"
                data-worktree-confirm-yes
              >
                {t("chat.worktree.confirmYes")}
              </button>
              <button onClick={() => setConfirmRemove(false)} className="rounded px-1.5 py-0.5 hover:bg-err/10">
                {t("common.cancel")}
              </button>
            </div>
          )}
          {msg && (
            <div className={`mono mt-1 px-1 text-[10.5px] ${msg.ok ? "text-ok" : "text-err"}`} data-worktree-msg>
              {msg.ok ? (msg.merged === 0 ? t("chat.worktree.nothingToMerge") : t("chat.worktree.merged", { count: msg.merged, base: worktree.base })) : msg.text}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** 프롬프트 큐: 턴 진행 중에 써 둔 다음 지시들. 편집·삭제할 수 있고, 턴이 끝나면 위에서부터 자동 전송된다. */
function PendingQueue({
  tabId,
  items,
  idle,
  steerable,
  onChanged,
}: {
  tabId: string;
  items: PendingPromptDto[];
  /** 턴이 돌고 있지 않다(앱 재시작으로 복원됐거나 오류로 멈춘 뒤): 자동으로 나가지 않으니 "지금 보내기" 를 준다. */
  idle: boolean;
  /** Codex 가 작업 중이다: 턴이 끝나길 기다리지 않고 지금 끼워 넣을 수 있다("지금 반영"). */
  steerable: boolean;
  onChanged: (snapshot: SessionSnapshotDto) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const [steerError, setSteerError] = useState<string | null>(null);
  const steer = async (id: string) => {
    setSteering(id);
    setSteerError(null);
    const r = await window.sudal.chat.queueSteer(tabId, id);
    setSteering(null);
    onChanged(r.snapshot);
    if (!r.ok) setSteerError(r.error ?? ""); // 빈 문자열이면 기본 문구를 그릴 때 번역한다
  };
  const save = async () => {
    if (!editing) return;
    onChanged(await window.sudal.chat.queueUpdate(tabId, editing.id, editing.text));
    setEditing(null);
  };
  return (
    <div className="mx-6 mb-2 rounded-md border border-line bg-panel px-3 py-2 text-[12px]" data-pending-queue>
      <div className="label mb-1 flex items-center gap-1.5 text-muted">
        <Icon name="clock" size={11} />
        {idle ? t("chat.pending.idle", { count: items.length }) : t("chat.pending.next", { count: items.length })}
        {idle && (
          <button
            onClick={() => void window.sudal.chat.queueSendNext(tabId).then(onChanged)}
            className="ml-auto rounded border border-line px-1.5 py-0.5 text-[11px] text-fg hover:bg-panel-2"
            title={t("chat.pending.sendNextHint")}
            data-pending-send-next
          >
            {t("chat.pending.sendNext")}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((p, i) => (
          <li key={p.id} className="flex items-start gap-2" data-pending-item>
            <span className="mono mt-0.5 w-4 shrink-0 text-muted-2">{i + 1}</span>
            {editing?.id === p.id ? (
              <textarea
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void save();
                  } else if (e.key === "Escape") setEditing(null);
                }}
                rows={2}
                className="min-w-0 flex-1 resize-none rounded border border-accent/50 bg-inset px-2 py-1 text-fg outline-none"
                style={{ userSelect: "text" }}
              />
            ) : (
              <button
                onClick={() => steering !== p.id && setEditing({ id: p.id, text: p.text })}
                className="min-w-0 flex-1 truncate rounded px-1 text-left text-fg hover:bg-panel-2"
                title={`${p.text}\n\n${t("chat.pending.editHint")}`}
              >
                {p.text || t("chat.pending.imageOnly")}
                {p.hasImages && <span className="ml-1 text-muted">📎</span>}
              </button>
            )}
            {steerable && editing?.id !== p.id && (
              <button
                onClick={() => void steer(p.id)}
                disabled={steering !== null}
                className="flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-fg hover:bg-panel-2 disabled:opacity-40"
                title={t("chat.pending.steerHint")}
                data-pending-steer
              >
                <Icon name="play" size={9} />
                {steering === p.id ? t("chat.pending.steering") : t("chat.pending.steer")}
              </button>
            )}
            <button
              onClick={() => void window.sudal.chat.queueRemove(tabId, p.id).then(onChanged)}
              disabled={steering === p.id}
              className="shrink-0 rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
              title={t("chat.pending.removeHint")}
              data-pending-remove
            >
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}
      </ul>
      {steerError !== null && (
        <div className="mt-1 px-1 text-[11px] text-err" data-pending-steer-error>
          {steerError || t("chat.pending.steerFailed")}
        </div>
      )}
    </div>
  );
}

/** 사용 한도 도달: 리셋 시각까지 남은 시간을 세며 자동 재시도를 알리고, 지금 재시도·취소를 준다. */
function LimitWaitBanner({
  tabId,
  wait,
  onChanged,
}: {
  tabId: string;
  wait: LimitWaitDto;
  onChanged: (snapshot: SessionSnapshotDto) => void;
}) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const remainMin = wait.until ? Math.max(0, Math.ceil((wait.until - now) / 60_000)) : null;
  const at = wait.until ? new Date(wait.until).toLocaleTimeString(intlLocale(i18n.language as Locale), { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div
      className="mx-6 mb-2 flex items-center gap-2 rounded-md border border-warn/40 bg-warn-bg px-3 py-2 text-[12px] text-warn"
      data-limit-banner
    >
      <Icon name="clock" size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={wait.message}>
        {t("chat.limit.reached")}{" "}
        {at
          ? t(wait.attempts > 1 ? "chat.limit.retryAtAttempt" : "chat.limit.retryAt", { time: at, minutes: remainMin, attempt: wait.attempts })
          : t("chat.limit.notScheduled")}
      </span>
      <button
        onClick={() => void window.sudal.chat.limitRetryNow(tabId).then(onChanged)}
        className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10"
        data-limit-retry
      >
        {t("chat.limit.retryNow")}
      </button>
      <button
        onClick={() => void window.sudal.chat.limitCancel(tabId).then(onChanged)}
        className="shrink-0 rounded p-0.5 hover:bg-fg/5"
        title={t("chat.limit.cancelRetry")}
        data-limit-cancel
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
