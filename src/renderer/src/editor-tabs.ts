// 에디터 패널의 열린 파일 목록 — 채팅 탭(tabId)마다 따로. ChatView 가 탭마다 다시 마운트되므로 컴포넌트 밖에 둔다.
import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { kvGet, kvSet } from "./kv-store";
import { isAbsoluteAny, isUnderAny, joinAny, relativeAny, samePath } from "@shared/any-path";

export interface EditorTabsState {
  files: string[];
  active: string | null;
  /** 패널 표시 여부. 파일을 열면 true, 헤더의 "코드" 로 접을 수 있다. */
  visible: boolean;
  /** 최대화 — 채팅·오른쪽 패널을 잠시 숨기고 창 전체를 쓴다. 우측에 붙어 있으면 좁은 화면이 있어서. */
  maximized: boolean;
  /** 저장하지 않은 변경이 있는 파일. 파일 트리의 이름 변경·삭제가 이걸 보고 편집 중인 파일을 건드리지 않는다. */
  dirty: string[];
  /** 마지막 열기 요청의 줄 범위(Read 툴카드의 offset/limit). nonce 가 바뀔 때마다 에디터가 그 줄로 이동한다. */
  reveal: EditorReveal | null;
}

export interface EditorReveal {
  path: string;
  /** 1부터 세는 줄 번호. */
  line: number;
  endLine?: number;
  nonce: number;
}

const EMPTY: EditorTabsState = { files: [], active: null, visible: false, maximized: false, dirty: [], reveal: null };
let revealSeq = 0;
const states = new Map<string, EditorTabsState>();
const listeners = new Set<() => void>();
export const MAX_EDITOR_FILES = 12;

// ===== 디스크 보존 =====
// 열린 파일 목록과 미저장 본문을 kv-store(main 의 renderer-state.json) 에 둔다(앱 종료·충돌 뒤 다시 열면 그대로). reveal 은 일회성이라 제외.
// 처음 접근할 때 한 번 읽고, 바뀌면 잠깐 모아서 쓴다. main 은 받는 즉시 파일에 쓰므로 그 뒤 앱이 죽어도 남는다.
const EDITOR_STORAGE_KEY = "editorTabs.v1";
/** 파일 뷰어 상한(1MB)과 같다 — 그보다 큰 초안은 메모리에만 둔다. */
const DRAFT_MAX_CHARS = 1_000_000;
const SAVE_DELAY_MS = 300;
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const raw = kvGet(EDITOR_STORAGE_KEY);
  if (!raw) return;
  try {
    const j = JSON.parse(raw) as {
      states?: Record<string, Partial<EditorTabsState>>;
      drafts?: Record<string, Partial<EditorDraft>>;
      browserUrls?: Record<string, unknown>;
    };
    for (const [tabId, st] of Object.entries(j.states ?? {})) {
      const files = Array.isArray(st.files) ? st.files.filter((f): f is string => typeof f === "string") : [];
      if (files.length === 0) continue;
      states.set(tabId, {
        files,
        active: typeof st.active === "string" && files.includes(st.active) ? st.active : files[0],
        visible: st.visible !== false,
        maximized: st.maximized === true,
        dirty: Array.isArray(st.dirty) ? st.dirty.filter((f): f is string => typeof f === "string" && files.includes(f)) : [],
        reveal: null,
      });
    }
    for (const [p, d] of Object.entries(j.drafts ?? {})) {
      if (!d || typeof d.text !== "string") continue;
      drafts.set(p, { text: d.text, mtimeMs: typeof d.mtimeMs === "number" ? d.mtimeMs : null, size: typeof d.size === "number" ? d.size : null });
    }
    for (const [key, u] of Object.entries(j.browserUrls ?? {})) {
      if (typeof u === "string" && /^https?:\/\//i.test(u)) browserUrls.set(key, u);
    }
  } catch {
    /* 깨진 저장분은 버린다 */
  }
}

function persistNow() {
  const statesOut: Record<string, Omit<EditorTabsState, "reveal">> = {};
  for (const [tabId, st] of states) if (st.files.length > 0) statesOut[tabId] = { files: st.files, active: st.active, visible: st.visible, maximized: st.maximized, dirty: st.dirty };
  const draftsOut: Record<string, EditorDraft> = {};
  for (const [p, d] of drafts) if (d.text.length <= DRAFT_MAX_CHARS) draftsOut[p] = d;
  // 아직 열려 있는 브라우저 탭의 주소만 남긴다(닫은 탭의 주소가 쌓이지 않게)
  const open = new Set<string>();
  for (const st of states.values()) for (const f of st.files) open.add(f);
  const urlsOut: Record<string, string> = {};
  for (const [key, u] of browserUrls) if (open.has(key)) urlsOut[key] = u;
  const empty = Object.keys(statesOut).length === 0 && Object.keys(draftsOut).length === 0 && Object.keys(urlsOut).length === 0;
  kvSet(EDITOR_STORAGE_KEY, empty ? null : JSON.stringify({ states: statesOut, drafts: draftsOut, browserUrls: urlsOut }));
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, SAVE_DELAY_MS);
}

/** 테스트·종료 직전용: 모아 둔 저장을 지금 쓴다. */
export function flushEditorTabsStorage(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  ensureLoaded();
  persistNow();
}

function set(tabId: string, next: EditorTabsState) {
  ensureLoaded();
  states.set(tabId, next);
  scheduleSave();
  for (const l of listeners) l();
}

export function getEditorTabs(tabId: string): EditorTabsState {
  ensureLoaded();
  return states.get(tabId) ?? EMPTY;
}

/**
 * 파일을 열고 활성화한다. 이미 열려 있으면 활성화만. 상한을 넘으면 가장 오래된(맨 앞) 파일부터 닫되,
 * 저장하지 않은 파일은 건너뛴다 — 전부 편집 중이면 상한을 넘겨서라도 연다(조용히 버리지 않는다).
 */
// ===== 마지막으로 쓴 영역 =====
// ⌘W 가 무엇을 닫을지 정할 때 쓴다. 포커스만 보면 부족하다 — 오른쪽 패널이나 툴카드에서 파일을 열면
// 에디터가 뜨지만 포커스는 누른 그 버튼에 남아서, 사용자는 코드를 보고 있는데 세션이 닫힌다.
// 파일을 여는 것 자체를 "이제 에디터를 쓰겠다" 는 신호로 친다. 디스크에 저장하지 않는다(일회성).
const lastPane = new Map<string, "chat" | "editor">();

export function setLastPane(tabId: string, pane: "chat" | "editor"): void {
  lastPane.set(tabId, pane);
}

export function getLastPane(tabId: string): "chat" | "editor" {
  return lastPane.get(tabId) ?? "chat";
}

export function openEditorFile(tabId: string, path: string, at?: { line?: number; endLine?: number } | null): void {
  setLastPane(tabId, "editor");
  const cur = getEditorTabs(tabId);
  // Windows 에서는 같은 파일이 "C:/a" 와 "C:\a" 로 올 수 있다 — 이미 열린 표기를 그대로 쓴다
  if (isAbsoluteAny(path)) path = cur.files.find((f) => isAbsoluteAny(f) && samePath(f, path)) ?? path;
  const files = cur.files.includes(path) ? [...cur.files] : [...cur.files, path];
  let over = files.length - MAX_EDITOR_FILES;
  for (let i = 0; over > 0 && i < files.length; ) {
    if (files[i] !== path && !cur.dirty.includes(files[i])) {
      files.splice(i, 1);
      over--;
    } else i++;
  }
  const reveal =
    at && typeof at.line === "number" && at.line > 0
      ? { path, line: Math.floor(at.line), endLine: at.endLine && at.endLine >= at.line ? Math.floor(at.endLine) : undefined, nonce: ++revealSeq }
      : cur.reveal?.path === path
        ? cur.reveal
        : null;
  set(tabId, { ...cur, files, active: path, visible: true, reveal });
}

/** 브라우저 탭 키: "browser:<n>"(빈 주소창) 또는 http(s) URL. 파일 경로와 같은 목록에 산다. */
export function isBrowserTab(key: string): boolean {
  return /^(browser:|https?:\/\/)/i.test(key);
}
let browserSeq = 0;
/** 빈 브라우저 탭을 연다(주소창에 포커스). 키는 어느 채팅 탭에도 없는 번호로 — 재시작 뒤 복원된 `browser:n` 과 겹치지 않게. */
export function openBrowserTab(tabId: string, url?: string): void {
  if (url && /^https?:\/\//i.test(url)) return openEditorFile(tabId, url);
  ensureLoaded();
  let key = `browser:${++browserSeq}`;
  while ([...states.values()].some((st) => st.files.includes(key))) key = `browser:${++browserSeq}`;
  openEditorFile(tabId, key);
}

/**
 * 최근에 닫은 탭 — 채팅 탭마다 따로, 최신이 뒤. ⌘⇧T 로 되돌린다.
 * 브라우저 탭은 키만 되살리면 빈 탭이 되므로 보던 주소를 같이 들고 있는다.
 */
const closedStacks = new Map<string, { key: string; url: string | null }[]>();
export const MAX_CLOSED_TABS = 10;

export function closeEditorFile(tabId: string, path: string): void {
  const cur = getEditorTabs(tabId);
  const i = cur.files.indexOf(path);
  if (i === -1) return;
  const stack = closedStacks.get(tabId) ?? [];
  stack.push({ key: path, url: browserUrls.get(path) ?? null });
  closedStacks.set(tabId, stack.slice(-MAX_CLOSED_TABS));
  const files = cur.files.filter((f) => f !== path);
  const active = cur.active === path ? (files[Math.min(i, files.length - 1)] ?? null) : cur.active;
  set(tabId, {
    files,
    active,
    visible: cur.visible && files.length > 0,
    maximized: cur.maximized && files.length > 0,
    dirty: cur.dirty.filter((f) => f !== path),
    reveal: cur.reveal?.path === path ? null : cur.reveal,
  });
  // 닫은 브라우저 탭의 주소는 버린다(같은 키를 다른 채팅 탭이 열고 있으면 남긴다)
  if (browserUrls.has(path) && ![...states.values()].some((st) => st.files.includes(path))) {
    browserUrls.delete(path);
    scheduleSave();
  }
  // 닫은 파일의 미저장 본문은 버린다(다른 채팅 탭이 아직 편집 중이면 남긴다)
  if (![...states.values()].some((st) => st.dirty.includes(path))) {
    drafts.delete(path);
    scheduleSave();
  }
}

// ===== 미저장 본문 =====
// 에디터 컴포넌트는 패널을 접거나 다른 채팅 탭·설정 화면으로 가면 내려간다. 그때 본문이 사라지지 않게 여기 들고 있다가
// 다시 마운트될 때 되살린다. 저장·버리고 닫기·파일 삭제 때 지운다.

export interface EditorDraft {
  text: string;
  /** 편집의 바탕이 된 디스크 버전(mtime·크기). 되살릴 때 디스크와 다르면 밖에서 바뀐 것이고, 저장의 충돌 검사도 이 값을 기준으로 한다. */
  mtimeMs: number | null;
  size: number | null;
}
const drafts = new Map<string, EditorDraft>();

/** 마지막으로 닫은 탭을 되살린다. 되살릴 것이 없으면 false. */
export function reopenClosedEditorTab(tabId: string): boolean {
  ensureLoaded();
  const stack = closedStacks.get(tabId);
  const last = stack?.pop();
  if (!last) return false;
  // 이미 다시 열려 있으면(다른 경로로 열었다) 그 다음 것을 본다.
  if (getEditorTabs(tabId).files.includes(last.key)) return reopenClosedEditorTab(tabId);
  if (last.url !== null) {
    browserUrls.set(last.key, last.url);
    scheduleSave();
  }
  openEditorFile(tabId, last.key);
  return true;
}

export function getEditorDraft(path: string): EditorDraft | null {
  ensureLoaded();
  return drafts.get(path) ?? null;
}

export function setEditorDraft(path: string, draft: EditorDraft | null): void {
  ensureLoaded();
  if (draft) drafts.set(path, draft);
  else if (!drafts.delete(path)) return;
  scheduleSave();
}

// ===== 브라우저 탭이 마지막으로 보던 주소 =====
// 탭 키(`browser:<n>` 또는 처음 연 URL)는 고정이고 그 안에서 이동한 주소는 BrowserPane 의 지역 상태였다.
// 그래서 채팅 탭을 바꾸거나 패널을 접어 컴포넌트가 내려가면 재현 중이던 페이지를 잃었다. 초안과 같은 자리에 들고 있다가 돌려준다.
const browserUrls = new Map<string, string>();

/** 이 브라우저 탭을 다시 열 때 보여 줄 주소. 없으면 null(키가 URL 이면 호출한 쪽이 그 키를 쓴다). */
export function getBrowserUrl(key: string): string | null {
  ensureLoaded();
  return browserUrls.get(key) ?? null;
}

export function setBrowserUrl(key: string, url: string | null): void {
  ensureLoaded();
  if (url && /^https?:\/\//i.test(url)) {
    if (browserUrls.get(key) === url) return;
    browserUrls.set(key, url);
  } else if (!browserUrls.delete(key)) return;
  scheduleSave();
}

/** FileEditor 가 편집 상태를 알린다. */
export function setEditorFileDirty(tabId: string, path: string, dirty: boolean): void {
  const cur = getEditorTabs(tabId);
  if (cur.dirty.includes(path) === dirty) return;
  set(tabId, { ...cur, dirty: dirty ? [...cur.dirty, path] : cur.dirty.filter((f) => f !== path) });
}

/** 어느 채팅 탭에서든 이 경로(폴더면 하위 포함)에 저장하지 않은 변경이 있는 파일. 없으면 빈 배열. */
export function dirtyEditorPathsUnder(path: string): string[] {
  ensureLoaded();
  const out = new Set<string>();
  for (const st of states.values()) for (const f of st.dirty) if (isUnderAny(f, path)) out.add(f);
  return [...out];
}

export function activateEditorFile(tabId: string, path: string): void {
  setLastPane(tabId, "editor");
  const cur = getEditorTabs(tabId);
  if (!cur.files.includes(path)) return;
  set(tabId, { ...cur, active: path, visible: true });
}

export function setEditorPaneVisible(tabId: string, visible: boolean): void {
  const cur = getEditorTabs(tabId);
  const on = visible && cur.files.length > 0;
  if (!on) setLastPane(tabId, "chat");
  // 접으면 최대화도 푼다 — 다시 펼쳤을 때 채팅이 사라진 화면으로 돌아오면 당황스럽다
  set(tabId, { ...cur, visible: on, maximized: on && cur.maximized });
}

/** 최대화 토글. 패널이 접혀 있으면 켜면서 함께 펼친다. */
export function setEditorMaximized(tabId: string, maximized: boolean): void {
  const cur = getEditorTabs(tabId);
  if (cur.files.length === 0) return;
  set(tabId, { ...cur, maximized, visible: maximized ? true : cur.visible });
}

/** 모델에 없는(삭제된) 채팅 탭의 상태를 정리한다. 닫힌 탭은 모델에 남아 있으므로 다시 열면 그대로다. */
export function pruneEditorTabs(liveTabIds: Set<string>): void {
  ensureLoaded();
  for (const tabId of [...states.keys()]) if (!liveTabIds.has(tabId)) forgetEditorTabs(tabId);
}

/** 채팅 탭이 삭제됐다: 열린 파일 목록과, 다른 탭이 편집 중이지 않은 미저장 본문을 버린다. */
export function forgetEditorTabs(tabId: string): void {
  closedStacks.delete(tabId);
  ensureLoaded();
  const st = states.get(tabId);
  states.delete(tabId);
  for (const p of st?.dirty ?? []) if (![...states.values()].some((o) => o.dirty.includes(p))) drafts.delete(p);
  scheduleSave();
}

export function useEditorTabs(tabId: string): EditorTabsState {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return getEditorTabs(tabId);
}

/** 파일이 이름을 바꾸거나 옮겨졌다: 열려 있던 모든 채팅 탭의 에디터 탭 경로를 따라 바꾼다(폴더면 하위 경로까지). */
export function renameEditorPaths(from: string, to: string): void {
  ensureLoaded();
  const mapPath = (p: string) => {
    const rel = relativeAny(p, from);
    return rel === null ? p : rel === "" ? to : joinAny(to, rel);
  };
  for (const [p, d] of [...drafts]) {
    const np = mapPath(p);
    if (np !== p) {
      drafts.delete(p);
      drafts.set(np, d);
      scheduleSave();
    }
  }
  for (const [tabId, st] of states) {
    if (!st.files.some((f) => isUnderAny(f, from))) continue;
    set(tabId, { ...st, files: st.files.map(mapPath), active: st.active ? mapPath(st.active) : null, dirty: st.dirty.map(mapPath) });
  }
}

/** 파일이 지워졌다: 열려 있던 에디터 탭을 닫는다(폴더면 하위 경로까지). */
export function closeEditorPaths(path: string): void {
  ensureLoaded();
  for (const p of [...drafts.keys()]) {
    if (isUnderAny(p, path)) {
      drafts.delete(p);
      scheduleSave();
    }
  }
  for (const [tabId, st] of states) {
    const files = st.files.filter((f) => !isUnderAny(f, path));
    if (files.length === st.files.length) continue;
    // 활성 탭이 닫혔으면 closeEditorFile 처럼 그 자리의 이웃을 고른다(맨 끝으로 점프하지 않게)
    const i = st.active ? st.files.indexOf(st.active) : -1;
    const active = st.active && files.includes(st.active) ? st.active : (files[Math.min(Math.max(i, 0), files.length - 1)] ?? null);
    set(tabId, {
      files,
      active,
      visible: st.visible && files.length > 0,
      maximized: st.maximized && files.length > 0,
      dirty: st.dirty.filter((f) => files.includes(f)),
      reveal: st.reveal && files.includes(st.reveal.path) ? st.reveal : null,
    });
  }
}

/**
 * 브라우저 탭에 보일 라벨: 보통은 호스트(+경로 앞부분). 에디터 HTML 미리보기(127.0.0.1 의 /p/<token>/<root>/…)는
 * 주소가 알아볼 수 없는 토큰이라 파일 이름을 쓴다. 빈 탭은 "브라우저".
 */
export function browserTabLabel(key: string, t: TFunction): string {
  if (key.startsWith("browser:")) return t("panel.browser.tabLabel");
  try {
    const u = new URL(key);
    if (/^127\.0\.0\.1$/.test(u.hostname) && u.pathname.startsWith("/p/")) {
      const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
      try {
        return t("panel.browser.previewOf", { name: decodeURIComponent(last) });
      } catch {
        return t("panel.browser.preview");
      }
    }
    return u.host + (u.pathname !== "/" ? u.pathname.slice(0, 24) : "");
  } catch {
    return key.slice(0, 30);
  }
}
