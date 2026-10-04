// 에디터 패널의 파일 하나: 읽기 → CodeMirror 편집 → ⌘S 저장. HEAD 대비 변경 줄 표시, 저장 충돌 배너.
// (예전 오버레이 FileViewer 의 본문을 패널용으로 옮긴 것. 헤더는 패널의 탭 스트립이 맡는다.)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileViewDto } from "@shared/ipc";
import { formatCodeAttachment } from "@shared/attachments";
import { CodeEditor } from "./CodeEditor";
import { buildDiff } from "./FileViewer";
import { Icon } from "./Icon";
import { fileUri, getLspClient, lspTarget, onLspClientLost } from "../lsp-client";
import { getEditorDraft, setEditorDraft } from "../editor-tabs";
import { Markdown } from "./Markdown";
import type { LSPClient } from "@codemirror/lsp-client";

export interface FileEditorApi {
  save(): Promise<boolean>;
}

export function FileEditor({
  cwd,
  path,
  visible,
  reveal = null,
  onDirtyChange,
  onRegister,
  onOpenBrowser,
  onAttach,
}: {
  cwd: string;
  path: string;
  /** 숨은 탭도 마운트를 유지해(undo·스크롤 보존) visible 로만 표시를 끈다. */
  visible: boolean;
  /** HTML 파일의 "브라우저에서 보기": 미리보기 URL 을 인앱 브라우저 탭으로 연다. */
  onOpenBrowser?: (url: string) => void;
  /** "채팅에 첨부": 선택 영역을 경로:줄 머리말과 코드 펜스로 입력창에 잇는다. */
  onAttach?: (block: string) => void;
  /** 열기 요청의 줄 범위. nonce 가 바뀔 때마다 그 줄을 선택하고 가운데로 스크롤한다. */
  reveal?: { line: number; endLine?: number; nonce: number } | null;
  onDirtyChange: (dirty: boolean) => void;
  /** 패널이 "저장 후 닫기" 에 쓸 수 있게 저장 함수를 등록한다. 언마운트 시 null. */
  onRegister: (api: FileEditorApi | null) => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<FileViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  /** 지금 에디터에 있는 본문. 저장이 끝났을 때 "그 사이 더 쳤는지" 를 이걸로 본다(state 는 저장 시작 때 값에 묶여 있다). */
  const textRef = useRef("");
  /** 에디터에 처음 넣는 본문: 디스크 내용, 또는 내려갔다 올라온 경우 그때의 미저장 본문. */
  const [initialDoc, setInitialDoc] = useState("");
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: true } | { ok: false; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // 마크다운은 미리보기로 열고, "편집" 으로 전환한다. 에디터는 숨겨 둘 뿐 내리지 않아 전환해도 커서·undo 가 남는다.
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path);
  const [mdView, setMdView] = useState<"preview" | "edit">("preview");
  // HTML(·SVG)은 인앱 브라우저 탭에서 렌더해 본다. 저장하면 열려 있는 미리보기 탭이 새로고침된다.
  const isHtml = /\.(html?|xhtml|svg)$/i.test(path);
  const [attachNonce, setAttachNonce] = useState(0);
  const [attachMsg, setAttachMsg] = useState<string | null>(null);
  const onAttachSel = (sel: { text: string; line: number; endLine: number }) => {
    if (!onAttach) return;
    onAttach(formatCodeAttachment({ relPath: file?.relPath ?? path, line: sel.line, endLine: sel.endLine, text: sel.text }));
    setAttachMsg(sel.endLine !== sel.line ? t("panel.editor.attachedLines", { from: sel.line, to: sel.endLine }) : t("panel.editor.attachedLine", { line: sel.line }));
    setTimeout(() => setAttachMsg(null), 1500);
  };
  const previewUrl = useRef<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const openInBrowser = useCallback(async () => {
    const r = await window.workbench.browser.previewUrl(cwd, path);
    if (!r.ok) {
      setPreviewError(r.error);
      setTimeout(() => setPreviewError(null), 4000);
      return;
    }
    previewUrl.current = r.url;
    onOpenBrowser?.(r.url);
    // 이미 열려 있던 탭이면 다시 불러온다(탭 키는 URL 이라 두 번 열리지 않는다)
    window.dispatchEvent(new CustomEvent("sudal:browser-reload", { detail: r.url }));
  }, [cwd, path, onOpenBrowser]);
  // 줄 이동 요청이 오면 편집 화면으로 (미리보기에는 줄이 없다)
  useEffect(() => {
    if (reveal) setMdView("edit");
  }, [reveal?.nonce]);
  // 담당 언어 서버가 있는 파일(TS/JS·Python)이면 탭 cwd 의 그 서버에 붙인다(루트는 main 이 정한다). 없으면 null 로 두고 문법 하이라이트만.
  // 서버가 죽으면 클라이언트를 놓는다 — 놓지 않으면 요청이 영원히 대기하고 배지만 켜져 있다.
  const [lspClient, setLspClient] = useState<LSPClient | null>(null);
  const target = lspTarget(path);
  const languageId = target?.languageId ?? null;
  const serverId = target?.serverId ?? null;
  useEffect(() => {
    if (!languageId || !serverId) return;
    let alive = true;
    getLspClient(cwd, serverId).then((c) => alive && setLspClient(c));
    const off = onLspClientLost((lost) => setLspClient((cur) => (cur === lost ? null : cur)));
    return () => {
      alive = false;
      off();
    };
  }, [cwd, languageId, serverId]);
  const lsp = useMemo(
    () => (lspClient && languageId && file ? { client: lspClient, uri: fileUri(file.path), languageId } : null),
    [lspClient, languageId, file?.path],
  );

  // 부모가 인라인 함수를 넘겨도 effect 가 다시 돌지 않게 콜백은 ref 로 든다.
  // (그렇지 않으면 타이핑 → dirty → 부모 리렌더 → 새 콜백 → 파일 다시 읽기 → 에디터 재생성으로 입력이 사라진다.)
  const cbs = useRef({ onDirtyChange, onRegister });
  cbs.current = { onDirtyChange, onRegister };
  const setDirty = useCallback((d: boolean) => {
    setDirtyState(d);
    cbs.current.onDirtyChange(d);
  }, []);

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    setConflict(false);
    window.workbench.files
      .read(cwd, path)
      .then((f) => {
        if (!alive) return;
        setFile(f);
        const disk = f.content ?? f.headContent ?? "";
        // 패널을 접거나 다른 탭·화면에 갔다 와서 다시 마운트된 것이면 미저장 본문을 되살린다.
        const draft = getEditorDraft(path);
        if (draft && draft.text !== disk) {
          setInitialDoc(draft.text);
          setText(draft.text);
          textRef.current = draft.text;
          setDirty(true);
          // 편집을 시작한 뒤 디스크가 바뀌었으면(에이전트가 고쳤을 수 있다) 충돌 배너로 알린다 — 저장 때가 아니라 지금.
          // 저장의 충돌 검사는 편집의 바탕 버전(draft 의 mtime·크기)을 기준으로 해야 ⌘S 가 외부 변경을 조용히 덮어쓰지 않는다.
          if (draft.mtimeMs !== f.mtimeMs || draft.size !== f.size) {
            setConflict(true);
            setFile({ ...f, mtimeMs: draft.mtimeMs, size: draft.size ?? f.size });
          }
        } else {
          setEditorDraft(path, null);
          setInitialDoc(disk);
          setText(disk);
          textRef.current = disk;
          setDirty(false);
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [cwd, path, reloadKey, setDirty]);

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      if (!file || saving) return false;
      setSaving(true);
      setSaveMsg(null);
      const saved = text; // 저장하는 본문. 응답이 올 때까지 더 칠 수 있다.
      const r = await window.workbench.files.write(cwd, file.path, saved, {
        expectedMtimeMs: file.mtimeMs,
        expectedSize: file.missing ? null : file.size,
        force,
      });
      setSaving(false);
      if (r.ok) {
        const size = new TextEncoder().encode(saved).length;
        setConflict(false);
        setSaveMsg({ ok: true });
        setTimeout(() => setSaveMsg(null), 1500);
        // 에디터는 그대로 두고(커서·undo 유지) 메타만 갱신: mtime·크기·저장한 내용. HEAD 는 저장으로 바뀌지 않는다.
        setFile((f) => (f ? { ...f, content: saved, mtimeMs: r.mtimeMs, size, missing: false } : f));
        // 저장 중에 본문이 바뀌었으면(더 쳤거나, 실행 취소로 원래대로 돌아갔거나) 그건 디스크와 다른 미저장 상태다.
        // 실행 취소로 원본과 같아진 경우 onChange 는 dirty 를 껐으므로 여기서 다시 켜야 한다 — 안 켜면 닫을 때 확인 없이 사라진다.
        const latest = textRef.current;
        const stillDirty = latest !== saved;
        setDirty(stillDirty);
        setEditorDraft(path, stillDirty ? { text: latest, mtimeMs: r.mtimeMs, size } : null);
        // 브라우저 탭으로 보고 있던 HTML 이면 저장한 내용을 바로 보여 준다
        if (previewUrl.current) window.dispatchEvent(new CustomEvent("sudal:browser-reload", { detail: previewUrl.current }));
        return true;
      }
      if (r.conflict) setConflict(true);
      else setSaveMsg({ ok: false, text: r.error });
      return false;
    },
    [cwd, path, file, text, saving, setDirty],
  );

  useEffect(() => {
    cbs.current.onRegister({ save: () => save() });
    return () => cbs.current.onRegister(null);
  }, [save]);

  const diff = useMemo(
    () => (file && file.headContent !== null ? buildDiff(file.headContent, text) : null),
    [file, text],
  );
  const hasDiff = diff !== null && (diff.added > 0 || diff.deleted > 0);
  const editable = !!file && !file.binary && !file.tooLarge && (file.content !== null || file.headContent !== null);
  /** 디스크(없으면 HEAD)의 본문. dirty 는 이것과 비교한다. 저장하면 file.content 가 갱신되어 같이 바뀐다. */
  const diskText = file ? (file.content ?? file.headContent ?? "") : "";
  const status = !file || file.image
    ? null
    : file.missing && file.headContent !== null
      ? { kind: "deleted" as const, cls: "bg-err-bg text-err" }
      : file.headContent === null && !file.missing
        ? { kind: "added" as const, cls: "bg-ok-bg text-ok" }
        : hasDiff
          ? { kind: "modified" as const, cls: "bg-warn-bg text-warn" }
          : null;

  return (
    <div className={`flex h-full min-h-0 flex-col ${visible ? "" : "hidden"}`} data-file-editor={path} data-dirty={dirty ? "true" : undefined}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px]">
        <span className="mono min-w-0 flex-1 truncate text-muted" title={file?.path ?? path}>
          {file?.relPath ?? path}
        </span>
        {status && <span className={`label rounded px-1.5 py-0.5 ${status.cls}`}>{t(`panel.editor.status.${status.kind}`)}</span>}
        {hasDiff && (
          <span className="mono text-[10.5px]">
            <span className="text-ok">+{diff!.added}</span> <span className="text-err">−{diff!.deleted}</span>
          </span>
        )}
        {isMarkdown && editable && (
          <span className="flex overflow-hidden rounded-md border border-line text-[10.5px]" data-md-toggle>
            {(["preview", "edit"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setMdView(v)}
                className={`px-2 py-0.5 ${mdView === v ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
                data-md-view={v}
                aria-pressed={mdView === v}
              >
                {v === "preview" ? t("panel.editor.preview") : t("common.edit")}
              </button>
            ))}
          </span>
        )}
        {editable && onAttach && (
          <button
            onClick={() => setAttachNonce((n) => n + 1)}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
            title={t("panel.editor.attachTitle")}
            data-attach-selection
          >
            <Icon name="chat" size={11} />
            {t("panel.editor.attach")}
          </button>
        )}
        {attachMsg && (
          <span className="mono text-[10.5px] text-ok" data-attach-msg>
            {attachMsg}
          </span>
        )}
        {isHtml && (
          <button
            onClick={() => void openInBrowser()}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
            title={t("panel.editor.openInBrowserTitle")}
            data-open-in-browser
          >
            <Icon name="globe" size={11} />
            {t("panel.editor.openInBrowser")}
          </button>
        )}
        {previewError && (
          <span className="mono text-[10.5px] text-err" data-preview-error>
            {previewError}
          </span>
        )}
        {lsp && (
          <span className="label rounded bg-accent-tint px-1.5 py-0.5 text-accent" title={t("panel.editor.lspTitle")} data-lsp-badge>
            LSP
          </span>
        )}
        {saveMsg && (
          <span className={`mono text-[10.5px] ${saveMsg.ok ? "text-ok" : "text-err"}`} data-save-msg>
            {saveMsg.ok ? t("panel.editor.saved") : saveMsg.text}
          </span>
        )}
        <button
          onClick={() => void save()}
          disabled={!editable || !dirty || saving}
          className="flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
          title={t("panel.editor.saveTitle")}
          data-save-button
        >
          <Icon name="check" size={11} />
          {saving ? t("panel.editor.saving") : t("common.save")}
        </button>
      </div>
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-err/40 bg-err-bg px-3 py-1.5 text-[11.5px] text-err" data-conflict>
          <Icon name="alert" size={12} />
          <span className="min-w-0 basis-[calc(100%-24px)]">{t("panel.editor.conflict")}</span>
          <button onClick={() => void save(true)} className="shrink-0 rounded border border-err/40 px-2 py-0.5 hover:bg-err/10" data-conflict-overwrite>
            {t("panel.editor.overwrite")}
          </button>
          <button
            onClick={() => {
              setConflict(false);
              setEditorDraft(path, null); // "디스크 내용으로" 는 내 편집을 버리는 것 — 되살리지 않는다
              setReloadKey((k) => k + 1);
            }}
            className="shrink-0 rounded border border-err/40 px-2 py-0.5 hover:bg-err/10"
            data-conflict-reload
          >
            {dirty ? t("panel.editor.discardAndReload") : t("panel.editor.reloadChanged")}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden bg-inset">
        {error && <Empty>{t("panel.editor.readFailed", { error })}</Empty>}
        {!error && !file && <Empty>{t("common.loading")}</Empty>}
        {file && file.missing && file.headContent === null && <Empty>{t("panel.editor.noFile")}</Empty>}
        {file && file.image && <ImagePreview src={file.image.dataUrl} mime={file.image.mime} size={file.size} />}
        {file && file.binary && !file.image && !file.tooLarge && <Empty>{t("panel.editor.binary")}</Empty>}
        {file && file.tooLarge && <Empty>{file.binary ? t("panel.editor.imageTooLarge") : t("panel.editor.tooLarge")}</Empty>}
        {file && editable && (
          <div className="flex h-full flex-col">
            {file.missing && (
              <div className="border-b border-line px-3 py-1.5 text-[11px] text-muted">
                {t("panel.editor.deletedFile")}
              </div>
            )}
            {isMarkdown && mdView === "preview" && (
              <div className="min-h-0 flex-1 overflow-auto px-8 py-6" style={{ userSelect: "text" }} data-md-preview>
                <Markdown text={text} variant="doc" />
              </div>
            )}
            <div className={`min-h-0 flex-1 ${isMarkdown && mdView === "preview" ? "hidden" : ""}`}>
              <CodeEditor
                key={file.path}
                path={file.path}
                doc={initialDoc}
                docVersion={reloadKey}
                original={file.headContent}
                lsp={lsp}
                reveal={reveal}
                attachRequest={attachNonce}
                onAttach={onAttachSel}
                onChange={(t) => {
                  setText(t);
                  textRef.current = t;
                  const d = t !== diskText;
                  setDirty(d);
                  // 컴포넌트가 내려가도 본문이 남게 모듈에 둔다(저장·버리기 때 지운다)
                  setEditorDraft(path, d ? { text: t, mtimeMs: file.mtimeMs, size: file.missing ? null : file.size } : null);
                }}
                onSave={() => void save()}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 이미지 파일: 체크무늬 위에 맞춤/원본 크기로 보여 준다. 편집은 없다. */
function ImagePreview({ src, mime, size }: { src: string; mime: string; size: number }) {
  const { t } = useTranslation();
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(true);
  const kb = size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(2)} MB`;
  return (
    <div className="flex h-full min-h-0 flex-col" data-image-preview>
      <div className="mono flex items-center gap-3 border-b border-line px-3 py-1 text-[10.5px] text-muted">
        <span>{mime}</span>
        {dims && (
          <span data-image-dims>
            {dims.w} × {dims.h}
          </span>
        )}
        <span>{kb}</span>
        <button onClick={() => setFit((f) => !f)} className="ml-auto rounded border border-line px-1.5 py-0.5 hover:bg-panel-2 hover:text-fg" data-image-fit>
          {fit ? t("panel.editor.actualSize") : t("panel.editor.fitToScreen")}
        </button>
      </div>
      <div
        className={`min-h-0 flex-1 overflow-auto ${fit ? "flex items-center justify-center" : ""}`}
        style={{
          backgroundImage:
            "linear-gradient(45deg, var(--color-line) 25%, transparent 25%), linear-gradient(-45deg, var(--color-line) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-line) 75%), linear-gradient(-45deg, transparent 75%, var(--color-line) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className={fit ? "max-h-full max-w-full object-contain p-4" : "block p-4"}
          style={fit ? undefined : { maxWidth: "none" }}
        />
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-muted">{children}</div>;
}
