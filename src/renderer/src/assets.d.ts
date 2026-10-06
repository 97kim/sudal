// Vite 가 처리하는 정적 에셋 import 타입.
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}

/** Electron <webview> 태그. 렌더러 타입에는 electron 이 없어 쓰는 만큼만 선언한다. */
interface SudalWebview extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /** 캐시를 무시하고 다시 받는다 — 고친 게 안 보일 때. */
  reloadIgnoringCache(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ toDataURL(): string; isEmpty(): boolean }>;
  getWebContentsId(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  setZoomLevel(level: number): void;
  getZoomLevel(): number;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
}
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<SudalWebview>, SudalWebview> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}

// Vite 의 ?inline 스타일시트 import(theme.ts 가 highlight.js 테마를 문자열로 받아 갈아 끼운다)
declare module "*.css?inline" {
  const css: string;
  export default css;
}
