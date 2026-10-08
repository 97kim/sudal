// 채팅 아래 통합 터미널 패널. ⌘J 로 열고 닫는다. 패널 안에 터미널 탭이 여러 개 있고(셸 t1, t2 …), 하이브리드 모드의 CLI 는
// "cli" 탭으로 들어온다. 닫아도 xterm 은 숨김(hidden)으로 유지해 스크롤백이 남고, 프로세스는 main 이 "<채팅탭 id>:<이름>" 으로 들고 있다.
// 채팅 탭을 오가며 다시 마운트되면 main 의 목록과 백로그로 화면을, kv 에 저장한 배치(높이·분할·활성 탭)로 자리를 복원한다.
//
// 포커스가 이 패널 안에 있을 때 ⌘W·⌘K·⌘F 는 App 이 "sudal:terminal-command" 로 넘겨 준다 — 세션 닫기·워크스페이스 전환·
// 대화 검색 대신 터미널 닫기·화면 지우기·터미널 안 찾기. 대상은 마지막으로 포커스가 있던 터미널(focused)이다. 나뉜 화면에서는
// 첫 칸(active)과 포커스가 다를 수 있어서 active 를 기준으로 하면 엉뚱한 칸이 닫힌다.

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_CLEAR_MARK, type TerminalInfoDto } from "@shared/ipc";
import { Icon } from "./Icon";
import { onThemeChange } from "../theme";
import { formatTerminalAttachment } from "@shared/attachments";
import { findFileRefs } from "@shared/file-refs";
import { loadTerminalLayout, removePane, saveTerminalLayout, selectPane, TERMINAL_MIN_WIDTH, type SplitDir, type TerminalDock } from "../terminal-panes";
import { cellRangeFor, createLocateCache, pickCandidate, type CellLike } from "../terminal-links";
import { canDeliver, forgetTerminalGate, noteDelivered, onTerminalRun, peekTerminalRun, pendingTerminalRuns, pickShellTarget, promptEpoch, takeTerminalRun } from "../terminal-run";
import { linkTargetFor, setLinkOpenMode } from "../link-open";
import { useLocateFile, useOpenFile } from "./FileViewer";
import { LinkChooser } from "./LinkChooser";
import { PaneSplitContext } from "../pane-focus";
import { shortenHome } from "@shared/path-display";
import { startDrag } from "../drag";
import { IS_MAC, IS_WIN, isMod } from "../platform";
import { passesToAppMenu } from "@shared/app-shortcuts";

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 260;
const maxHeight = () => Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.7));

export type TerminalCommand = "close" | "clear" | "find";

interface TermTab {
  id: string;
  kind: "shell" | "command";
  title: string;
}

interface FindResult {
  id: string;
  index: number;
  count: number;
}

export function TerminalPanel({
  tabId,
  cwd,
  open,
  onClose,
  onAttach,
  dock = "bottom",
  onWidth,
}: {
  tabId: string;
  cwd: string;
  open: boolean;
  onClose: () => void;
  /** 채팅 아래(높이 조절) 또는 오른쪽(폭 조절). 오른쪽 폭은 ChatView 가 격자 열로 정한다. */
  dock?: TerminalDock;
  onWidth?: (width: number) => void;
  /** "채팅에 첨부": 포커스가 있던 터미널의 선택 영역(없으면 최근 출력 40줄)을 입력창에 잇는다. */
  onAttach?: (block: string) => void;
}) {
  // 이 파일은 탭을 `t` 로 부르는 곳이 많아 번역 함수는 tr 로 받는다.
  const { t: tr } = useTranslation();
  const terms = useRef(new Map<string, Terminal>());
  const searches = useRef(new Map<string, SearchAddon>());
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  /** 마지막으로 포커스가 있던 터미널. 단축키·첨부·찾기의 대상. */
  const [focused, setFocused] = useState<string | null>(null);
  /**
   * 화면을 둘로 나눠 쓴다. dir="row" 는 좌우, "col" 은 상하. 두 쪽까지만 — 중첩은 하지 않는다.
   * 터미널을 다른 부모로 옮기면 xterm 이 새로 만들어져 내용이 날아가므로, 부모는 그대로 두고
   * 인라인 스타일로 자리만 바꾼다.
   */
  const [split, setSplit] = useState<{ dir: SplitDir; id: string } | null>(null);
  const [ratio, setRatio] = useState(50);
  const areaRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const prefix = `${tabId}:`;
  /** pty 가 붙은 터미널들 — "터미널에서 실행" 요청은 대상이 여기 들어온 뒤에 보낸다. */
  const [ready, setReady] = useState<Set<string>>(() => new Set());
  const markReady = (id: string, ok: boolean) =>
    setReady((prev) => {
      if (prev.has(id) === ok) return prev;
      const next = new Set(prev);
      if (ok) next.add(id);
      else next.delete(id);
      return next;
    });
  /** 잠깐 보여 주는 안내(클립보드에 복사했다 등). */
  const [notice, setNotice] = useState<string | null>(null);
  const showNotice = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  };

  /** 단축키·첨부·찾기가 향하는 터미널: 포커스가 있던 것, 그것이 없어졌으면 첫 칸. */
  const target = focused && tabs.some((t) => t.id === focused) ? focused : active;

  const attachTarget = () => {
    if (!target || !onAttach) return;
    const term = terms.current.get(target);
    if (!term) return;
    const title = tabs.find((t) => t.id === target)?.title || tr("panel.terminal.shell");
    onAttach(terminalAttachment(tr, term, title));
  };

  // main 에 이미 떠 있는 터미널(채팅 탭 전환 전에 만든 것)을 복원한다. 없으면 셸 하나를 만든다.
  useEffect(() => {
    let alive = true;
    window.sudal.terminal.list(tabId).then((list) => {
      if (!alive) return;
      const restored = list.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
      }));
      if (restored.length === 0)
        restored.push({ id: `${prefix}t1`, kind: "shell", title: "" });
      const layout = loadTerminalLayout(
        tabId,
        restored.map((t) => t.id),
        {
          active: restored.find((t) => t.kind === "command")?.id ?? restored[restored.length - 1].id,
          height: DEFAULT_HEIGHT,
        },
        { minHeight: MIN_HEIGHT, maxHeight: maxHeight() },
      );
      setTabs(restored);
      setActive(layout.active);
      setSplit(layout.split);
      setHeight(layout.height);
      setRatio(layout.ratio);
      setLoaded(true);
    });
    const offOpened = window.sudal.terminal.onOpened(
      (info: TerminalInfoDto) => {
        if (!info.id.startsWith(prefix)) return;
        setTabs((prev) =>
          prev.some((t) => t.id === info.id)
            ? prev.map((t) =>
                t.id === info.id
                  ? { ...t, kind: info.kind, title: info.title }
                  : t,
              )
            : [...prev, { id: info.id, kind: info.kind, title: info.title }],
        );
        if (info.kind === "command") setActive(info.id);
      },
    );
    return () => {
      alive = false;
      offOpened();
    };
  }, [tabId, prefix]);

  // 배치는 바뀔 때마다 저장한다. 채팅 탭을 오가면 이 컴포넌트가 다시 마운트되기 때문이다.
  useEffect(() => {
    if (!loaded) return;
    saveTerminalLayout(tabId, { active, split, height, ratio });
  }, [loaded, tabId, active, split, height, ratio]);

  const nextTermId = () => {
    const nums = tabs.map((t) => Number(/:t(\d+)$/.exec(t.id)?.[1] ?? 0));
    return `${prefix}t${Math.max(0, ...nums) + 1}`;
  };

  const addTab = () => {
    const id = nextTermId();
    setTabs((prev) => [...prev, { id, kind: "shell", title: "" }]);
    setActive(id);
  };

  const selectTab = (id: string) => {
    const l = selectPane({ active, split }, id);
    setActive(l.active);
    setSplit(l.split);
    // 고른 터미널이 이미 보이던 칸이면(분할 해제) 저절로 포커스를 잡지 않는다 — 그대로 두면 ⌘W 가 숨겨진 쪽을 닫는다.
    setFocused(id);
    setTimeout(() => terms.current.get(id)?.focus(), 0);
  };

  /**
   * ⌘⌥방향키로 옆 칸에 포커스를 준다. 방향은 나뉜 축으로만 읽는다 —
   * 좌우로 나뉜 화면에서 위아래를 누르면 갈 곳이 없으므로 아무 일도 하지 않는다.
   */
  const focusPane = (dir: "left" | "right" | "up" | "down") => {
    if (!split) return false;
    const second = split.dir === "row" ? dir === "right" : dir === "down";
    const first = split.dir === "row" ? dir === "left" : dir === "up";
    if (!second && !first) return false;
    const id = second ? split.id : active;
    const term = id ? terms.current.get(id) : null;
    // 이미 그 칸이면 옮긴 게 아니다 — false 여야 채팅 화면 분할의 옆 칸으로 넘어간다
    if (!term || term.element?.contains(document.activeElement)) return false;
    term.focus();
    return true;
  };

  /** ⌘D 좌우, ⌘⇧D 상하. 이미 나뉘어 있으면 방향만 바꾼다 — 셸을 더 띄우지 않는다. */
  const splitTerm = (dir: SplitDir) => {
    if (split) {
      setSplit({ ...split, dir });
      return;
    }
    const id = nextTermId();
    setTabs((prev) => [...prev, { id, kind: "shell", title: "" }]);
    setSplit({ dir, id });
    setRatio(50);
  };

  const closeAll = () => {
    for (const t of tabs) {
      void window.sudal.terminal.close(t.id);
      forgetTerminalGate(t.id);
    }
    setTabs([]);
    setActive(null);
    setSplit(null);
    setFocused(null);
    setLoaded(false);
    onClose();
    // 다음에 열면 셸 하나로 다시 시작
    setTimeout(() => {
      setTabs([{ id: `${prefix}t1`, kind: "shell", title: "" }]);
      setActive(`${prefix}t1`);
      setLoaded(true);
    }, 0);
  };

  /** 터미널 하나를 끝낸다. 마지막 하나면 패널을 접는다 — 빈 패널은 쓸모가 없다. */
  const closeTab = (id: string) => {
    if (tabs.length <= 1) {
      closeAll();
      return;
    }
    void window.sudal.terminal.close(id);
    forgetTerminalGate(id);
    const l = removePane({ active, split }, tabs.map((t) => t.id), id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActive(l.active);
    setSplit(l.split);
    // 닫힌 칸에 있던 포커스는 남은 칸으로. 숨겨져 있던 터미널은 보이면서 스스로 포커스를 잡지만, 나뉘어 있던 쪽은 그렇지 않다.
    if (focused === id && l.active) {
      const next = l.active;
      setFocused(next);
      setTimeout(() => terms.current.get(next)?.focus(), 0);
    }
  };

  // "터미널에서 실행": 큐에 든 요청을 대상 셸이 준비된 뒤 한 번만 가져간다. 대상이 없으면 셸을 만들고, 숨겨져 있으면 보이게 해서
  // pty 가 붙기를 기다린다(그 변화로 이 효과가 다시 돈다). 붙여넣기는 셸이 프롬프트에서 입력을 기다릴 때만 — xterm 의 bracketed paste
  // 모드는 zsh·bash·fish 가 프롬프트에서만 켜고 vim·less·실행 중 프로그램에서는 꺼져 있어서 "지금 받아도 되는가" 의 판정으로 쓴다.
  const [runTick, setRunTick] = useState(0);
  useEffect(() => onTerminalRun(() => setRunTick((t) => t + 1)), []);
  /** 프롬프트를 기다리는 중: 새 셸은 pty 가 붙은 뒤에도 잠깐 지나야 프롬프트(와 bracketed paste)가 뜬다. */
  const runWait = useRef<{ id: string; until: number } | null>(null);
  // 프롬프트 세대·전달 기록은 terminal-run.ts 에 산다(pty 수명을 따라야 해서 — 채팅 탭을 오가면 이 컴포넌트는 다시 마운트된다).
  // 새 프롬프트가 오면 그 모듈이 onTerminalRun 리스너를 깨워 runTick 이 는다.
  useEffect(() => {
    if (!loaded) return;
    const req = peekTerminalRun(tabId);
    if (!req) return;
    const id = pickShellTarget(tabs, focused);
    if (!id) {
      addTab();
      return;
    }
    if (id !== active && id !== split?.id) {
      selectTab(id);
      return;
    }
    if (!ready.has(id)) return;
    const term = terms.current.get(id);
    if (!term) return;
    const later = () => {
      const t = setTimeout(() => setRunTick((x) => x + 1), 120);
      return () => clearTimeout(t);
    };
    // Windows(PowerShell)는 프롬프트에서 bracketed paste 를 켜지 않아 "입력을 기다리나" 를 알 수 없다 — 기다리지 않고 넣기만 하고
    // Enter 는 늘 사용자에게 맡긴다. 여러 줄은 넣는 순간 줄마다 실행되므로 넣지 않고 복사한다.
    if (IS_WIN) {
      takeTerminalRun(tabId);
      // vim·less 같은 대체 화면이면 그 프로그램에 입력되니(vim 일반 모드는 Enter 없이도 명령이 된다) 넣지 않고 복사한다
      const alternate = term.buffer.active.type === "alternate";
      if (req.command.includes("\n") || alternate) {
        navigator.clipboard.writeText(req.command).then(
          () => showNotice(tr(alternate ? "panel.terminal.copiedNotReady" : "panel.terminal.copiedMultiline")),
          () => showNotice(tr("panel.terminal.copyFailedNotReady")),
        );
      } else term.paste(req.command);
      term.focus();
      if (pendingTerminalRuns(tabId) > 0) return later();
      return;
    }
    if (!canDeliver(id)) return; // 앞서 넣은 것이 아직 실행되지 않았다 — 새 프롬프트가 오면 다시 깬다
    // 셸이 프롬프트에서 입력을 기다리나 — 일반 화면 + bracketed paste(zsh·bash·fish 는 프롬프트에서만 켠다). vim·less 는 alternate 화면이라 걸러지고,
    // 실행 중인 프로그램·bracketed paste 없는 REPL 은 모드가 꺼져 있어 걸러진다. 확실하지 않으면 넣지 않고 복사한다.
    const atPrompt = () => term.buffer.active.type === "normal" && term.modes.bracketedPasteMode;
    if (!atPrompt()) {
      // 새 셸은 pty 가 붙은 뒤에도 잠깐 지나야 프롬프트가 뜬다 — 2초까지 기다린다
      const w = runWait.current && runWait.current.id === id ? runWait.current : { id, until: Date.now() + 2000 };
      runWait.current = w;
      if (Date.now() < w.until) return later();
    }
    runWait.current = null;
    takeTerminalRun(tabId);
    if (!atPrompt()) {
      navigator.clipboard.writeText(req.command).then(
        () => showNotice(tr("panel.terminal.copiedNotReady")),
        () => showNotice(tr("panel.terminal.copyFailedNotReady")),
      );
      term.focus();
      if (pendingTerminalRuns(tabId) > 0) return later();
      return;
    }
    term.paste(req.command);
    if (req.run) window.sudal.terminal.write(id, "\r");
    noteDelivered(id, promptEpoch(id));
    term.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, runTick, tabs, ready, focused, active, split, tabId]);

  // ⌘F: 패널 안 찾기. 대상은 target 터미널 하나이고, 다른 터미널로 포커스가 옮겨 가면 그쪽에서 다시 찾는다.
  const [find, setFind] = useState(false);
  const [query, setQuery] = useState("");
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findOpts = () => {
    const t = readTheme();
    return {
      decorations: {
        matchBackground: t.accentTint,
        matchBorder: t.accent,
        matchOverviewRuler: t.accent,
        activeMatchBackground: t.accent,
        activeMatchBorder: t.accent,
        activeMatchColorOverviewRuler: t.accent,
      },
    };
  };
  const doFind = (q: string, dir: "next" | "prev", incremental = false) => {
    if (!target) return;
    const s = searches.current.get(target);
    if (!s) return;
    if (!q) {
      s.clearDecorations();
      setFindResult(null);
      return;
    }
    const opts = { ...findOpts(), incremental };
    if (dir === "next") s.findNext(q, opts);
    else s.findPrevious(q, opts);
  };
  const openFind = () => {
    setFind(true);
    // 이미 열려 있으면 입력창으로 돌아가 전체 선택 — 다시 치면 바로 바뀌게.
    setTimeout(() => {
      findInput.current?.focus();
      findInput.current?.select();
    }, 0);
  };
  const closeFind = () => {
    setFind(false);
    setFindResult(null);
    for (const s of searches.current.values()) s.clearDecorations();
    if (target) terms.current.get(target)?.focus();
  };
  const prevTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!find) {
      prevTarget.current = target;
      return;
    }
    if (prevTarget.current && prevTarget.current !== target)
      searches.current.get(prevTarget.current)?.clearDecorations();
    prevTarget.current = target;
    doFind(query, "next", true);
    // query 는 입력 핸들러가 직접 찾는다 — 여기서는 대상이 바뀌었을 때만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, target]);

  // App 이 넘겨 주는 ⌘W·⌘K·⌘F. 핸들러는 렌더마다 바뀌므로 ref 로 최신 것을 본다.
  const commands = useRef<Record<TerminalCommand, () => void>>({ close: () => {}, clear: () => {}, find: () => {} });
  commands.current = {
    close: () => {
      if (target) closeTab(target);
    },
    clear: () => {
      // 화면은 여기서 바로 지우지 않는다. main 이 백로그를 비운 자리에 표시를 끼워 보내면 TerminalView 가 그 순서에 맞춰 지운다.
      if (target) window.sudal.terminal.clear(target);
    },
    find: openFind,
  };
  useEffect(() => {
    // 분할 화면엔 터미널 패널이 둘일 수 있다 — 포커스가 이 패널 안에 있을 때만 받는다(App 은 포커스가 어떤 터미널 패널 안일 때 보낸다).
    const onCmd = (e: Event) => {
      if (!panelRef.current?.contains(document.activeElement)) return;
      commands.current[(e as CustomEvent<TerminalCommand>).detail]?.();
    };
    window.addEventListener("sudal:terminal-command", onCmd);
    return () => window.removeEventListener("sudal:terminal-command", onCmd);
  }, []);

  // 오른쪽에 있을 때: 채팅 칼럼(격자)에서 채팅 몫 340px 을 남기는 데까지.
  const maxWidth = () => Math.max(TERMINAL_MIN_WIDTH, (panelRef.current?.parentElement?.getBoundingClientRect().width ?? 0) - 340);

  // 드래그로 높이 조절 (패널 상단 가장자리). 오른쪽에 있으면 왼쪽 가장자리로 폭 조절.
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    if (dock === "right") {
      const startX = e.clientX;
      const startW = panelRef.current?.getBoundingClientRect().width ?? 0;
      const max = maxWidth();
      const moveX = (ev: MouseEvent) => onWidth?.(Math.min(max, Math.max(TERMINAL_MIN_WIDTH, startW + (startX - ev.clientX))));
      startDrag(moveX);
      return;
    }
    const startY = e.clientY;
    const startH = height;
    const max = maxHeight();
    const move = (ev: MouseEvent) =>
      setHeight(
        Math.min(max, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY))),
      );
    startDrag(move);
  };

  // 두 번 누르면 위아래 반반. 에디터 분할과 같은 규칙이다 — 막대 양옆 두 영역만 기준으로 삼는다.
  const onSplitEven = (e: React.MouseEvent) => {
    const panel = (e.currentTarget as HTMLElement).parentElement;
    const above = panel?.previousElementSibling as HTMLElement | null;
    if (!panel || !above) return;
    if (dock === "right") {
      const half = (above.getBoundingClientRect().width + panel.getBoundingClientRect().width) / 2;
      onWidth?.(Math.min(maxWidth(), Math.max(TERMINAL_MIN_WIDTH, Math.round(half))));
      return;
    }
    const max = maxHeight();
    const half = (above.getBoundingClientRect().height + panel.getBoundingClientRect().height) / 2;
    setHeight(Math.min(max, Math.max(MIN_HEIGHT, Math.round(half))));
  };

  return (
    <div
      className={`no-drag relative min-h-0 min-w-0 shrink-0 border-line bg-inset ${dock === "right" ? "border-l" : "border-t"}`}
      ref={panelRef}
      style={dock === "right" ? { gridArea: "t" } : { gridArea: "t", height }}
      hidden={!open}
      data-terminal-panel
      data-terminal-dock={dock}
    >
      <div
        onMouseDown={onDragStart}
        onDoubleClick={onSplitEven}
        title={dock === "right" ? tr("panel.terminal.resizeWidth") : tr("panel.terminal.resizeHeight")}
        className={`absolute z-10 ${dock === "right" ? "-left-1 bottom-0 top-0 w-2 cursor-col-resize" : "-top-1 left-0 right-0 h-2 cursor-row-resize"}`}
        data-terminal-resizer
      />
      <div className="flex h-8 items-center gap-1 px-2">
        <Icon name="terminal" size={12} className="ml-1 shrink-0 text-muted" />
        <div
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          data-terminal-tabs
        >
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => selectTab(t.id)}
              className={`group flex shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                t.id === active
                  ? "bg-panel text-fg"
                  : "text-muted hover:bg-panel/60 hover:text-fg"
              }`}
              data-terminal-tab={t.id}
              data-active={t.id === active ? "true" : "false"}
            >
              {t.kind === "command" && (
                <Icon name="play" size={10} className="text-accent" />
              )}
              <span className="mono">{t.title || tr("panel.terminal.shell")}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                className="rounded p-0.5 text-muted opacity-0 hover:bg-panel-2 hover:text-err group-hover:opacity-100"
                title={t.kind === "command" ? tr("panel.terminal.closeCli") : tr("panel.terminal.closeShell")}
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
          <button
            onClick={addTab}
            className="shrink-0 rounded p-1 text-muted hover:bg-panel/60 hover:text-fg"
            title={tr("panel.terminal.newTab")}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        <span
          className="mono hidden min-w-0 max-w-[38%] shrink truncate text-[10.5px] text-muted-2 sm:block"
          title={cwd}
        >
          {shortenHome(cwd)}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {onAttach && (
            <button
              onClick={attachTarget}
              className="mr-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
              title={tr("panel.terminal.attachTitle")}
              data-attach-chat-terminal
            >
              <Icon name="chat" size={11} />
              {tr("panel.terminal.attach")}
            </button>
          )}
          <button
            onClick={() => splitTerm("row")}
            className={`rounded p-1 hover:bg-panel-2 hover:text-fg ${split?.dir === "row" ? "text-accent" : "text-muted"}`}
            title={tr("panel.terminal.splitRow")}
            data-terminal-split="row"
          >
            <Icon name="splitRow" size={12} />
          </button>
          <button
            onClick={() => splitTerm("col")}
            className={`rounded p-1 hover:bg-panel-2 hover:text-fg ${split?.dir === "col" ? "text-accent" : "text-muted"}`}
            title={tr("panel.terminal.splitCol")}
            data-terminal-split="col"
          >
            <Icon name="splitCol" size={12} />
          </button>
          <button
            onClick={openFind}
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
            title={tr("panel.terminal.findToggle")}
            data-terminal-find-toggle
          >
            <Icon name="search" size={12} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
            title={tr("panel.terminal.collapse")}
          >
            <Icon name="minus" size={12} />
          </button>
          <button
            onClick={closeAll}
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-err"
            title={tr("panel.terminal.closeAll")}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-8" ref={areaRef}>
        {loaded &&
          tabs.map((t) => (
            <TerminalView
              key={t.id}
              termId={t.id}
              kind={t.kind}
              cwd={cwd}
              visible={open && (t.id === active || t.id === split?.id)}
              style={paneStyle(split, ratio, t.id === split?.id)}
              onRegister={(term, search) => {
                if (term && search) {
                  terms.current.set(t.id, term);
                  searches.current.set(t.id, search);
                } else {
                  terms.current.delete(t.id);
                  searches.current.delete(t.id);
                }
              }}
              onFocus={() => setFocused(t.id)}
              onReady={(ok) => markReady(t.id, ok)}
              onFindResults={(index, count) => setFindResult({ id: t.id, index, count })}
              onAttach={onAttach ? () => { const term = terms.current.get(t.id); if (term) onAttach(terminalAttachment(tr, term, t.title)); } : undefined}
              onSplit={splitTerm}
              onFocusPane={focusPane}
            />
          ))}
        {split && (
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              const area = areaRef.current;
              if (!area) return;
              const move = (ev: MouseEvent) => {
                const r = area.getBoundingClientRect();
                const pct =
                  split.dir === "row"
                    ? ((ev.clientX - r.left) / r.width) * 100
                    : ((ev.clientY - r.top) / r.height) * 100;
                // 한쪽이 사라지면 되돌릴 방법이 없다 — 양쪽에 최소폭을 남긴다.
                setRatio(Math.min(85, Math.max(15, pct)));
              };
              startDrag(move);
            }}
            className={`absolute z-10 bg-line/40 hover:bg-accent/40 ${
              split.dir === "row" ? "top-0 bottom-0 w-1 cursor-col-resize" : "left-0 right-0 h-1 cursor-row-resize"
            }`}
            style={split.dir === "row" ? { left: `calc(${ratio}% - 2px)` } : { top: `calc(${ratio}% - 2px)` }}
            data-terminal-split-resizer={split.dir}
          />
        )}
        {notice && (
          <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted shadow-sm" data-terminal-notice>
            {notice}
          </div>
        )}
        {find && (
          <div
            className="absolute right-3 top-1.5 z-20 flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-1 shadow-sm"
            data-terminal-find
            onKeyDown={(e) => {
              // 입력창이든 다음/이전 버튼이든 Esc 는 닫기. 채팅 쪽 Esc(입력 비우기 등)로 새지 않게 여기서 끝낸다.
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              closeFind();
            }}
          >
            <input
              ref={findInput}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                doFind(e.target.value, "next", true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  doFind(query, e.shiftKey ? "prev" : "next");
                }
              }}
              placeholder={tr("panel.terminal.findPlaceholder")}
              spellCheck={false}
              className="mono w-44 bg-transparent text-[11px] text-fg outline-none placeholder:text-muted-2"
            />
            <span className="mono min-w-[3ch] text-right text-[10px] text-muted-2" data-terminal-find-count>
              {query && findResult && findResult.id === target
                ? findResult.count === 0
                  ? "0"
                  : `${findResult.index + 1}/${findResult.count}`
                : ""}
            </span>
            <button onClick={() => doFind(query, "prev")} className="rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg" title={tr("panel.terminal.findPrev")}>
              <Icon name="chevronUp" size={11} />
            </button>
            <button onClick={() => doFind(query, "next")} className="rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg" title={tr("panel.terminal.findNext")}>
              <Icon name="chevronDown" size={11} />
            </button>
            <button onClick={closeFind} className="rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg" title={tr("panel.terminal.findClose")}>
              <Icon name="x" size={11} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** ⌘⌥방향키의 방향. code 로 읽어 키보드 배열을 타지 않는다. */
const ARROW_DIR: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * 나뉜 화면에서 이 터미널이 앉을 자리. 부모를 바꾸지 않고 위치만 준다 —
 * 옮기면 xterm 이 다시 만들어져 그동안의 출력이 사라진다.
 */
function paneStyle(
  split: { dir: SplitDir; id: string } | null,
  ratio: number,
  second: boolean,
): React.CSSProperties {
  if (!split) return { inset: 0 };
  if (split.dir === "row")
    return second
      ? { top: 0, bottom: 0, left: `${ratio}%`, right: 0 }
      : { top: 0, bottom: 0, left: 0, right: `${100 - ratio}%` };
  return second
    ? { left: 0, right: 0, top: `${ratio}%`, bottom: 0 }
    : { left: 0, right: 0, top: 0, bottom: `${100 - ratio}%` };
}

/** 터미널 탭 하나 = xterm 하나. 보일 때 크기를 맞추고 pty 에 붙는다(없으면 셸을 띄운다). */
function TerminalView({
  termId,
  kind,
  cwd,
  visible,
  style,
  onSplit,
  onFocusPane,
  onRegister,
  onFocus,
  onReady,
  onFindResults,
  onAttach,
}: {
  termId: string;
  kind: "shell" | "command";
  cwd: string;
  visible: boolean;
  /** 나뉜 화면에서 앉을 자리. 부모를 바꾸지 않으려고 위치를 스타일로 준다. */
  style?: React.CSSProperties;
  onSplit?: (dir: SplitDir) => void;
  /** 옆 칸으로 포커스를 옮긴다. 옮겼으면 true — 못 옮겼으면 키를 셸에 그대로 넘긴다. */
  onFocusPane?: (dir: "left" | "right" | "up" | "down") => boolean;
  onRegister?: (term: Terminal | null, search: SearchAddon | null) => void;
  /** 이 터미널이 키 입력을 받게 됐다. */
  onFocus?: () => void;
  /** pty 가 붙었다(true) / 떨어졌다(false). */
  onReady?: (ok: boolean) => void;
  /** 찾기 결과가 바뀌었다(index 는 0부터, 결과가 없으면 count 0). */
  onFindResults?: (index: number, count: number) => void;
  onAttach?: () => void;
}) {
  const { t: tr } = useTranslation();
  const trRef = useRef(tr);
  trRef.current = tr;
  // 출력 속 링크: URL 은 답변 속 링크와 같은 규칙으로, 파일 경로는 실제로 있는 것만 에디터로. 이 컴포넌트는 ChatView 의 provider 안에 있다.
  const { cwd: locateCwd, locate } = useLocateFile();
  const openFile = useOpenFile();
  const chatSplit = useContext(PaneSplitContext);
  const cbs = useRef({ onRegister, onAttach, onSplit, onFocusPane, onFocus, onReady, onFindResults, locateCwd, locate, openFile, chatSplit });
  cbs.current = { onRegister, onAttach, onSplit, onFocusPane, onFocus, onReady, onFindResults, locateCwd, locate, openFile, chatSplit };
  const locateCache = useRef(createLocateCache((ref) => cbs.current.locate(ref)));
  const [chooser, setChooser] = useState<{ href: string; x: number; y: number } | null>(null);
  /** 링크 클릭과 선택 드래그를 가르는 기준 — mousedown 자리에서 5px 넘게 움직였으면 클릭이 아니다. */
  const down = useRef<{ x: number; y: number } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exit, setExit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 위로 올려 둔 동안 새 출력이 왔다. 바닥으로 내려가면 사라진다. */
  const [unread, setUnread] = useState(false);
  const attached = useRef(false);
  /** 백로그를 다시 그리는 중 — 그건 새 출력이 아니다. */
  const restoring = useRef(false);

  const spawn = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    setExit(null);
    setError(null);
    const r = await window.sudal.terminal.open(
      termId,
      cwd,
      term.cols,
      term.rows,
    );
    if (!r.ok) {
      setError(r.error ?? trRef.current("panel.terminal.startFailed"));
      cbs.current.onReady?.(false);
      return;
    }
    if (r.existing && r.backlog && !attached.current) {
      restoring.current = true;
      term.reset();
      term.write(r.backlog, () => {
        restoring.current = false;
      });
    }
    attached.current = true;
    cbs.current.onReady?.(true);
    term.focus();
  }, [termId, cwd]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = readTheme();
    /** URL 을 눌렀다. 선택 중이거나 드래그였으면 무시. 어디서 열지는 답변 속 링크와 같은 규칙. */
    /** 링크로 볼 클릭인가 — 왼쪽(또는 가운데) 버튼이고, 선택 중이 아니고, mousedown 자리에서 끌지 않았다. */
    const isLinkClick = (e: MouseEvent) => {
      if (e.button !== 0 && e.button !== 1) return false;
      if (term.hasSelection()) return false;
      const d = down.current;
      return !(d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5);
    };
    const openLink = (e: MouseEvent, uri: string) => {
      if (!isLinkClick(e)) return;
      const where = linkTargetFor(uri, e);
      if (where === "external") void window.sudal.browser.openExternal(uri);
      else if (where === "app") cbs.current.openFile(uri);
      else setChooser({ href: uri, x: e.clientX, y: e.clientY + 8 });
    };
    const term = new Terminal({
      // OSC 8 하이퍼링크(gh·cargo 등이 찍는 것)도 같은 경로로
      linkHandler: { activate: (e, text) => openLink(e, text) },
      cursorBlink: true,
      // 셸 프롬프트(p10k 등)의 Nerd Font 기호가 네모로 깨지지 않게 Nerd Font 를 앞에 둔다. 없으면 앱 모노 폰트로.
      fontFamily: `"MesloLGS NF", "JetBrainsMono Nerd Font Mono", "Hack Nerd Font Mono", "Symbols Nerd Font Mono", ${theme.fontMono}`,
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 5000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: {
        background: theme.bg,
        foreground: theme.fg,
        cursor: theme.fg,
        cursorAccent: theme.bg,
        selectionBackground: theme.selection,
        selectionForeground: theme.fg,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((e, uri) => openLink(e, uri)));
    // 파일 경로("src/a.ts:42") → 에디터 그 줄. 존재하는 것만 링크가 된다(캐시, 못 찾은 건 잠깐 뒤 다시). 좌표는 셀 단위로 되짚는다.
    let disposed = false;
    const fileLinks = term.registerLinkProvider({
      provideLinks(y, cb) {
        const cwd = cbs.current.locateCwd;
        const buf = term.buffer.active;
        const line = buf.getLine(y - 1);
        if (!cwd || !line) return cb(undefined);
        const text = line.translateToString(true);
        // 화면 폭에 감긴 경로는 조각만 보여서 엉뚱한 파일이 된다 — 이 줄이 이어진 줄이면 첫 칸에서 시작하는 참조를, 다음 줄이 이어지면 끝에 닿는 참조를 뺀다.
        const nextWrapped = buf.getLine(y)?.isWrapped === true;
        const refs = findFileRefs(text).filter((r) => !(line.isWrapped && r.start === 0) && !(nextWrapped && r.end >= text.length));
        if (refs.length === 0) return cb(undefined);
        const cells: CellLike[] = [];
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x);
          if (c) cells.push({ chars: c.getChars(), width: c.getWidth() });
        }
        void Promise.all(refs.map((r) => locateCache.current(cwd, r.path).then((found) => ({ r, found })))).then((rs) => {
          // 기다리는 사이 출력·resize·화면 전환으로 줄이 바뀌었으면 좌표가 틀리다 — 버린다(다음 hover 때 다시 만든다).
          const now = term.buffer.active.getLine(y - 1);
          if (disposed || term.buffer.active !== buf || !now || now.translateToString(true) !== text) return cb(undefined);
          const links: ILink[] = [];
          for (const { r, found } of rs) {
            const target = pickCandidate(found, r.path);
            const range = cellRangeFor(cells, r.start, r.end);
            if (!target || !range) continue;
            links.push({
              range: { start: { x: range.x1, y }, end: { x: range.x2, y } },
              text: r.text,
              activate: (e) => {
                if (!isLinkClick(e)) return;
                cbs.current.openFile(target, r.line ? { line: r.line, endLine: r.endLine } : null);
              },
            });
          }
          cb(links.length > 0 ? links : undefined);
        });
      },
    });
    const onDown = (e: MouseEvent) => {
      down.current = { x: e.clientX, y: e.clientY };
    };
    host.addEventListener("mousedown", onDown);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    cbs.current.onRegister?.(term, search);
    // 키 입력을 받는 건 xterm 의 숨은 textarea 다. 거기에 포커스가 오면 이 터미널이 단축키의 대상이 된다.
    const onFocusIn = () => {
      cbs.current.onFocus?.();
      if (IS_WIN) window.sudal.terminal.setFocused(true);
    };
    // Windows: 포커스가 있는 동안 main 이 셸 편집키(Ctrl+R 등)를 메뉴 대신 셸로 보낸다(shared/app-shortcuts TERMINAL_YIELD_KEYS)
    const onFocusOut = () => IS_WIN && window.sudal.terminal.setFocused(false);
    term.textarea?.addEventListener("focus", onFocusIn);
    term.textarea?.addEventListener("blur", onFocusOut);
    const onResults = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      cbs.current.onFindResults?.(resultIndex, resultCount),
    );
    // ⌘⇧A: 터미널 안에서 바로 첨부(셸로는 안 보낸다)
    // ⌘D 좌우 · ⌘⇧D 상하 분할. 보통의 터미널 앱과 같은 자리다. ⌘D 는 셸에 아무 뜻이 없어(EOF 는 ⌃D)
    // 가로채도 잃는 것이 없다. ⌘W·⌘K·⌘F 는 메뉴 가속기라 여기까지 오지 않고 App 이 패널에 넘긴다.
    // Windows 는 Ctrl+D 가 EOF 라 분할은 Ctrl+Shift+D(좌우)·Ctrl+Shift+Alt+D(상하)다(shared/app-shortcuts).
    // Windows 의 Ctrl+R 등 셸 편집키는 main 이 셸로 보낸다 — 여기까지 오면 xterm 이 셸에 넘긴다.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && isMod(e) && e.shiftKey && e.code === "KeyA") {
        cbs.current.onAttach?.();
        return false;
      }
      if (e.type === "keydown" && isMod(e) && e.code === "KeyD" && (IS_MAC || e.shiftKey)) {
        cbs.current.onSplit?.((IS_MAC ? e.shiftKey : e.altKey) ? "col" : "row");
        return false;
      }
      // Windows: 앱 단축키(Ctrl+J·F·1~9 등)는 xterm 이 셸로 보내지 않게 넘겨 메뉴가 받게 한다. 셸 편집키(Ctrl+R 등)는 셸로 간다. Ctrl+W·K 는 앱이 받아 터미널을 닫고 지운다.
      if (IS_WIN && e.type === "keydown" && passesToAppMenu(e)) return false;
      // Windows: Ctrl+C 는 선택이 있을 때만 복사하고, 없으면 셸에 보낸다(SIGINT). Ctrl+Shift+C 는 늘 복사.
      // Ctrl+V·Ctrl+Shift+V 는 xterm 이 ^V 로 보내지 않게 넘겨 브라우저의 붙여넣기(paste 이벤트)로 들어가게 한다.
      if (IS_WIN && e.type === "keydown" && e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.code === "KeyC" && (e.shiftKey || term.hasSelection())) {
          const sel = term.getSelection();
          if (sel) void navigator.clipboard.writeText(sel);
          term.clearSelection();
          e.preventDefault();
          return false;
        }
        if (e.code === "KeyV") return false;
      }
      // ⌘⌥방향키: 옆 칸으로. 옮겼으면 preventDefault 로 표시해 채팅 칸 전환(App)이 받지 않게 한다.
      // 그 방향에 칸이 없을 때 채팅 화면이 나뉘어 있고 좌우면 셸에 넘기지 않고 App 이 옆 채팅 칸으로 옮기게 두고, 아니면 셸에 넘긴다.
      if (e.type === "keydown" && isMod(e) && e.altKey && ARROW_DIR[e.code]) {
        if (cbs.current.onFocusPane?.(ARROW_DIR[e.code])) {
          e.preventDefault();
          return false;
        }
        return !(cbs.current.chatSplit && (e.code === "ArrowLeft" || e.code === "ArrowRight"));
      }
      // ⌘← / ⌘→: 줄 처음 / 끝. Mac 텍스트 필드와 같은 손놀림. iTerm 기본값처럼 ^A/^E 를 보낸다 —
      // Home/End 시퀀스는 zsh 기본 키맵에 없지만 ^A/^E 는 zsh·bash·fish·REPL 이 다 안다. Windows 는 Home/End 키가 있어 두지 않는다.
      if (IS_MAC && e.type === "keydown" && e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        term.input(e.code === "ArrowLeft" ? "\x01" : "\x05");
        return false;
      }
      return true;
    });
    // "새 출력 ↓": 보이지 않는 새 출력이 있는가. 바닥이 아닌데 출력이 오면 켜고, 바닥에 닿으면 끈다.
    // TUI(alternate buffer)는 스크롤 개념이 없으니 제외. 백로그 복원도 새 출력이 아니다.
    const atBottom = () => {
      const b = term.buffer.active;
      return b.viewportY >= b.baseY;
    };
    const onParsed = term.onWriteParsed(() => {
      if (restoring.current || term.buffer.active.type !== "normal") return;
      if (!atBottom()) setUnread(true);
    });
    const onScroll = term.onScroll(() => {
      if (atBottom()) setUnread(false);
    });
    const offData = window.sudal.terminal.onData((id, data) => {
      if (id !== termId) return;
      if (data === TERMINAL_CLEAR_MARK) {
        // ⌘K. xterm 의 write 는 큐에 쌓였다 비동기로 그려지므로 바로 clear() 하면 이미 받은 출력이 지운 뒤에 나타난다.
        // 빈 write 의 콜백은 앞선 출력이 모두 그려진 뒤에 오고, 이 표시는 main 이 백로그를 비운 바로 그 자리에 있다.
        term.write("", () => term.clear());
        return;
      }
      term.write(data);
      setExit(null); // 같은 id 에 새 프로세스가 붙었다
    });
    const offExit = window.sudal.terminal.onExit((id, code) => {
      if (id !== termId) return;
      setExit(code);
      cbs.current.onReady?.(false);
    });
    const onInput = term.onData((data) =>
      window.sudal.terminal.write(termId, data),
    );
    const onResize = term.onResize(({ cols, rows }) =>
      window.sudal.terminal.resize(termId, cols, rows),
    );
    // 다크/라이트 전환: 토큰 값을 다시 읽어 xterm 색을 바꾼다(xterm 은 CSS 변수를 직접 못 쓴다)
    const offTheme = onThemeChange(() => {
      const t = readTheme();
      term.options.theme = {
        background: t.bg,
        foreground: t.fg,
        cursor: t.fg,
        cursorAccent: t.bg,
        selectionBackground: t.selection,
        selectionForeground: t.fg,
      };
    });
    return () => {
      offTheme();
      offData();
      offExit();
      onInput.dispose();
      onResize.dispose();
      onParsed.dispose();
      onScroll.dispose();
      onResults.dispose();
      disposed = true;
      fileLinks.dispose();
      host.removeEventListener("mousedown", onDown);
      cbs.current.onReady?.(false);
      term.textarea?.removeEventListener("focus", onFocusIn);
      term.textarea?.removeEventListener("blur", onFocusOut);
      // 포커스를 가진 채 사라지면 blur 가 오지 않을 수 있다
      if (term.textarea && document.activeElement === term.textarea) onFocusOut();
      cbs.current.onRegister?.(null, null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [termId]);

  useEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit) return;
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* 아직 레이아웃 전 */
      }
    };
    refit();
    void spawn();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [visible, spawn]);

  return (
    <div
      className="absolute"
      style={style ?? { inset: 0 }}
      hidden={!visible}
      data-terminal-view={termId}
    >
      <div ref={hostRef} className="absolute inset-0 px-2 pb-1" />
      {unread && (
        <button
          onClick={() => {
            termRef.current?.scrollToBottom();
            termRef.current?.focus();
          }}
          className="absolute bottom-3 right-5 z-10 flex items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 text-[10.5px] text-muted shadow-sm hover:text-fg"
          title={tr("panel.terminal.scrollBottom")}
          data-terminal-unread
        >
          {tr("panel.terminal.newOutput")}
          <Icon name="chevronDown" size={10} />
        </button>
      )}
      {chooser && (
        <LinkChooser
          href={chooser.href}
          x={chooser.x}
          y={chooser.y}
          onDecide={(where, remember) => {
            if (remember) setLinkOpenMode(where);
            const href = chooser.href;
            setChooser(null);
            if (where === "app") openFile(href);
            else void window.sudal.browser.openExternal(href);
          }}
          onClose={() => setChooser(null)}
        />
      )}
      {(exit !== null || error) && (
        <button
          onClick={() => void spawn()}
          className="absolute inset-0 flex items-center justify-center bg-inset/85 text-[12px] text-muted hover:text-fg"
        >
          {error
            ? tr("panel.terminal.retry", { error })
            : tr(`panel.terminal.exited.${kind}${exit !== null && exit >= 0 ? "WithCode" : ""}`, { code: exit })}
        </button>
      )}
    </div>
  );
}

/** CSS 토큰을 xterm 테마로. xterm 은 var() 를 못 읽어서 계산된 값을 넘긴다. */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--color-inset", "#f8f9fc"),
    fg: v("--color-fg", "#18202a"),
    selection: v("--color-accent-tint", "#eef0ff"),
    accent: v("--color-accent", "#696fea"),
    accentTint: v("--color-accent-tint", "#eef0ff"),
    fontMono: v("--font-mono", "Menlo, Consolas, monospace"),
  };
}

/** 활성 터미널에서 첨부할 텍스트: 선택 영역이 있으면 그것, 없으면 버퍼 끝의 최근 40줄(빈 줄 제외). */
function terminalAttachment(tr: TFunction, term: Terminal, title: string): string {
  const sel = term.getSelection();
  if (sel.trim()) return formatTerminalAttachment(tr, { title, text: sel, selection: true });
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.length - 1; i >= 0 && lines.length < 40; i--) {
    const l = buf.getLine(i)?.translateToString(true) ?? "";
    if (lines.length === 0 && !l.trim()) continue; // 끝의 빈 줄은 건너뛴다
    lines.unshift(l);
  }
  return formatTerminalAttachment(tr, { title, text: lines.join("\n"), selection: false });
}
