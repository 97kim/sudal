// 화면 테마 적용. 설정(main 의 settings.json)의 theme 를 받아 <html data-theme="light|dark"> 를 붙이면
// styles.css 의 토큰이 바뀌고, Tailwind 유틸리티는 전부 그 토큰을 쓰므로 화면 전체가 따라온다.
// 토큰으로 못 바꾸는 것(highlight.js 스타일시트, xterm·CodeMirror 의 JS 테마)은 "sudal:theme" 이벤트로 알린다.
import type { ThemeMode } from "@shared/theme";
import { resolveTheme } from "@shared/theme";
import hljsLight from "highlight.js/styles/github.css?inline";
import hljsDark from "highlight.js/styles/github-dark.css?inline";

export type Resolved = "light" | "dark";

let mode: ThemeMode = "system";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function themeMode(): ThemeMode {
  return mode;
}
export function currentTheme(): Resolved {
  return resolveTheme(mode, media.matches);
}

function paint(force = false) {
  const t = currentTheme();
  const root = document.documentElement;
  if (!force && root.dataset.theme === t) return;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  let style = document.getElementById("hljs-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "hljs-theme";
    document.head.appendChild(style);
  }
  style.textContent = t === "dark" ? hljsDark : hljsLight;
  window.dispatchEvent(new CustomEvent<Resolved>("sudal:theme", { detail: t }));
}

/** 설정값을 받아 칠한다. 시작 때(첫 렌더 전)와 설정 화면에서 바꿀 때 부른다. */
export function applyThemeMode(next: ThemeMode): void {
  mode = next;
  paint(true);
}

media.addEventListener("change", () => {
  if (mode === "system") paint();
});

/** 실제 테마가 바뀔 때 알림(xterm·CodeMirror 처럼 JS 로 색을 정하는 곳). 해제 함수를 돌려준다. */
export function onThemeChange(fn: (t: Resolved) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Resolved>).detail);
  window.addEventListener("sudal:theme", h);
  return () => window.removeEventListener("sudal:theme", h);
}
