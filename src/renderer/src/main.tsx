import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App } from "./App";
import { flushEditorTabsStorage } from "./editor-tabs";
import { flushComposerDrafts } from "./composer-draft";
import { hydrateKv } from "./kv-store";
import { applyThemeMode } from "./theme";
import { applyLocale, initI18n } from "./i18n";

// 종료 직전: 모아 두었던 초안 저장을 지금 쓴다(마지막 300ms 안의 입력·버린 초안이 유실·재등장하지 않게).
window.addEventListener("beforeunload", () => {
  flushEditorTabsStorage();
  flushComposerDrafts();
});

// 처리되지 않은 renderer 오류를 main 로그 파일로. React 19 는 렌더 중 예외도 window error 로 보고한다.
window.addEventListener("error", (e) => {
  window.sudal?.app.reportError({
    kind: "error",
    message: e.message || String(e.error),
    stack: e.error instanceof Error ? e.error.stack : undefined,
    source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
  });
});
window.addEventListener("unhandledrejection", (e) => {
  const reason: unknown = e.reason;
  window.sudal?.app.reportError({
    kind: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

/**
 * 옛 이름(AI Workbench)으로 저장한 화면 설정 키를 sudal.* 로 한 번 옮긴다. 새 키가 이미 있으면 그쪽이 이긴다.
 * 0.11.2 까지의 설치본만 해당한다 — 충분히 지나면 지워도 된다.
 */
function migrateLegacyStorageKeys() {
  try {
    for (const name of ["linkOpenMode", "fileTree.showHidden", "sidebar.collapsed", "rightPanel", "editorPane.width"]) {
      const old = localStorage.getItem(`workbench.${name}`);
      if (old === null) continue;
      if (localStorage.getItem(`sudal.${name}`) === null) localStorage.setItem(`sudal.${name}`, old);
      localStorage.removeItem(`workbench.${name}`);
    }
  } catch {
    /* 없거나 막힘 */
  }
}

// 렌더러 상태(열린 파일·초안)는 main 의 파일에서 받아 온 뒤에 그린다 — 첫 화면부터 복원된 상태로.
// 테마도 첫 렌더 전에 칠한다(밝은 화면이 번쩍이지 않게).
async function start() {
  let entries: Record<string, string> = {};
  const [stateResult, settingsResult] = await Promise.allSettled([window.sudal.state.load(), window.sudal.app.getSettings()]);
  if (stateResult.status === "fulfilled") entries = stateResult.value;
  else console.error("[state] load 실패:", stateResult.reason);
  applyThemeMode(settingsResult.status === "fulfilled" ? settingsResult.value.theme : "system");
  // 번역도 첫 렌더 전에 준비한다. 설정을 못 읽으면 한국어로(지금까지의 동작).
  initI18n(settingsResult.status === "fulfilled" ? settingsResult.value.resolvedLocale : "ko");
  window.sudal.app.onSettingsChanged((s) => applyLocale(s.resolvedLocale));
  hydrateKv(entries, (key, value) => window.sudal.state.set(key, value));
  migrateLegacyStorageKeys();
  // 운영체제별 여백(macOS 신호등 자리)은 CSS 의 mac: 변형이 이 클래스를 본다
  document.documentElement.classList.add(`platform-${window.sudal.platform}`);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void start();
