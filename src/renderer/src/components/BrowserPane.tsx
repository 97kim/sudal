// 에디터 패널의 브라우저 탭. Electron <webview>(main 의 will-attach-webview 가 preload 없음·node 없음·http(s) 만으로 제한) 위에
import { usePaneFocusRef } from "../pane-focus";
// 주소창·뒤로/앞으로/새로고침·외부 브라우저 열기를 둔다. 탭 키(초기 URL 또는 browser:<n>)는 고정이고 이동은 이 안에서만 일어난다.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { normalizeUrl } from "../browser-url";
import { browserTabLabel, openEditorFile } from "../editor-tabs";
import { useLocateFile } from "./FileViewer";
import { BrowserImportSheet } from "./BrowserImportSheet";
import { relativeAny } from "@shared/any-path";
import type { ChatImageDto } from "@shared/ipc";
import { PICKER_STOP_SCRIPT, formatNotesAttachment, pickerRelabelScript, type PickedElement, dataUrlImage, elementImage, formatElementAttachment, formatSource, parsePickMessage, pickerScript } from "@shared/element-pick";
import { DIAG_MAX_CONSOLE, formatDiagnostics, pushCapped, type ConsoleLine } from "@shared/browser-diagnostics";
import { DEFAULT_VIEWPORT, VIEWPORTS, nextZoom, type ViewportId, viewportById, zoomLevelToPercent } from "../browser-viewport";
import { frequentSites, parseHistory, recordVisit, suggest, type HistoryEntry } from "@shared/browser-history";
import { browserErrorKind, type BrowserErrorKind } from "../browser-error";
import type { BrowserEventDto } from "@shared/ipc";
import { kvGet, kvSet } from "../kv-store";

export { normalizeUrl };

// 주소 기록은 탭마다가 아니라 앱 전체가 하나를 쓴다 — 어느 탭에서 열었든 다음에 찾을 수 있어야 한다.
const HISTORY_KEY = "browser.history";
let historyCache: HistoryEntry[] | null = null;
function readHistory(): HistoryEntry[] {
  if (!historyCache) historyCache = parseHistory(kvGet(HISTORY_KEY));
  return historyCache;
}
function addHistory(url: string): void {
  const next = recordVisit(readHistory(), url, Date.now());
  if (next === historyCache) return;
  historyCache = next;
  kvSet(HISTORY_KEY, JSON.stringify(next));
}

/** 메모 모음에 담을 수 있는 요소 수. 많아지면 한 번에 보내는 요청이 흐려진다. */
const TRAY_MAX = 10;
/** 입력창이 받는 이미지 수(Composer 의 MAX_IMAGES)와 같다. */
const NOTES_MAX_IMAGES = 4;

// 보기 폭은 앱 전체에 하나 — 폰 폭으로 확인하던 중이면 새 탭도 그 폭으로 연다.
const VIEWPORT_KEY = "browser.viewport";
// 확대 배율은 크롬처럼 호스트마다. 0(100%)은 지워서 기본으로 돌린다.
const ZOOM_KEY = "browser.zoom";
function readZooms(): Record<string, number> {
  try {
    const v = JSON.parse(kvGet(ZOOM_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
/**
 * 그 호스트에 저장한 배율(없으면 100%)을 웹뷰에 직접 건다. 돌려준 값이 표시할 배율이다.
 * 함정: Chromium 이 한 웹뷰의 배율을 다른 웹뷰에도 퍼뜨린다 — getZoomLevel() 을 믿지 말고 늘 저장값을 건다.
 */
function applyHostZoom(el: SudalWebview, u: string): number {
  const saved = readZooms()[hostOf(u)];
  const level = typeof saved === "number" ? saved : 0;
  try {
    if (el.getZoomLevel() !== level) el.setZoomLevel(level);
  } catch {
    /* 아직 붙기 전 */
  }
  return level;
}
/** 주소창 표시용: 호스트와 나머지(경로·쿼리). localhost·IP 면 local. */
function urlParts(u: string): { host: string; rest: string; local: boolean } {
  try {
    const x = new URL(u);
    const rest = x.pathname === "/" && !x.search && !x.hash ? "" : x.pathname + x.search + x.hash;
    return { host: x.host, rest, local: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d{1,3}(\.\d{1,3}){3})$/i.test(x.hostname) };
  } catch {
    return { host: "", rest: "", local: false };
  }
}
function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

type Download = Extract<BrowserEventDto, { kind: "download" }>;

export function BrowserPane({
  initialUrl,
  visible,
  chatTabId,
  onLabel,
  onFavicon,
  onAttach,
  onUrlChange,
  onOpenTab,
}: {
  initialUrl: string | null;
  visible: boolean;
  /** 이 브라우저가 속한 채팅 탭. 에이전트 조작(sudal browser …)이 탭으로 찾아오므로 main 에 알려야 한다. */
  chatTabId?: string;
  /** 탭 스트립에 보일 라벨(호스트 또는 페이지 제목)이 바뀔 때. */
  onLabel?: (label: string) => void;
  /** 파비콘(data URL)이 정해졌을 때. 없거나 못 받으면 null — 탭은 지구본으로 돌아간다. */
  onFavicon?: (dataUrl: string | null) => void;
  /** "요소 선택" 결과(HTML·스타일 텍스트 + 스크린샷 조각)를 입력창에 붙인다. */
  onAttach?: (block: string, images?: ChatImageDto[]) => void;
  /** 보고 있는 주소가 바뀔 때. 탭이 내려갔다 올라와도 같은 페이지로 돌아오게 밖에서 들고 있는다. */
  onUrlChange?: (url: string) => void;
  /** 페이지가 새 탭으로 열려는 링크(target=_blank·우클릭 "새 탭에서 열기"). */
  onOpenTab?: (url: string) => void;
}) {
  const { t } = useTranslation();
  // 웹뷰 이벤트 리스너는 한 번 붙이고 오래 남으므로, 언어가 바뀐 뒤에도 최신 t 를 쓰도록 ref 로 건넨다.
  const tRef = useRef(t);
  tRef.current = t;
  const view = useRef<SudalWebview | null>(null);
  // <webview> 는 주소가 생긴 뒤에야 렌더되므로, 마운트 시점을 state 로 잡아 그때 리스너를 붙인다.
  const [mounted, setMounted] = useState(false);
  // 웹뷰 요소가 DOM 에 생긴 것과 게스트가 실제로 붙은 것은 다르다 — 붙기 전에는 getWebContentsId() 가 던진다.
  const [attached, setAttached] = useState(false);
  const onLabelRef = useRef(onLabel);
  onLabelRef.current = onLabel;
  const onFaviconRef = useRef(onFavicon);
  onFaviconRef.current = onFavicon;
  // 지금 보고 있는 주소와 그 페이지의 제목. sync() 는 did-stop-loading 에도 걸려 있어서,
  // 조건 없이 되돌리면 먼저 도착한 제목·파비콘을 로딩 끝에 덮어써 버린다(탭이 호스트로 되돌아갔다).
  const pageRef = useRef("");
  const titleRef = useRef("");
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const [url, setUrl] = useState(initialUrl ?? "");
  // 함정: <webview> 의 src 를 바꾸면 Electron 이 그 주소를 다시 불러온다. 페이지 안에서 이동할 때마다 url 이 바뀌므로
  // src 에 url 을 그대로 주면 같은 페이지를 한 번 더 연다(폼·화면 상태가 날아간다). 처음 붙을 때만 정하고, 이동은 loadURL 로.
  const firstSrc = useRef("");
  if (!firstSrc.current && url) firstSrc.current = url;
  const [input, setInput] = useState(initialUrl ?? "");
  // 주소창 자동완성: 열림 여부와 키보드로 고른 줄(-1 = 고른 것 없음, 친 그대로 간다)
  const [sugOpen, setSugOpen] = useState(false);
  // 주소창에 포커스가 없으면 호스트를 진하게, 경로를 흐리게 보여 준다(크롬처럼). 고치는 중엔 친 그대로.
  const [addrFocus, setAddrFocus] = useState(false);
  const [sugAt, setSugAt] = useState(-1);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [error, setError] = useState<{ kind: BrowserErrorKind; code: string; url: string } | null>(null);
  // 로딩 막대. 웹뷰는 진행률을 주지 않아 "시작 → 천천히 차오름 → 끝" 세 단계로만 보인다.
  const [bar, setBar] = useState<"off" | "start" | "run" | "done">("off");
  // 마우스를 올린 링크 주소 — 아래 줄에 제목 대신 보인다.
  const [hoverUrl, setHoverUrl] = useState("");
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 주소창 안 칩의 폭만큼 글자 자리를 비운다.
  const chipsRef = useRef<HTMLSpanElement>(null);
  const [chipsW, setChipsW] = useState(0);
  const chatTabIdRef = useRef(chatTabId);
  chatTabIdRef.current = chatTabId;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // 에이전트가 sudal browser 명령으로 이 브라우저를 조작하는 중인지 — 사람이 보고 멈출 수 있게 보여 준다.
  type AgentLine = { op: string; detail: string; at: number; ok?: boolean };
  const [agent, setAgent] = useState<{ active: boolean; now: AgentLine | null; feed: AgentLine[] }>({ active: false, now: null, feed: [] });
  const [agentPoint, setAgentPoint] = useState<{ x: number; y: number; at: number } | null>(null);
  const [agentPaused, setAgentPaused] = useState(false);
  const [, setTick] = useState(0);
  // 이 웹뷰에서 시작한 명령 번호 — 끝 알림은 여기 있는 것만 센다.
  const agentInflight = useRef(new Set<number>());
  const agentIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOpenTabRef = useRef(onOpenTab);
  onOpenTabRef.current = onOpenTab;
  // 웹뷰의 webContents id — main 이 보내는 browser:event 중 제 것을 가른다. 붙기 전엔 null.
  const wcIdRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 요소 선택 모드: 페이지에 스크립트를 주입해 마우스를 올리면 테두리, 클릭하면 console-message 로 요소 정보가 온다
  const [picking, setPicking] = useState(false);
  // 요소 선택·진단 첨부 결과. 페이지를 밀지 않게 웹뷰 위에 떠 있다가 사라진다.
  type Toast = { text: string; detail?: string; hint?: string; error?: boolean; action?: { label: string; run: () => void } };
  const [toast, setToast] = useState<Toast | null>(null);
  // ⇧+클릭으로 모은 요소와 요소마다의 메모. 보내면 한 덩어리로 입력창에 붙는다.
  // pending: 고른 순간 자리만 잡아 두고 스크린샷·소스 위치를 채우는 중 — 순서가 고른 순서대로 남는다.
  type TrayItem = { id: string; element: PickedElement; url: string; images?: ChatImageDto[]; shown?: string; memo: string; mark?: number; pending: boolean };
  const [tray, setTray] = useState<TrayItem[]>([]);
  const trayRef = useRef(tray);
  trayRef.current = tray;
  // 리스너가 오래 남으므로 최신 값을 ref 로 건넨다.
  const locate = useLocateFile();
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (next: Toast | null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    // 누를 버튼이 있으면 손이 갈 시간을 더 준다.
    if (next) toastTimer.current = setTimeout(() => setToast(null), next.error ? 6000 : next.action ? 8000 : 4000);
  };
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  // 콘솔 줄은 화면에 안 그리므로 ref 에만 쌓는다(매 줄 렌더링하면 로그가 쏟아질 때 앱이 느려진다)
  const consoleRef = useRef<ConsoleLine[]>([]);
  const [diagBusy, setDiagBusy] = useState(false);
  // 페이지 내 찾기 — ⌘F 는 대화 검색과 겹치므로 브라우저에 포커스가 있을 때만 이쪽이 잡는다(ChatView 가 라우팅).
  const [find, setFind] = useState<{ open: boolean; text: string; matches: number; at: number }>({ open: false, text: "", matches: 0, at: 0 });
  const findRef = useRef<HTMLInputElement>(null);
  const [viewport, setViewportState] = useState<ViewportId>(() => viewportById(kvGet(VIEWPORT_KEY) ?? DEFAULT_VIEWPORT).id);
  const setViewport = (v: ViewportId) => {
    setViewportState(v);
    kvSet(VIEWPORT_KEY, v === DEFAULT_VIEWPORT ? null : v);
  };
  const [zoom, setZoom] = useState(0);
  // 선택 세션마다 새 표식 — 페이지가 표식을 미리 알 수 없어 위조가 어렵고, 옛 세션의 늦은 메시지도 걸러진다
  const nonceRef = useRef("");
  const startPick = async () => {
    const el = view.current;
    if (!el || !url) return;
    showToast(null);
    try {
      nonceRef.current = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await el.executeJavaScript(pickerScript(nonceRef.current));
      setPicking(true);
    } catch (e) {
      showToast({ text: t("panel.browser.pickFailed"), detail: e instanceof Error ? e.message : String(e), error: true });
    }
  };
  const stopPick = () => {
    setPicking(false);
    try {
      void view.current?.executeJavaScript(PICKER_STOP_SCRIPT).catch(() => {});
    } catch {
      /* 붙기 전엔 즉시 던진다 — 끌 것도 없다 */
    }
  };
  const paneFocus = usePaneFocusRef();
  // 앱 쪽에 포커스가 있을 때의 esc 도 취소로(페이지 안 esc 는 주입 스크립트가 처리)
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !paneFocus.current) return;
      e.stopPropagation();
      stopPick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onConsole = (e: Event) => {
      const d = e as Event & { message?: string; level?: number; line?: number; sourceId?: string };
      const msg = d.message ?? "";
      const r = parsePickMessage(msg, nonceRef.current);
      if (!r) {
        // 요소 선택 표식이 아닌 보통 로그 — 진단 첨부용으로 모아 둔다
        consoleRef.current = pushCapped(
          consoleRef.current,
          { ts: Date.now(), level: typeof d.level === "number" ? d.level : 1, text: msg, source: d.sourceId || undefined, line: d.line },
          DIAG_MAX_CONSOLE * 3,
        );
        return;
      }
      if (!pickingRef.current) return;
      if (r.kind === "cancel") {
        setPicking(false);
        nonceRef.current = "";
        return;
      }
      const picked = r.element;
      // ⇧+클릭은 메모 모음에 쌓고 선택 모드를 그대로 둔다. 모음에 이미 뭔가 있으면 그냥 클릭도 모음에 더하고 끝낸다.
      const toTray = picked.multi === true || trayRef.current.length > 0;
      if (!picked.multi) {
        setPicking(false);
        nonceRef.current = "";
      }
      // 가득 찼으면 담지 않는다 — 방금 페이지에 생긴 테두리도 지워 모음과 맞춘다.
      if (toTray && trayRef.current.length >= TRAY_MAX) {
        runInPage(pickerRelabelScript(trayRef.current.map((x) => x.mark ?? 0)));
        showToast({ text: tRef.current("panel.browser.notes.full", { count: TRAY_MAX }), error: true });
        return;
      }
      const slot = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (toTray) setTray((list) => [...list, { id: slot, element: picked, url, memo: "", mark: picked.mark, pending: true }].slice(0, TRAY_MAX));
      void (async () => {
        let images: ChatImageDto[] | undefined;
        // 요소 영역만 잘라 스크린샷(뷰포트 좌표 = capturePage 좌표). 화면 밖·0 크기는 건너뛴다
        const rect = { x: Math.max(0, Math.floor(picked.rect.x)), y: Math.max(0, Math.floor(picked.rect.y)), width: Math.ceil(picked.rect.width), height: Math.ceil(picked.rect.height) };
        if (rect.width >= 2 && rect.height >= 2) {
          try {
            const img = await el.capturePage(rect);
            const one = img.isEmpty() ? null : elementImage(img.toDataURL(), picked);
            if (one) images = [one];
          } catch {
            /* 캡처 실패는 텍스트만 */
          }
        }
        let pageUrl = url;
        try {
          pageUrl = el.getURL() || url;
        } catch {
          /* 무시 */
        }
        // 페이지가 알려 준 소스 경로(절대 경로·/src/… URL 경로)를 이 저장소의 실제 파일로 다시 찾는다.
        // 못 찾으면 페이지가 준 그대로 싣는다 — 모델은 그것만으로도 찾아간다.
        const src = picked.source;
        let abs: string | null = null;
        let shown: string | undefined;
        if (src) {
          const { cwd } = locateRef.current;
          // 경로는 페이지가 준 값이다 — 저장소 밖(/etc/hosts, ../, 밖을 가리키는 링크)은 main 이 inside 로 걸러 준다.
          const hits = cwd ? await window.sudal.files.locate(cwd, src.file, true).catch(() => [] as string[]) : [];
          if (cwd && hits.length === 1) {
            abs = hits[0];
            // cwd 가 링크 경로면 실제 경로와 어긋나 상대 경로가 안 나온다 — 그땐 절대 경로로 보여 준다.
            shown = relativeAny(abs, cwd) || abs;
          }
        }
        if (toTray) {
          // 그사이 보냈거나 비웠거나 뺐으면 자리가 없다 — 되살리지 않는다.
          setTray((list) => list.map((x) => (x.id === slot ? { ...x, url: pageUrl, images, shown, pending: false } : x)));
          return;
        }
        onAttachRef.current?.(formatElementAttachment(tRef.current, picked, pageUrl, shown), images);
        // 선택자는 입력창에 이미 들어갔다 — 여기엔 사람이 알아볼 소스 위치, 없으면 태그와 글만.
        const words = picked.text.replace(/\s+/g, " ").trim();
        const target = abs;
        showToast({
          text: tRef.current(src ? "panel.browser.pickedWithSource" : images ? "panel.browser.pickedWithShot" : "panel.browser.picked"),
          detail: src ? formatSource(src, shown) : `<${picked.tag}>${words ? ` ${words.length > 32 ? `${words.slice(0, 32)}…` : words}` : ""}`,
          // 입력창은 붙이면서 이미 포커스를 받는다 — 무엇을 하면 되는지만 알려 준다.
          hint: target ? undefined : tRef.current("panel.browser.toastNext"),
          action:
            target && chatTabIdRef.current
              ? { label: tRef.current("panel.browser.openSource"), run: () => openEditorFile(chatTabIdRef.current!, target, src?.line ? { line: src.line } : null) }
              : undefined,
        });
      })();
    };
    el.addEventListener("console-message", onConsole);
    // 페이지가 바뀌면 주입한 스크립트도 사라진다 — 모드를 끄고, 콘솔도 새 페이지 기준으로 비운다
    const onNav = () => {
      setPicking(false);
      consoleRef.current = [];
    };
    el.addEventListener("did-navigate", onNav);
    return () => {
      el.removeEventListener("console-message", onConsole);
      el.removeEventListener("did-navigate", onNav);
    };
  }, [mounted, url]);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const sync = () => {
      try {
        const u = el.getURL();
        setUrl(u);
        setInput(u);
        addHistory(u); // 주소창 자동완성용 — http(s) 가 아니면 recordVisit 이 거른다
        // 페이지가 실제로 바뀐 첫 순간에만 제목·파비콘을 비운다.
        const moved = u !== pageRef.current;
        if (moved) {
          const hostChanged = hostOf(u) !== hostOf(pageRef.current);
          pageRef.current = u;
          titleRef.current = "";
          onFaviconRef.current?.(null); // 새 페이지가 자기 것을 줄 때까지 지구본으로
          if (hostChanged) setZoom(applyHostZoom(el, u));
        }
        onUrlChangeRef.current?.(u);
        setNav({ back: el.canGoBack(), forward: el.canGoForward() });
        try {
          // 제목이 이미 왔으면 그걸 둔다 — 크롬처럼 탭에는 제목이 보여야 한다.
          if (!titleRef.current) onLabelRef.current?.(browserTabLabel(u, tRef.current));
        } catch {
          /* 무시 */
        }
      } catch {
        /* 아직 붙기 전 */
      }
    };
    const onTitle = (e: Event) => {
      const pageTitle = (e as CustomEvent & { title?: string }).title ?? el.getTitle();
      setTitle(pageTitle);
      titleRef.current = pageTitle ?? "";
      if (pageTitle) onLabelRef.current?.(pageTitle.length > 28 ? `${pageTitle.slice(0, 28)}…` : pageTitle);
    };
    const onStart = () => {
      setLoading(true);
      setError(null);
      setBar("start");
      // 한 프레임 뒤에 목표 폭을 줘야 transition 이 걸린다.
      setTimeout(() => setBar((b) => (b === "start" ? "run" : b)), 16);
    };
    const onStop = () => {
      setLoading(false);
      setBar("done");
      setTimeout(() => setBar((b) => (b === "done" ? "off" : b)), 300);
      sync();
    };
    const onFail = (e: Event) => {
      const d = e as Event & { errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
      if (d.isMainFrame === false) return;
      setLoading(false);
      if (d.errorDescription && d.errorDescription !== "ERR_ABORTED")
        setError({ kind: browserErrorKind(d.errorDescription), code: d.errorDescription, url: d.validatedURL ?? "" });
    };
    const onAttach = () => {
      setAttached(true);
      try {
        wcIdRef.current = el.getWebContentsId();
      } catch {
        /* 다음 dom-ready 에서 */
      }
    };
    const onTarget = (e: Event) => setHoverUrl((e as Event & { url?: string }).url ?? "");
    // 웹뷰 안을 누르면 호스트 문서에 mousedown 이 오지 않는다 — 웹뷰가 포커스를 받는 것으로 메뉴를 닫는다.
    const onFocus = () => setMenuOpen(false);
    // 파비콘은 원격 주소라 화면이 바로 못 쓴다 — main 이 받아 data URL 로 바꿔 준다.
    const onFav = (e: Event) => {
      const list = (e as Event & { favicons?: string[] }).favicons ?? [];
      const first = list.find((u) => /^https?:\/\//i.test(u));
      if (!first) return onFaviconRef.current?.(null);
      void window.sudal.browser
        .favicon(first)
        .then((d) => onFaviconRef.current?.(d))
        .catch(() => onFaviconRef.current?.(null));
    };
    el.addEventListener("page-favicon-updated", onFav);
    el.addEventListener("update-target-url", onTarget);
    el.addEventListener("focus", onFocus);
    el.addEventListener("dom-ready", onAttach);
    // did-attach 는 첫 페이지를 불러오기 전에 온다 — dom-ready 만 기다리면 첫 페이지의 window.open·바로 받기 이벤트를 놓친다.
    el.addEventListener("did-attach", onAttach);
    el.addEventListener("did-navigate", sync);
    el.addEventListener("did-navigate-in-page", sync);
    el.addEventListener("page-title-updated", onTitle);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onFail);
    return () => {
      el.removeEventListener("page-favicon-updated", onFav);
      el.removeEventListener("update-target-url", onTarget);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("dom-ready", onAttach);
      el.removeEventListener("did-attach", onAttach);
      el.removeEventListener("did-navigate", sync);
      el.removeEventListener("did-navigate-in-page", sync);
      el.removeEventListener("page-title-updated", onTitle);
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onFail);
    };
  }, [mounted]);

  // main 이 웹뷰를 대신해 알리는 일. 숨은 탭도 제 것이면 받는다(받은 파일 표시가 탭을 옮겨도 남게).
  useEffect(
    () =>
      window.sudal.browser.onEvent((ev) => {
        if (ev.webContentsId !== wcIdRef.current) return;
        if (ev.kind === "open-tab") onOpenTabRef.current?.(ev.url);
        else
          setDownloads((list) => {
            const i = list.findIndex((d) => d.id === ev.id);
            // 최근 3개만 — 오래된 것부터 밀려난다.
            return i === -1 ? [...list, ev].slice(-3) : list.map((d) => (d.id === ev.id ? ev : d));
          });
      }),
    [],
  );

  // 바깥(앱 쪽)을 누르거나 esc 면 메뉴를 닫는다. 웹뷰 안 클릭은 위의 focus 가 맡는다.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // 숨어 있던 사이 다른 탭이 배율을 퍼뜨렸을 수 있다 — 다시 보일 때 이 호스트 값으로 되돌린다.
  useEffect(() => {
    const el = view.current;
    if (!visible || !el || !attached || !pageRef.current) return;
    setZoom(applyHostZoom(el, pageRef.current));
  }, [visible, attached]);

  useEffect(() => {
    const onZoom = (e: Event) => {
      const { host, level } = (e as CustomEvent<{ host: string; level: number }>).detail;
      if (host && host === hostOf(pageRef.current)) setZoom(level);
    };
    window.addEventListener("sudal:browser-zoom", onZoom);
    return () => window.removeEventListener("sudal:browser-zoom", onZoom);
  }, []);

  // 숨은 탭(display:none)에서는 폭이 0으로 재진다 — 보일 때 다시 잰다.
  useLayoutEffect(() => {
    if (!visible) return;
    setChipsW(chipsRef.current ? chipsRef.current.offsetWidth + 10 : 0);
  }, [viewport, zoom, t, visible]);

  useEffect(
    () =>
      window.sudal.browser.onAgent((ev) => {
        if (ev.tabId !== chatTabIdRef.current) return;
        if (ev.phase === "pause") {
          setAgentPaused(ev.paused === true);
          return;
        }
        // 이 웹뷰로 향한 명령만. 시작을 못 본 끝(다른 탭에서 시작한 것)은 버린다.
        if (ev.webContentsId === undefined || ev.webContentsId !== wcIdRef.current) return;
        if (ev.phase === "start") agentInflight.current.add(ev.id);
        else if (!agentInflight.current.delete(ev.id)) return;
        const line: AgentLine = { op: ev.op, detail: ev.detail, at: ev.at, ok: ev.phase === "start" ? undefined : ev.phase === "done" };
        setAgent((a) => ({ active: true, now: line, feed: ev.phase === "start" ? a.feed : [line, ...a.feed].slice(0, 4) }));
        if (ev.point) setAgentPoint({ ...ev.point, at: ev.at });
        if (agentIdle.current) clearTimeout(agentIdle.current);
        // 한동안 명령이 없으면 표시를 내린다. 기다리는 명령(wait)이 남아 있으면 계속 둔다.
        if (agentInflight.current.size === 0) agentIdle.current = setTimeout(() => setAgent((a) => ({ ...a, active: false })), 5000);
      }),
    [],
  );
  // 앱을 껐다 켜기 전까지 멈춤은 main 이 들고 있다 — 다시 마운트돼도 같은 상태를 보인다.
  useEffect(() => {
    if (!chatTabId || !visible) return;
    void window.sudal.browser.agentPause(chatTabId).then(setAgentPaused).catch(() => {});
  }, [chatTabId, visible]);
  // 숨으면 이 칸이 세던 명령은 더 이상 이 칸으로 오지 않는다 — 표시와 셈을 비운다.
  useEffect(() => {
    if (visible) return;
    agentInflight.current.clear();
    setAgent((a) => (a.active ? { ...a, active: false } : a));
  }, [visible]);
  // 누른 자리 표시는 잠깐만, 최근 동작의 "N초 전" 은 표시가 떠 있는 동안 1초마다 다시 센다.
  useEffect(() => {
    if (!agentPoint) return;
    const id = setTimeout(() => setAgentPoint(null), 1200);
    return () => clearTimeout(id);
  }, [agentPoint]);
  useEffect(() => {
    if (!agent.active) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [agent.active]);
  const setPaused = (paused: boolean) => {
    if (!chatTabId) return;
    setAgentPaused(paused);
    void window.sudal.browser.agentPause(chatTabId, paused).then(setAgentPaused).catch(() => {});
  };

  // 빈 탭은 주소창부터
  useEffect(() => {
    if (!initialUrl && visible) inputRef.current?.focus();
  }, [initialUrl, visible]);

  // 이 탭이 보이는 동안, 브라우저용 단축키를 받는다(⌘F 찾기·⌘L 주소창·⌘R 새로고침).
  // 앱 단축키는 네이티브 메뉴가 받아 ChatView 가 "지금 보이는 브라우저" 로 넘겨 준다.
  useEffect(() => {
    if (!visible) return;
    const onCmd = (e: Event) => {
      // 분할 화면이면 포커스된 칸의 브라우저만 받는다.
      if (!paneFocus.current) return;
      const what = (e as CustomEvent<string>).detail;
      if (what === "find") {
        setFind((f) => ({ ...f, open: true }));
        setTimeout(() => findRef.current?.select(), 0);
      } else if (what === "address") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (what === "reload") {
        view.current?.reload();
      } else if (what === "hard-reload") {
        view.current?.reloadIgnoringCache();
      }
    };
    window.addEventListener("sudal:browser-command", onCmd);
    return () => window.removeEventListener("sudal:browser-command", onCmd);
  }, [visible]);

  // 찾기 결과 개수는 webview 가 이벤트로 준다
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onFound = (e: Event) => {
      const r = (e as Event & { result?: { matches?: number; activeMatchOrdinal?: number } }).result;
      if (!r) return;
      setFind((f) => ({ ...f, matches: r.matches ?? 0, at: r.activeMatchOrdinal ?? 0 }));
    };
    el.addEventListener("found-in-page", onFound);
    return () => el.removeEventListener("found-in-page", onFound);
  }, [mounted]);

  // 에디터가 "브라우저에서 보기" 를 다시 누르거나 HTML 을 저장하면 그 URL 을 보고 있는 탭을 다시 불러온다
  useEffect(() => {
    const onReload = (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      const el = view.current;
      if (!el || !target) return;
      try {
        if (el.getURL().split("#")[0] === target.split("#")[0]) el.reload();
      } catch {
        /* 아직 붙기 전 */
      }
    };
    window.addEventListener("sudal:browser-reload", onReload);
    return () => window.removeEventListener("sudal:browser-reload", onReload);
  }, [mounted]);

  /** 지금 보이는 화면 + 콘솔 경고·오류 + 실패한 요청을 한 덩어리로 입력창에 붙인다. */
  const attachDiagnostics = async () => {
    const el = view.current;
    if (!el || !url || diagBusy) return;
    setDiagBusy(true);
    try {
      let images: ChatImageDto[] | undefined;
      try {
        const img = await el.capturePage(); // 영역을 생략하면 지금 보이는 화면
        const one = img.isEmpty() ? null : dataUrlImage(img.toDataURL(), "browser.png");
        if (one) images = [one];
      } catch {
        /* 캡처 실패는 텍스트만 */
      }
      let net: Awaited<ReturnType<typeof window.sudal.browser.netFailures>> = [];
      try {
        net = await window.sudal.browser.netFailures(el.getWebContentsId(), true);
      } catch {
        /* 수집이 없으면 빈 목록 */
      }
      const rect = el.getBoundingClientRect();
      onAttachRef.current?.(
        formatDiagnostics(tRef.current, {
          url: (() => {
            try {
              return el.getURL() || url;
            } catch {
              return url;
            }
          })(),
          title,
          at: Date.now(),
          viewport: { width: Math.round(rect.width), height: Math.round(rect.height) },
          console: consoleRef.current,
          net,
          hasScreenshot: Boolean(images),
        }),
        images,
      );
      const errs = consoleRef.current.filter((c) => c.level >= 2).length;
      showToast({
        text: t(images ? "panel.browser.diagAttachedWithShot" : "panel.browser.diagAttached"),
        detail: t("panel.browser.diagDetail", { errors: errs, failures: net.length }),
        hint: t("panel.browser.toastNext"),
      });
    } finally {
      setDiagBusy(false);
    }
  };

  /**
   * 함정: Electron 의 `findNext` 는 이름과 반대다 — "다음 것을 찾아라" 가 아니라 **"새 검색을 시작하는가"** 다.
   * 첫 검색에 true 를 줘야 결과(found-in-page)가 오고, 그 뒤 위아래로 옮길 때 false 를 준다.
   * 거꾸로 주면 아무 일도 안 일어나고 조용히 "없음" 으로 보인다.
   */
  const runFind = (text: string, newSession: boolean, forward = true) => {
    const el = view.current;
    if (!el) return;
    if (!text) {
      try {
        el.stopFindInPage("clearSelection");
      } catch {
        /* 아직 붙기 전 */
      }
      setFind((f) => ({ ...f, text, matches: 0, at: 0 }));
      return;
    }
    try {
      el.findInPage(text, { findNext: newSession, forward });
    } catch {
      /* 아직 붙기 전 */
    }
  };
  const closeFind = () => {
    try {
      view.current?.stopFindInPage("clearSelection");
    } catch {
      /* 무시 */
    }
    setFind({ open: false, text: "", matches: 0, at: 0 });
  };
  const applyZoom = (level: number) => {
    setZoom(level);
    try {
      view.current?.setZoomLevel(level);
    } catch {
      /* 아직 붙기 전 */
    }
    const host = hostOf(url);
    if (!host) return;
    // Chromium 은 같은 호스트의 다른 웹뷰(분할 화면)도 같이 확대한다 — 그쪽 표시도 맞추게 알린다.
    window.dispatchEvent(new CustomEvent("sudal:browser-zoom", { detail: { host, level } }));
    const zooms = readZooms();
    if (level === 0) delete zooms[host];
    else zooms[host] = level;
    kvSet(ZOOM_KEY, Object.keys(zooms).length ? JSON.stringify(zooms) : null);
  };

  // 함정: 웹뷰가 붙기(dom-ready) 전엔 executeJavaScript 가 Promise 거절이 아니라 즉시 던진다 — 그대로 두면
  // effect 안에서 던져 화면 전체가 무너진다. 그래서 try 로 감싼다.
  const runInPage = (code: string) => {
    try {
      void view.current?.executeJavaScript(code).catch(() => {});
    } catch {
      /* 아직 붙기 전 — 페이지에 그릴 것도 없다 */
    }
  };
  const clearTray = () => setTray([]);
  const removeTrayItem = (i: number) => setTray((list) => list.filter((_, k) => k !== i));
  // 페이지의 번호 테두리를 모음 순서대로 다시 매기고, 모음에서 빠진 것은 지운다(비면 모두 지움).
  const trayMarks = tray.map((x) => x.mark ?? 0).join(",");
  useEffect(() => {
    if (!attached) return;
    runInPage(pickerRelabelScript(trayMarks ? trayMarks.split(",").map(Number) : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayMarks, attached]);
  const sendTray = () => {
    const list = trayRef.current;
    if (list.length === 0 || list.some((x) => x.pending)) return;
    // 입력창은 이미지를 4장까지만 받는다 — 앞의 것만 스크린샷을 붙이고, 넘치면 알린다(말없이 버리지 않게).
    const shots = list.flatMap((x) => x.images ?? []);
    onAttachRef.current?.(
      formatNotesAttachment(tRef.current, list.map((x) => ({ element: x.element, url: x.url, memo: x.memo, sourceFile: x.shown }))),
      shots.slice(0, NOTES_MAX_IMAGES),
    );
    if (pickingRef.current) stopPick();
    clearTray();
    showToast({
      text: tRef.current("panel.browser.notes.sent", { count: list.length }),
      hint: shots.length > NOTES_MAX_IMAGES ? tRef.current("panel.browser.notes.shotsTrimmed", { count: NOTES_MAX_IMAGES }) : tRef.current("panel.browser.toastNext"),
    });
  };

  const retry = () => {
    const target = error?.url;
    setError(null);
    const el = view.current;
    if (el && target) void el.loadURL(target).catch(() => {});
  };

  // 연결 거부(개발 서버가 꺼짐)면 서버가 다시 뜰 때 알아서 연다. 웹뷰를 매번 다시 부르면 화면이 깜빡이므로
  // main 이 그 주소에 응답이 오는지만 조용히 보고, 오면 그때 한 번 연다. 보이는 탭에서만.
  useEffect(() => {
    if (!visible || error?.kind !== "refused" || !error.url) return;
    const target = error.url;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const up = await window.sudal.browser.probe(target).catch(() => false);
      if (stop) return;
      if (up) {
        setError(null);
        void view.current?.loadURL(target).catch(() => {});
      } else timer = setTimeout(tick, 2000);
    };
    let timer = setTimeout(tick, 2000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [visible, error]);

  const go = (raw: string) => {
    const next = normalizeUrl(raw);
    if (!next) return;
    setError(null);
    setUrl(next);
    setInput(next);
    onUrlChange?.(next);
    const el = view.current;
    if (el && url) void el.loadURL(next).catch(() => {});
    // url 이 비어 있으면(빈 탭) src 로 처음 붙는다
  };

  // 보이는 브라우저만 main 에 등록한다 — 숨은 탭까지 등록하면 에이전트가 엉뚱한 화면을 조작한다.
  useEffect(() => {
    if (!chatTabId) return;
    const el = view.current;
    // attached 가 신호다 — 요소만 있고 게스트가 안 붙었으면 getWebContentsId() 가 던진다.
    if (!visible || !el || !attached) return;
    let id: number;
    try {
      id = el.getWebContentsId();
    } catch {
      return; // dom-ready 가 다시 불러 준다
    }
    window.sudal.browser.register(chatTabId, id, url);
    return () => window.sudal.browser.register(chatTabId, null, "");
  }, [chatTabId, visible, url, mounted, attached]);

  // 자동완성 후보. 목록이 열려 있을 때만 계산한다.
  const sugs = sugOpen ? suggest(readHistory(), input) : [];

  const vp = viewportById(viewport);
  const frequent = url ? [] : frequentSites(readHistory());
  const btn = "rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30";
  const chip = "rounded bg-accent-tint px-1.5 py-px text-[10.5px] text-accent hover:bg-accent/20";
  const tool = "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] disabled:opacity-30";
  // 주소창 앞 표시: 개발 서버(노트북) · https(자물쇠) · 그 밖(지구본)
  const parts = urlParts(url);
  const addrIcon = !url ? "search" : parts.local ? "laptop" : /^https:/i.test(url) ? "lock" : "globe";
  const showParts = !addrFocus && !!url && input === url && !!parts.host;
  const menuItem = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-panel-2 disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full min-h-0 flex-col" data-browser-pane={url || "blank"}>
      {/* 패널 폭에 따라 글자를 숨긴다 — 좁은 패널에서 주소창이 찌그러지지 않게. */}
      <div className="@container/browserbar flex items-center gap-1 border-b border-line px-2 py-1">
        <button onClick={() => view.current?.goBack()} disabled={!nav.back} className={btn} title={t("panel.browser.back")} data-browser-back>
          <Icon name="chevronRight" size={13} className="rotate-180" />
        </button>
        <button onClick={() => view.current?.goForward()} disabled={!nav.forward} className={btn} title={t("panel.browser.forward")}>
          <Icon name="chevronRight" size={13} />
        </button>
        <button
          onClick={(e) => {
            const el = view.current;
            if (!el) return;
            if (loading) el.stop();
            // ⇧ 를 누른 채 누르면 캐시를 무시한다 — 고쳤는데 화면이 그대로일 때.
            else if (e.shiftKey) el.reloadIgnoringCache();
            else el.reload();
          }}
          disabled={!url}
          className={btn}
          title={loading ? t("panel.browser.stop") : t("panel.browser.reloadTitle")}
          data-browser-reload
        >
          <Icon name={loading ? "x" : "refresh"} size={13} />
        </button>
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const picked = sugAt >= 0 ? sugs[sugAt]?.url : null;
            setSugOpen(false);
            setSugAt(-1);
            go(picked ?? input);
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSugOpen(true);
              setSugAt(-1);
            }}
            onFocus={(e) => {
              e.target.select();
              setAddrFocus(true);
              // 빈 탭은 아래에 자주 간 곳이 이미 있다 — 같은 목록을 위아래로 두 번 띄우지 않게 칠 때만 연다.
              setSugOpen(!!url);
              setSugAt(-1);
            }}
            // 클릭이 먼저 처리되도록 닫기를 미룬다 — 바로 닫으면 목록을 누를 수 없다.
            onBlur={() => {
              setAddrFocus(false);
              setTimeout(() => setSugOpen(false), 150);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                if (sugOpen) setSugOpen(false);
                else setInput(url);
                setSugAt(-1);
                return;
              }
              if (!sugOpen || sugs.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSugAt((i) => (i + 1) % sugs.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSugAt((i) => (i <= 0 ? sugs.length - 1 : i - 1));
              }
            }}
            placeholder={t("panel.browser.addressPlaceholder")}
            spellCheck={false}
            className={`w-full rounded-md border border-line bg-inset py-1 pl-7 pr-2.5 text-[12px] outline-none placeholder:text-muted-2 focus:border-accent/50 ${showParts ? "text-transparent" : "text-fg"}`}
            style={{ userSelect: "text", paddingRight: chipsW || undefined }}
            data-browser-url
          />
          <Icon name={addrIcon} size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          {showParts && (
            <span className="pointer-events-none absolute inset-y-0 left-7 flex min-w-0 items-center overflow-hidden whitespace-nowrap text-[12px]" style={{ right: chipsW || 10 }}>
              <span className="text-fg">{parts.host}</span>
              <span className="truncate text-muted">{parts.rest}</span>
            </span>
          )}
          {/* 기본값이 아닐 때만 — 메뉴에 숨긴 상태를 잊지 않게. 누르면 기본으로. 주소창 안에 두어 도구 버튼과 섞이지 않는다. */}
          {(viewport !== DEFAULT_VIEWPORT || zoom !== 0) && (
            <span ref={chipsRef} className="absolute inset-y-0 right-1.5 flex items-center gap-1">
              {viewport !== DEFAULT_VIEWPORT && (
                <button type="button" onClick={() => setViewport(DEFAULT_VIEWPORT)} className={chip} title={t("panel.browser.viewportReset")} data-browser-viewport-chip>
                  {t(`panel.browser.viewport.${viewport}.label`)}
                </button>
              )}
              {zoom !== 0 && (
                <button type="button" onClick={() => applyZoom(0)} className={`${chip} mono`} title={t("panel.browser.zoomReset")} data-browser-zoom-chip>
                  {zoomLevelToPercent(zoom)}%
                </button>
              )}
            </span>
          )}
          {sugs.length > 0 && (
            <ul
              className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-line bg-panel shadow-lg"
              data-browser-suggest
            >
              {sugs.map((h, k) => (
                <li key={h.url}>
                  <button
                    type="button"
                    // blur 로 목록이 닫히기 전에 눌리도록 mousedown 에서 처리한다.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSugOpen(false);
                      setSugAt(-1);
                      go(h.url);
                    }}
                    onMouseEnter={() => setSugAt(k)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] ${
                      k === sugAt ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2/60"
                    }`}
                  >
                    <Icon name="clock" size={11} className="shrink-0 opacity-60" />
                    <span className="truncate">{h.url}</span>
                    {h.visits > 1 && <span className="ml-auto shrink-0 text-[10px] opacity-50">{t("panel.browser.visits", { count: h.visits })}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
        <button
          onClick={() => (picking ? stopPick() : void startPick())}
          disabled={!url || loading}
          className={`${tool} ${picking ? "bg-accent-tint text-accent" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
          title={picking ? t("panel.browser.pickCancelTitle") : t("panel.browser.pickTitle")}
          data-browser-pick={picking ? "on" : "off"}
        >
          <Icon name="pointerClick" size={13} />
          {/* 선택 중엔 좁아도 글자를 보인다 — 지금 모드가 켜져 있고 Esc 로 끈다는 걸 알아야 한다. */}
          <span className={picking ? "" : "hidden @min-[440px]/browserbar:inline"}>{picking ? t("panel.browser.pickingLabel") : t("panel.browser.pick")}</span>
        </button>
        <button
          onClick={() => void attachDiagnostics()}
          disabled={!url || diagBusy}
          className={`${tool} text-muted hover:bg-panel-2 hover:text-fg`}
          title={t("panel.browser.diagnoseTitle")}
          data-browser-diagnose
        >
          <Icon name="stethoscope" size={13} />
          <span className="hidden @min-[440px]/browserbar:inline">{diagBusy ? t("panel.browser.diagnosing") : t("panel.browser.diagnose")}</span>
        </button>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className={`rounded p-1 ${menuOpen ? "bg-accent-tint text-accent" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
            title={t("panel.browser.more")}
            data-browser-more={menuOpen ? "open" : "closed"}
          >
            <Icon name="more" size={13} strokeWidth={3} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-[248px] rounded-lg border border-line bg-panel p-1 shadow-2xl" data-browser-menu>
              <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] text-muted" title={t("panel.browser.viewportTitle")}>
                {t("panel.browser.viewportLabel")}
              </div>
              <div className="mx-1.5 mb-1.5 grid grid-cols-4 gap-0.5 rounded-md border border-line p-0.5" data-browser-viewport={viewport}>
                {VIEWPORTS.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setViewport(v.id)}
                    className={`rounded px-1 py-1 text-[11px] ${v.id === viewport ? "bg-accent-tint text-accent" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
                    title={t(`panel.browser.viewport.${v.id}.hint`)}
                    data-browser-viewport-option={v.id}
                  >
                    {t(`panel.browser.viewport.${v.id}.label`)}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between px-2.5 py-1">
                <span className="text-[12px]">{t("panel.browser.zoomLabel")}</span>
                <div className="flex items-center rounded-md border border-line" data-browser-zoom={zoomLevelToPercent(zoom)}>
                  <button onClick={() => applyZoom(nextZoom(zoom, -1))} disabled={!url} className="px-1.5 py-0.5 text-muted hover:text-fg disabled:opacity-30" title={t("panel.browser.zoomOut")}>
                    <Icon name="minus" size={11} />
                  </button>
                  <button onClick={() => applyZoom(0)} disabled={!url} className="mono min-w-[42px] px-1 py-0.5 text-[10.5px] text-muted hover:text-fg disabled:opacity-30" title={t("panel.browser.zoomReset")}>
                    {zoomLevelToPercent(zoom)}%
                  </button>
                  <button onClick={() => applyZoom(nextZoom(zoom, 1))} disabled={!url} className="px-1.5 py-0.5 text-muted hover:text-fg disabled:opacity-30" title={t("panel.browser.zoomIn")}>
                    <Icon name="plus" size={11} />
                  </button>
                </div>
              </div>
              <div className="my-1 border-t border-line" />
              <button
                onClick={() => {
                  setMenuOpen(false);
                  void navigator.clipboard.writeText(url).catch(() => {});
                }}
                disabled={!url}
                className={menuItem}
                data-browser-copy-url
              >
                <Icon name="copy" size={12} className="text-muted" />
                {t("panel.browser.copyUrl")}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  const el = view.current;
                  if (!el) return;
                  try {
                    if (el.isDevToolsOpened()) el.closeDevTools();
                    else el.openDevTools();
                  } catch {
                    /* 아직 붙기 전 */
                  }
                }}
                disabled={!url}
                className={menuItem}
                data-browser-devtools
              >
                <Icon name="terminal" size={12} className="text-muted" />
                {t("panel.browser.devtools")}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (url) void window.sudal.browser.openExternal(url);
                }}
                disabled={!url}
                className={menuItem}
                data-browser-external
              >
                <Icon name="externalLink" size={12} className="text-muted" />
                {t("panel.browser.openExternal")}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setImportOpen(true);
                }}
                className={menuItem}
                data-browser-import-open
              >
                <Icon name="lock" size={12} className="text-muted" />
                {t("panel.browser.import.menu")}
              </button>
            </div>
          )}
        </div>
      </div>
      {downloads.length > 0 && (
        <div className="border-b border-line bg-inset px-3 py-1" data-browser-downloads>
          {downloads.map((d) => (
            <div key={d.id} className="py-0.5 text-[11px]" data-browser-download={d.state}>
              <div className="flex items-center gap-2">
              <Icon name={d.state === "completed" ? "check" : d.state === "progressing" ? "arrowDownToLine" : "alert"} size={11} className={`shrink-0 ${d.state === "progressing" ? "text-muted" : d.state === "completed" ? "text-accent" : "text-err"}`} />
              <span className="min-w-0 truncate">{d.name}</span>
              <span className="mono shrink-0 text-[10.5px] text-muted">
                {d.state === "progressing"
                  ? d.total > 0
                    ? `${Math.floor((d.received / d.total) * 100)}%`
                    : t("panel.browser.download.progressing")
                  : t(`panel.browser.download.${d.state}`)}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {d.state === "completed" && (
                  <>
                    <button onClick={() => void window.sudal.browser.showDownload(d.id, "open")} className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg">
                      {t("panel.browser.download.open")}
                    </button>
                    <button onClick={() => void window.sudal.browser.showDownload(d.id, "reveal")} className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg">
                      {t("panel.browser.download.reveal")}
                    </button>
                  </>
                )}
                {d.state === "progressing" ? (
                  <button onClick={() => void window.sudal.browser.cancelDownload(d.id)} className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg" data-browser-download-cancel>
                    {t("panel.browser.download.cancel")}
                  </button>
                ) : (
                  <button onClick={() => setDownloads((l) => l.filter((x) => x.id !== d.id))} className="rounded p-0.5 text-muted hover:text-fg" title={t("panel.browser.download.dismiss")}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </span>
              </div>
              {d.state === "progressing" && d.total > 0 && (
                <div className="mt-1 h-[3px] overflow-hidden rounded bg-line">
                  <div className="h-full rounded bg-accent transition-[width] duration-300" style={{ width: `${Math.min(100, (d.received / d.total) * 100)}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {find.open && (
        <div className="flex items-center gap-2 border-b border-line bg-inset px-3 py-1.5" data-browser-find>
          <Icon name="search" size={12} className="shrink-0 text-muted" />
          <input
            ref={findRef}
            autoFocus
            value={find.text}
            onChange={(e) => {
              const text = e.target.value;
              setFind((f) => ({ ...f, text }));
              runFind(text, true);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") runFind(find.text, false, !e.shiftKey);
              if (e.key === "Escape") closeFind();
            }}
            placeholder={t("panel.browser.findPlaceholder")}
            className="mono min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-muted-2"
            style={{ userSelect: "text" }}
            data-browser-find-input
          />
          <span className="mono shrink-0 text-[10.5px] text-muted-2" data-browser-find-count>
            {find.text ? (find.matches > 0 ? `${find.at}/${find.matches}` : t("common.none")) : ""}
          </span>
          <button onClick={() => runFind(find.text, false, false)} disabled={find.matches === 0} className="rounded p-0.5 text-muted hover:text-fg disabled:opacity-30" title={t("panel.browser.findPrev")}>
            <Icon name="chevronDown" size={12} className="rotate-180" />
          </button>
          <button onClick={() => runFind(find.text, false, true)} disabled={find.matches === 0} className="rounded p-0.5 text-muted hover:text-fg disabled:opacity-30" title={t("panel.browser.findNext")}>
            <Icon name="chevronDown" size={12} />
          </button>
          <button onClick={closeFind} className="rounded p-0.5 text-muted hover:text-fg" title={t("panel.browser.findClose")} data-browser-find-close>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <div className={`relative min-h-0 flex-1 ${viewport === "full" ? "bg-white" : "flex justify-center bg-inset"}`} data-browser-viewport-active={viewport}>
        {bar !== "off" && (
          <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 h-[2px]" data-browser-progress={bar}>
            <div
              className="h-full bg-accent"
              style={{
                width: bar === "start" ? "8%" : bar === "run" ? "85%" : "100%",
                opacity: bar === "done" ? 0 : 1,
                // 차오름은 느리게 끝으로 갈수록 더디게, 끝날 땐 빠르게 채우고 사라진다.
                transition: bar === "run" ? "width 8s cubic-bezier(0.1, 0.7, 0.2, 1)" : bar === "done" ? "width 150ms ease-out, opacity 250ms ease 100ms" : "none",
              }}
            />
          </div>
        )}
        {url ? (
          // partition 을 앱 세션과 분리해 쿠키·저장소가 섞이지 않게 한다.
          <webview
            ref={(el) => {
              view.current = el as unknown as SudalWebview | null; // React 의 HTMLWebViewElement 타입엔 Electron 메서드가 없다
              setMounted(!!el);
            }}
            src={firstSrc.current}
            partition="persist:sudal-browser"
            // 없으면 target=_blank·window.open 이 main 의 새 창 처리기까지 오지 못하고 조용히 막힌다.
            // 처리기는 늘 거절하고 새 탭으로 돌리므로 실제 팝업 창은 생기지 않는다.
            // React 타입은 boolean 이지만 Electron 은 속성이 있는지만 본다 — 문자열로 넣어야 DOM 에 확실히 남는다.
            allowpopups={"true" as unknown as boolean}
            // 프리셋 폭보다 패널이 좁으면 패널을 따른다 — 가로 스크롤이 생기면 좁은 화면 확인이 안 된다
            style={{ width: vp.width ? `min(100%, ${vp.width}px)` : "100%", height: "100%" }}
          />
        ) : (
          <div className="flex h-full flex-col items-center bg-inset px-8 pt-[12vh]">
            <div className="text-[16px] font-semibold text-fg">{t("panel.browser.emptyTitle")}</div>
            <div className="mt-1.5 text-[12px] text-muted">{t("panel.browser.emptyHint")}</div>
            {frequent.length > 0 && (
              <div className="mt-7 w-full max-w-[420px]" data-browser-frequent>
                <div className="mb-1 px-2 text-[10.5px] text-muted-2">{t("panel.browser.frequent")}</div>
                {frequent.map((f) => {
                  const p = urlParts(f.url);
                  return (
                    <button
                      key={f.origin}
                      onClick={() => go(f.url)}
                      className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12px] hover:bg-panel-2"
                      title={f.url}
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-panel text-[11px] font-semibold uppercase text-muted">
                        {p.local ? <Icon name="laptop" size={12} /> : p.host.replace(/^www\./, "").charAt(0)}
                      </span>
                      <span className="flex min-w-0 flex-1 overflow-hidden whitespace-nowrap">
                        <span className="text-fg">{p.host}</span>
                        <span className="truncate text-muted-2">{p.rest}</span>
                      </span>
                      <span className="shrink-0 text-[10.5px] text-muted-2">{t("panel.browser.visits", { count: f.visits })}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mono mt-6 text-[10.5px] text-muted-2">{t("panel.browser.emptyKeys")}</div>
          </div>
        )}
        {(agent.active || agentPaused) && url && (
          <>
            <div className={`pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ${agentPaused ? "ring-warn/70" : "ring-accent"}`} data-browser-agent-ring />
            <div
              className={`absolute left-2 right-2 top-2 z-30 flex items-center gap-2 rounded-lg border bg-panel-2 py-1 pl-2.5 pr-1 text-[11.5px] shadow-xl ${agentPaused ? "border-warn/50" : "border-accent/50"}`}
              data-browser-agent={agentPaused ? "paused" : "active"}
            >
              <Icon name="bot" size={13} className={agentPaused ? "text-warn" : "text-accent"} />
              <span className="shrink-0 font-semibold text-fg">{agentPaused ? t("panel.browser.agent.paused") : t("panel.browser.agent.working")}</span>
              <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-muted" data-browser-agent-now>
                {!agentPaused && agent.now ? `${agent.now.op}${agent.now.detail ? `  ${agent.now.detail}` : ""}` : ""}
              </span>
              {agentPaused ? (
                <button onClick={() => setPaused(false)} className="shrink-0 rounded-md bg-accent-tint px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20" data-browser-agent-resume>
                  {t("panel.browser.agent.resume")}
                </button>
              ) : (
                <button onClick={() => setPaused(true)} className="flex shrink-0 items-center gap-1 rounded-md bg-err-bg px-2 py-0.5 text-[11px] text-err hover:opacity-90" data-browser-agent-stop>
                  <span className="size-2 rounded-[2px] bg-err" />
                  {t("panel.browser.agent.stop")}
                </button>
              )}
            </div>
            {!agentPaused && agent.feed.length > 0 && (
              <div className="pointer-events-none absolute bottom-3 right-3 z-30 w-[220px] rounded-lg border border-line bg-panel-2 px-3 py-2 shadow-xl" data-browser-agent-feed>
                <div className="mb-1 text-[10px] text-muted-2">{t("panel.browser.agent.recent")}</div>
                {agent.feed.map((l) => {
                  const sec = Math.max(0, Math.round((Date.now() - l.at) / 1000));
                  return (
                    <div key={`${l.at}-${l.op}`} className="flex items-center gap-2 py-0.5 text-[10.5px]">
                      <span className={`size-1.5 shrink-0 rounded-full ${l.ok === false ? "bg-err" : "bg-accent"}`} />
                      <span className="mono min-w-0 flex-1 truncate text-muted">
                        {l.op}
                        {l.detail ? `  ${l.detail}` : ""}
                      </span>
                      <span className="shrink-0 text-muted-2">{sec < 2 ? t("panel.browser.agent.now") : t("panel.browser.agent.secondsAgo", { n: sec })}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        {agentPoint && view.current && (
          // 페이지 좌표 → 이 칸 좌표: 웹뷰가 가운데 놓인 만큼(보기 폭) 밀고, 확대 배율만큼 키운다.
          <span
            className="pointer-events-none absolute z-30 size-9 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-accent bg-accent/20"
            style={{ left: view.current.offsetLeft + agentPoint.x * (zoomLevelToPercent(zoom) / 100), top: view.current.offsetTop + agentPoint.y * (zoomLevelToPercent(zoom) / 100) }}
            data-browser-agent-point
          />
        )}
        {tray.length > 0 && url && (
          <div className="absolute bottom-2 left-2 right-2 z-30 overflow-hidden rounded-xl border border-line bg-panel-2 text-[11.5px] shadow-2xl" data-browser-notes>
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1 font-semibold text-fg">{t("panel.browser.notes.title", { count: tray.length })}</span>
              <button onClick={clearTray} className="text-[11px] text-muted hover:text-fg" data-browser-notes-clear>
                {t("panel.browser.notes.clear")}
              </button>
            </div>
            <div className="max-h-[40vh] overflow-y-auto">
              {tray.map((it, i) => (
                <div key={it.id} className="flex items-start gap-2.5 border-t border-line px-3 py-1.5" data-browser-note={i + 1}>
                  <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent-tint text-[10px] font-bold text-accent">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[10.5px] text-muted">
                      {it.element.source ? formatSource(it.element.source, it.shown) : `<${it.element.tag}> ${it.element.text.slice(0, 40)}`}
                    </div>
                    <input
                      value={it.memo}
                      onChange={(e) => {
                        const memo = e.target.value;
                        setTray((list) => list.map((x, k) => (k === i ? { ...x, memo } : x)));
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== "Enter") return;
                        e.preventDefault();
                        // 다음 메모로, 마지막이면 보낸다.
                        const next = e.currentTarget.closest("[data-browser-notes]")?.querySelectorAll("input")[i + 1] as HTMLInputElement | undefined;
                        if (next) next.focus();
                        else sendTray();
                      }}
                      placeholder={t("panel.browser.notes.placeholder")}
                      className="mt-1 w-full rounded-md border border-line bg-inset px-2 py-1 text-[11.5px] text-fg outline-none placeholder:text-muted-2 focus:border-accent/50"
                      style={{ userSelect: "text" }}
                      data-browser-note-memo
                    />
                  </div>
                  <button onClick={() => removeTrayItem(i)} className="mt-0.5 rounded p-0.5 text-muted-2 hover:text-fg" title={t("panel.browser.notes.remove")}>
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-line px-3 py-2">
              <span className="flex-1 text-[11px] text-muted-2">{t("panel.browser.notes.hint")}</span>
              <button
                onClick={sendTray}
                disabled={tray.some((x) => x.pending)}
                className="rounded-md bg-accent px-3 py-1 text-[11.5px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
                data-browser-notes-send
              >
                {tray.some((x) => x.pending) ? t("panel.browser.notes.preparing") : t("panel.browser.notes.send", { count: tray.length })}
              </button>
            </div>
          </div>
        )}
        {importOpen && (
          <BrowserImportSheet
            currentHost={hostOf(url).replace(/:\d+$/, "")}
            onClose={() => setImportOpen(false)}
            onDone={(r) => {
              setImportOpen(false);
              showToast({ text: t("panel.browser.import.done", { count: r.sites }), detail: r.skipped ? t("panel.browser.import.skipped", { count: r.skipped }) : undefined });
              // 새 쿠키로 다시 불러와야 로그인한 화면이 보인다.
              try {
                view.current?.reload();
              } catch {
                /* 아직 붙기 전 */
              }
            }}
          />
        )}
        {toast && (
          <div className={`${toast.action ? "" : "pointer-events-none"} absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-panel-2 py-1.5 pl-3 pr-1.5 text-[11.5px] shadow-xl`} data-browser-pick-msg role="status">
            <Icon name={toast.error ? "alert" : "check"} size={12} className={`shrink-0 ${toast.error ? "text-err" : "text-accent"}`} />
            <span className="shrink-0 text-fg">{toast.text}</span>
            {toast.detail && <span className="mono min-w-0 truncate text-[10.5px] text-muted">{toast.detail}</span>}
            {toast.hint && <span className="ml-1 shrink-0 rounded-md bg-accent-tint px-2 py-0.5 text-[11px] text-accent">{toast.hint}</span>}
            {toast.action && (
              <button
                onClick={() => {
                  toast.action?.run();
                  showToast(null);
                }}
                className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-accent-tint px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
                data-browser-open-source
              >
                <Icon name="file" size={11} />
                {toast.action.label}
              </button>
            )}
          </div>
        )}
        {error && url && (
          // 웹뷰 위에 덮는다 — 웹뷰를 내리면 다시 시도할 때 페이지를 처음부터 붙여야 한다.
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-inset px-8 text-center" data-browser-error={error.kind}>
            <div className="flex size-11 items-center justify-center rounded-full bg-err-bg">
              <Icon name={error.kind === "refused" ? "plugZap" : "alert"} size={20} className="text-err" />
            </div>
            <div className="mt-4 text-[14px] font-semibold text-fg">{t(`panel.browser.error.${error.kind}.title`, { host: hostOf(error.url) || error.url })}</div>
            <div className="mt-1.5 max-w-[360px] text-[12px] text-muted">{t(`panel.browser.error.${error.kind}.hint`, { host: hostOf(error.url) || error.url })}</div>
            <div className="mt-5 flex gap-2">
              {/* 브라우저가 스스로 막는 주소는 다시 시도해도 같다 — 버튼을 주지 않는다. */}
              {error.kind !== "blocked" && (
                <button onClick={retry} className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg hover:opacity-90" data-browser-retry>
                  <Icon name="refresh" size={12} strokeWidth={2.2} />
                  {t("panel.browser.retry")}
                </button>
              )}
              <button onClick={() => error.url && void window.sudal.browser.openExternal(error.url)} className="rounded-md border border-line px-3.5 py-1.5 text-[12px] text-muted hover:bg-panel-2 hover:text-fg">
                {t("panel.browser.openExternal")}
              </button>
            </div>
            {error.kind === "refused" && (
              <div className="mt-4 flex items-center gap-1.5 text-[11px] text-muted" data-browser-auto-retry>
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                {t("panel.browser.autoRetry")}
              </div>
            )}
            <div className="mono mt-4 max-w-full truncate text-[10px] text-muted-2">{error.code}</div>
          </div>
        )}
      </div>
      <div className="mono flex items-center gap-2 border-t border-line px-2 py-0.5 text-[10px] text-muted" data-browser-status>
        <span className="truncate">{hoverUrl || title || (loading ? t("common.loading") : "")}</span>
      </div>
    </div>
  );
}
