// 링크를 어디서 여는가 — 인앱 브라우저 / 기본 브라우저 / 클릭할 때마다 고르기. 답변 속 링크와 터미널 속 URL 이 같은 규칙을 탄다.

/** 링크 열기 방식. "ask" 면 클릭할 때마다 고른다. localStorage 에 기억. */
export type LinkOpenMode = "ask" | "app" | "external";
const LINK_MODE_KEY = "sudal.linkOpenMode";

export function getLinkOpenMode(): LinkOpenMode {
  try {
    const v = localStorage.getItem(LINK_MODE_KEY);
    return v === "app" || v === "external" ? v : "ask";
  } catch {
    return "ask";
  }
}

export function setLinkOpenMode(mode: LinkOpenMode): void {
  try {
    if (mode === "ask") localStorage.removeItem(LINK_MODE_KEY);
    else localStorage.setItem(LINK_MODE_KEY, mode);
  } catch {
    /* 저장 못 해도 동작엔 지장 없음 */
  }
}

export interface ClickMods {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  button: number;
}

/**
 * 클릭 한 번이 향하는 곳. http(s) 가 아니면(mailto 등) 외부로만. ⌘/Ctrl·가운데 클릭=기본 브라우저, ⌥=인앱, ⇧=기억을 무시하고 다시 묻기,
 * 그 외는 기억한 방식(없으면 묻기).
 */
export function linkTargetFor(href: string, e: ClickMods, mode: LinkOpenMode = getLinkOpenMode()): "app" | "external" | "ask" {
  if (!/^https?:\/\//i.test(href) || e.metaKey || e.ctrlKey || e.button === 1) return "external";
  if (e.altKey) return "app";
  return e.shiftKey ? "ask" : mode;
}
