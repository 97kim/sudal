// 채팅 옆 에디터 패널: 파일 탭 스트립 + 파일마다 FileEditor(숨김 유지). 닫을 때 저장 안 된 변경은 확인을 받는다.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  activateEditorFile,
  closeEditorFile,
  setEditorFileDirty,
  setEditorPaneVisible,
  type EditorTabsState,
} from "../editor-tabs";
import { FileEditor, type FileEditorApi } from "./FileEditor";
import { BrowserPane } from "./BrowserPane";
import type { ChatImageDto } from "@shared/ipc";
import { Icon } from "./Icon";
import { basenameAny } from "@shared/any-path";
import { browserTabLabel, getBrowserUrl, isBrowserTab, openBrowserTab, setBrowserUrl, setEditorMaximized } from "../editor-tabs";

export function EditorPane({
  tabId,
  cwd,
  tabs,
  onAttach,
}: {
  tabId: string;
  cwd: string;
  tabs: EditorTabsState;
  /** 에디터의 "채팅에 첨부" → 입력창 */
  onAttach?: (block: string, images?: ChatImageDto[]) => void;
}) {
  const { t } = useTranslation();
  // dirty 는 editor-tabs 모듈에 둔다 — 파일 트리(이름 변경·삭제)와 탭 상한 정리가 같이 봐야 한다.
  const dirty = new Set(tabs.dirty);
  const apis = useRef(new Map<string, FileEditorApi>());
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  // 브라우저 탭은 키가 고정이라(초기 URL 또는 browser:<n>) 현재 페이지의 호스트·제목을 따로 들고 라벨로 쓴다
  const [browserLabels, setBrowserLabels] = useState<Record<string, string>>({});
  // 탭별 파비콘(data URL). 없으면 지구본으로 그린다 — 아직 안 왔거나, 그 사이트가 안 주거나, 못 받은 경우.
  const [browserIcons, setBrowserIcons] = useState<Record<string, string>>({});

  const markDirty = useCallback((path: string, d: boolean) => setEditorFileDirty(tabId, path, d), [tabId]);
  const register = useCallback((path: string, api: FileEditorApi | null) => {
    if (api) apis.current.set(path, api);
    else apis.current.delete(path);
  }, []);

  const requestClose = (path: string) => {
    if (dirty.has(path)) setConfirmClose(path);
    else doClose(path);
  };
  const doClose = (path: string) => {
    setConfirmClose(null);
    markDirty(path, false);
    closeEditorFile(tabId, path);
  };

  // ⌘W 가 이 패널을 겨냥했을 때 — 버튼의 × 와 같은 경로를 탄다(미저장이면 확인 배너).
  // App 에서 직접 closeEditorFile 을 부르면 그 확인을 건너뛰므로 이벤트로 넘겨받는다.
  const activeFile = tabs.active;
  useEffect(() => {
    const onClose = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== tabId || !activeFile) return;
      requestClose(activeFile);
    };
    window.addEventListener("sudal:editor-close-active", onClose);
    return () => window.removeEventListener("sudal:editor-close-active", onClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, activeFile, tabs.dirty.join("\u0000")]);

  const name = (p: string) => (isBrowserTab(p) ? (browserLabels[p] ?? browserTabLabel(p, t)) : basenameAny(p));
  // 같은 이름의 파일이 둘이면 상위 폴더를 붙여 구분한다
  const label = (p: string) => {
    if (isBrowserTab(p)) return browserLabels[p] ?? browserTabLabel(p, t);
    const n = name(p);
    return tabs.files.filter((f) => name(f) === n).length > 1 ? p.split(/[\\/]/).slice(-2).join("/") : n;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-editor-pane>
      <div className="flex h-9 shrink-0 items-stretch border-b border-line" data-editor-tabs>
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.files.map((f) => {
            const active = f === tabs.active;
            return (
              <div
                key={f}
                onClick={() => activateEditorFile(tabId, f)}
                onAuxClick={(e) => {
                  if (e.button === 1) requestClose(f); // 휠 클릭으로 닫기
                }}
                className={`group flex max-w-[220px] shrink-0 cursor-default items-center gap-1.5 border-r border-line px-3 text-[12px] ${
                  active ? "bg-inset text-fg" : "text-muted hover:bg-panel-2 hover:text-fg"
                }`}
                title={f}
                data-editor-tab={f}
                data-active={active ? "true" : undefined}
              >
                {isBrowserTab(f) && browserIcons[f] ? (
                  // 파비콘은 main 이 data URL 로 바꿔 준 것만 온다(CSP 가 원격 이미지를 막는다).
                  // 깨진 이미지면 지구본으로 돌아간다.
                  <img
                    src={browserIcons[f]}
                    alt=""
                    className="h-[11px] w-[11px] shrink-0 rounded-[2px]"
                    onError={() => setBrowserIcons((m) => { const { [f]: _drop, ...rest } = m; return rest; })}
                    data-tab-favicon
                  />
                ) : (
                  <Icon name={isBrowserTab(f) ? "globe" : "file"} size={11} className="shrink-0 opacity-70" />
                )}
                <span className="truncate">{label(f)}</span>
                {dirty.has(f) ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(f);
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-panel-2"
                    title={t("panel.editorPane.closeDirty")}
                    data-editor-tab-close
                  >
                    <span className="h-2 w-2 rounded-full bg-accent group-hover:hidden" />
                    <Icon name="x" size={10} className="hidden group-hover:block" />
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(f);
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-panel-2 group-hover:opacity-100"
                    title={t("common.close")}
                    data-editor-tab-close
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {/* 브라우저만 이 버튼으로 바로 열린다 — 파일은 어차피 무엇을 열지 고르는 단계가 필요해서
            파일 트리·툴카드 경로 쪽이 맞다. 그래서 + 대신 지구본으로, 무엇이 열릴지 보이게 한다. */}
        <button
          onClick={() => openBrowserTab(tabId)}
          className="flex shrink-0 items-center border-l border-line px-2 text-muted hover:text-fg"
          title={t("panel.editorPane.newBrowser")}
          data-editor-new-browser
        >
          <Icon name="globe" size={13} />
        </button>
        <button
          onClick={() => setEditorMaximized(tabId, !tabs.maximized)}
          className={`flex shrink-0 items-center px-2 ${tabs.maximized ? "text-accent" : "text-muted hover:text-fg"}`}
          title={tabs.maximized ? t("panel.editorPane.restore") : t("panel.editorPane.maximize")}
          data-editor-maximize={tabs.maximized ? "on" : "off"}
        >
          <Icon name={tabs.maximized ? "minimize" : "maximize"} size={13} />
        </button>
        <button
          onClick={() => setEditorPaneVisible(tabId, false)}
          className="flex shrink-0 items-center px-2 text-muted hover:text-fg"
          title={t("panel.editorPane.hide")}
          data-editor-pane-hide
        >
          <Icon name="panelRight" size={13} />
        </button>
      </div>

      {confirmClose && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn-bg px-3 py-1.5 text-[11.5px] text-warn" data-editor-close-confirm>
          <Icon name="alert" size={12} />
          <span className="min-w-0 flex-1 truncate">{t("panel.editorPane.unsaved", { name: name(confirmClose) })}</span>
          <button
            onClick={() =>
              void apis.current.get(confirmClose)?.save().then((ok) => {
                if (ok) doClose(confirmClose);
                else {
                  // 충돌·오류 배너는 그 파일의 에디터 안에 있다 — 숨은 탭이면 보이게 활성화한다
                  setConfirmClose(null);
                  activateEditorFile(tabId, confirmClose);
                }
              })
            }
            className="rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10"
          >
            {t("panel.editorPane.saveAndClose")}
          </button>
          <button onClick={() => doClose(confirmClose)} className="rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10" data-editor-close-discard>
            {t("panel.editorPane.discardAndClose")}
          </button>
          <button onClick={() => setConfirmClose(null)} className="rounded px-2 py-0.5 hover:bg-warn/10">
            {t("panel.editorPane.keepEditing")}
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tabs.files.map((f) =>
          isBrowserTab(f) ? (
            <div key={f} className={`h-full min-h-0 ${f === tabs.active ? "" : "hidden"}`}>
              <BrowserPane
                // 탭 키가 아니라 "마지막으로 보던 주소" 로 연다 — 패널을 접거나 채팅 탭을 옮겨도 재현 중이던 페이지가 남는다
                initialUrl={getBrowserUrl(f) ?? (f.startsWith("browser:") ? null : f)}
                visible={f === tabs.active}
                chatTabId={tabId}
                onLabel={(l) => setBrowserLabels((m) => (m[f] === l ? m : { ...m, [f]: l }))}
                onFavicon={(d) =>
                  setBrowserIcons((m) => {
                    if (!d) {
                      if (!(f in m)) return m;
                      const { [f]: _drop, ...rest } = m;
                      return rest;
                    }
                    return m[f] === d ? m : { ...m, [f]: d };
                  })
                }
                onAttach={onAttach}
                onUrlChange={(u) => setBrowserUrl(f, u)}
              />
            </div>
          ) : (
          <FileEditor
            key={f}
            cwd={cwd}
            path={f}
            visible={f === tabs.active}
            reveal={tabs.reveal?.path === f ? tabs.reveal : null}
            onDirtyChange={(d) => markDirty(f, d)}
            onRegister={(api) => register(f, api)}
            onOpenBrowser={(url) => openBrowserTab(tabId, url)}
            onAttach={onAttach}
          />
          ),
        )}
      </div>
    </div>
  );
}
