import type { ChatImageDto } from "@shared/ipc";
// 입력창에 쓰다 만 글. 채팅 탭마다 따로 둔다 — 탭을 옮기거나 앱을 껐다 켜도 남는다. 전송하면 비운다.
// 진실은 메모리 캐시(cache)이고 kv-store(main 의 renderer-state.json)는 그 사본이다: 저장은 잠깐 모아서 쓰지만 읽기는 항상 최신을 준다
// (빠르게 탭을 오가도 300ms 안의 입력이 옛 저장분에 밀리지 않는다). 첨부 이미지는 크기 때문에 보존하지 않는다.
import { kvGet, kvKeys, kvSet } from "./kv-store";

const KEY_PREFIX = "composerDraft.";
const SAVE_DELAY_MS = 300;
/** 이보다 긴 글은 저장하지 않는다. */
const MAX_CHARS = 200_000;
const cache = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function loadComposerDraft(tabId: string): string {
  const cached = cache.get(tabId);
  if (cached !== undefined) return cached;
  const v = kvGet(KEY_PREFIX + tabId) ?? "";
  cache.set(tabId, v);
  return v;
}

/** 입력이 바뀔 때마다 부른다. 캐시는 바로, 저장소는 잠깐 모아서. 빈 글이면 지운다. */
export function saveComposerDraft(tabId: string, text: string): void {
  cache.set(tabId, text);
  const t = timers.get(tabId);
  if (t) clearTimeout(t);
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      writeNow(tabId, cache.get(tabId) ?? "");
    }, SAVE_DELAY_MS),
  );
}

/** 전송했거나 탭이 삭제됐다: 캐시·저장소 모두 비운다(컴포넌트가 이미 내려갔어도 동작한다). */
export function clearComposerDraft(tabId: string): void {
  cache.set(tabId, "");
  const t = timers.get(tabId);
  if (t) {
    clearTimeout(t);
    timers.delete(tabId);
  }
  writeNow(tabId, "");
}

/** 모델에 없는(삭제된) 탭의 초안을 지운다. 탭 삭제가 어느 경로로 일어났든 여기서 정리된다. */
export function pruneComposerDrafts(liveTabIds: Set<string>): void {
  for (const tabId of [...cache.keys()]) if (!liveTabIds.has(tabId)) clearComposerDraft(tabId);
  for (const k of kvKeys(KEY_PREFIX)) if (!liveTabIds.has(k.slice(KEY_PREFIX.length))) kvSet(k, null);
  for (const k of kvKeys(FILES_PREFIX)) if (!liveTabIds.has(k.slice(FILES_PREFIX.length))) kvSet(k, null);
}

// ===== 첨부한 파일(이미지 말고): 경로만 들고 있다가 보낼 때 글 끝에 목록으로 붙인다 =====
// 경로뿐이라 작아서 보존한다 — 탭을 옮기거나 앱을 껐다 켜도 남는다.
export interface ComposerFile {
  path: string;
  name: string;
}
const FILES_PREFIX = "composerFiles.";
const MAX_FILES = 20;

export function loadComposerFiles(tabId: string): ComposerFile[] {
  try {
    const v = JSON.parse(kvGet(FILES_PREFIX + tabId) ?? "[]");
    return Array.isArray(v) ? v.filter((f): f is ComposerFile => !!f && typeof f.path === "string" && typeof f.name === "string").slice(0, MAX_FILES) : [];
  } catch {
    return [];
  }
}

export function saveComposerFiles(tabId: string, files: ComposerFile[]): void {
  kvSet(FILES_PREFIX + tabId, files.length ? JSON.stringify(files.slice(0, MAX_FILES)) : null);
}

/** 보낼 글: 쓴 글 끝에 첨부 파일 목록을 붙인다. 경로는 백틱으로 감싸 띄어쓰기가 든 경로도 한 덩어리로 읽힌다. */
export function withAttachedFiles(text: string, files: ComposerFile[], head: string): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- \`${f.path.replace(/`/g, "\\`")}\``).join("\n");
  return `${text ? `${text}\n\n` : ""}${head}\n${list}`;
}

// ===== 채팅 화면 어디에 놓든 그 탭의 입력창으로 =====
type DropListener = (files: File[]) => void;
const dropListeners = new Map<string, Set<DropListener>>();

/** 채팅 화면에 놓은 파일을 그 탭의 입력창에 넘긴다. 입력창이 없으면(내려가 있음) false. */
export function dropComposerFiles(tabId: string, files: File[]): boolean {
  const ls = dropListeners.get(tabId);
  if (!ls || ls.size === 0) return false;
  for (const l of ls) l(files);
  return true;
}

export function onComposerFilesDrop(tabId: string, listener: DropListener): () => void {
  let set = dropListeners.get(tabId);
  if (!set) dropListeners.set(tabId, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}

/** 종료 직전·테스트용: 모아 둔 저장을 지금 쓴다. */
export function flushComposerDrafts(): void {
  for (const [tabId, t] of [...timers]) {
    clearTimeout(t);
    timers.delete(tabId);
    writeNow(tabId, cache.get(tabId) ?? "");
  }
}

function writeNow(tabId: string, text: string) {
  kvSet(KEY_PREFIX + tabId, !text.trim() || text.length > MAX_CHARS ? null : text);
}

// ===== 밖에서 입력창에 이어 붙이기(에디터 선택·터미널 출력 첨부) =====
type AppendListener = (text: string, images?: ChatImageDto[]) => void;
const appendListeners = new Map<string, Set<AppendListener>>();

/** 마운트된 Composer 가 붙어 있으면 그쪽이 텍스트를 잇고(커서·포커스까지), 없으면 초안에만 잇는다. */
export function appendComposerDraft(tabId: string, block: string, images?: ChatImageDto[]): void {
  const ls = appendListeners.get(tabId);
  if (ls && ls.size > 0) {
    for (const l of ls) l(block, images);
    return;
  }
  // 마운트된 입력창이 없으면 이미지는 붙일 곳이 없다(초안은 텍스트만) — 텍스트만 남긴다
  const cur = loadComposerDraft(tabId);
  const head = cur.replace(/\s+$/, "");
  saveComposerDraft(tabId, (head ? head + "\n\n" : "") + block + "\n");
}

export function onComposerDraftAppend(tabId: string, listener: AppendListener): () => void {
  let ls = appendListeners.get(tabId);
  if (!ls) appendListeners.set(tabId, (ls = new Set()));
  ls.add(listener);
  return () => {
    ls!.delete(listener);
  };
}
