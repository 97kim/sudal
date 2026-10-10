import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { PermissionPolicy } from "@shared/chat-events";
import type { ChatImageDto } from "@shared/ipc";
import {
  filterCommands,
  parseSlashQuery,
  type SlashCommandDto,
} from "@shared/slash-commands";
import { withAppCommands } from "@shared/app-commands";
import {
  filterSnippets,
  snippetSummary,
  type SnippetDto,
} from "@shared/snippets";
import { Icon } from "./Icon";
import { clearComposerDraft, loadComposerDraft, loadComposerFiles, onComposerDraftAppend, onComposerFilesDrop, saveComposerDraft, saveComposerFiles, withAttachedFiles, type ComposerFile } from "../composer-draft";
import { appendToDraft } from "@shared/attachments";

/** "/" 팔레트 한 줄: 스니펫(본문을 입력창에 넣음) 또는 슬래시 커맨드(이름을 넣음). */
type PaletteRow =
  | { kind: "snippet"; key: string; snippet: SnippetDto }
  | { kind: "command"; key: string; command: SlashCommandDto };

const MAX_COMMAND_ROWS = 10;
const MAX_SNIPPET_ROWS = 5;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGES = 4;
const POLICY_TAG: Record<PermissionPolicy, string> = {
  ask: "ASK",
  auto_edit: "AUTO-EDIT",
  auto_review: "AUTO-REVIEW",
  full: "FULL",
};

interface Pending extends ChatImageDto {
  dataUrl: string;
}

export function Composer({
  disabled,
  running,
  runningHint,
  providerLabel,
  policy,
  commands,
  snippets = [],
  workspaceId = null,
  draftKey,
  onSaveSnippet,
  onSend,
  onAbort,
  onClear,
  disabledText,
}: {
  disabled: boolean;
  /** 쓰다 만 글을 보존할 키(채팅 탭 id). 없으면 보존하지 않는다. */
  draftKey?: string;
  /** disabled 일 때 보여 줄 안내. 기본은 작업 경로 안내. */
  disabledText?: string;
  running: boolean;
  /** 턴이 돌 때 입력창에 보일 안내(없으면 기본 문구). 하위 에이전트·외부 프로세스가 턴을 잡고 있을 때 상황을 알린다. */
  runningHint?: string;
  providerLabel: string;
  policy: PermissionPolicy;
  /** "/" 자동완성 목록. null 이면 이 provider 에선 지원하지 않음, [] 는 로딩 중. */
  commands: SlashCommandDto[] | null;
  /** 프롬프트 스니펫 전체. 팔레트에는 전체 범위 + 현재 워크스페이스 것만 보인다. */
  snippets?: SnippetDto[];
  workspaceId?: string | null;
  /** 현재 입력을 스니펫으로 저장. 없으면 저장 버튼을 숨긴다. */
  onSaveSnippet?: (input: {
    name: string;
    text: string;
    workspaceId: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSend: (text: string, images: ChatImageDto[]) => Promise<void>;
  onAbort: () => void;
  /** `/clear` 를 받았을 때. CLI 를 쓰던 손버릇이 이 앱에서도 통하게 한다. */
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  // 쓰다 만 글은 탭별로 보존한다(탭 전환·재시작 뒤 복원). 전송하면 비운다.
  const [text, setText] = useState(() => (draftKey ? loadComposerDraft(draftKey) : ""));
  useEffect(() => {
    if (draftKey) saveComposerDraft(draftKey, text);
  }, [draftKey, text]);
  const [images, setImages] = useState<Pending[]>([]);
  // 이미지가 아닌 첨부(파일·폴더) — 경로만 들고 있다가 보낼 때 글 끝에 목록으로 붙는다. 탭을 옮겨도 남는다.
  const [files, setFiles] = useState<ComposerFile[]>(() => (draftKey ? loadComposerFiles(draftKey) : []));
  const filesKey = useRef(draftKey);
  useEffect(() => {
    if (filesKey.current === draftKey) return;
    filesKey.current = draftKey;
    setFiles(draftKey ? loadComposerFiles(draftKey) : []);
  }, [draftKey]);
  useEffect(() => {
    if (draftKey && filesKey.current === draftKey) saveComposerFiles(draftKey, files);
  }, [draftKey, files]);
  const [error, setError] = useState<string | null>(null);
  // 문구는 값으로 두고 그릴 때 번역한다
  const [imageLimit, setImageLimit] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 에디터·터미널의 "채팅에 첨부": 지금 글 뒤에 이어 붙이고 커서를 끝으로
  useEffect(() => {
    if (!draftKey) return;
    return onComposerDraftAppend(draftKey, (block, imgs) => {
      setText((cur) => appendToDraft(cur, block));
      if (imgs && imgs.length > 0)
        setImages((prev) => {
          const all = [...prev, ...imgs.map((img) => ({ ...img, dataUrl: `data:${img.mime};base64,${img.base64}` }))];
          // 넘치는 건 버리되 말없이 버리지 않는다 — 붙여 넣기·끌어다 놓기와 같은 경고를 띄운다.
          if (all.length > MAX_IMAGES) setImageLimit(true);
          return all.slice(0, MAX_IMAGES);
        });
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
        el.scrollTop = el.scrollHeight;
      });
    });
  }, [draftKey]);

  // ===== "/" 팔레트: 스니펫 + 커맨드 =====
  // 커맨드가 없는 provider(Codex)라도 스니펫이 있으면 팔레트를 연다.
  const slashQuery =
    commands !== null || snippets.length > 0 ? parseSlashQuery(text) : null;
  const [dismissed, setDismissed] = useState(false); // Esc 로 닫은 뒤 텍스트가 바뀌기 전까지 유지
  const [selected, setSelected] = useState(0);
  const snippetRows: PaletteRow[] =
    slashQuery !== null
      ? filterSnippets(snippets, slashQuery, workspaceId).map((sn) => ({
          kind: "snippet",
          key: `s:${sn.id}`,
          snippet: sn,
        }))
      : [];
  // 앱이 직접 처리하는 커맨드(/model·/config·/mcp)는 CLI 목록과 합쳐 보여 준다. "로딩 중" 판정은 CLI 목록(commands) 기준.
  const commandRows: PaletteRow[] =
    slashQuery !== null && commands
      ? filterCommands(withAppCommands(t, commands), slashQuery).map((c) => ({
          kind: "command",
          key: `c:${c.name}`,
          command: c,
        }))
      : [];
  // 스니펫은 최대 5줄, 나머지는 커맨드 — 스니펫이 많아도 커맨드가 밀려나지 않게
  const snippetCap = commandRows.length > 0 ? MAX_SNIPPET_ROWS : MAX_COMMAND_ROWS;
  const matches = [
    ...snippetRows.slice(0, snippetCap),
    ...commandRows,
  ].slice(0, MAX_COMMAND_ROWS);
  const loadingCommands =
    slashQuery !== null &&
    commands !== null &&
    commands.length === 0 &&
    snippetRows.length === 0;
  const popoverOpen =
    slashQuery !== null &&
    !dismissed &&
    (matches.length > 0 || loadingCommands);

  // ===== 스니펫 저장 폼 (입력창 아래 한 줄) =====
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveGlobal, setSaveGlobal] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveSnippet = async () => {
    if (!onSaveSnippet) return;
    const r = await onSaveSnippet({
      name: saveName,
      text,
      workspaceId: saveGlobal ? null : workspaceId,
    });
    if (r.ok) {
      setSaveOpen(false);
      setSaveName("");
      setSaveError(null);
    } else setSaveError(r.error);
  };
  useEffect(() => {
    setSelected(0);
    setDismissed(false);
  }, [text]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pickRow = (row: PaletteRow) => {
    // 스니펫은 본문을 통째로 넣고, 커맨드는 이름만 넣어 인자를 이어 치게 한다.
    setText(row.kind === "snippet" ? row.snippet.text : `/${row.command.name} `);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  // 글 길이에 맞춰 높이를 키운다. 숨어 있을 때는 재지 않는다 — display:none 이면 scrollHeight 가 0 이라
  // 0px 로 굳어 버리고, 다시 보여도 글만 있고 상자는 한 줄인 상태가 된다(넓게 보기 중 "채팅에 첨부").
  const autosize = useCallback(() => {
    const el = ref.current;
    if (!el || el.offsetParent === null) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  useEffect(() => {
    autosize();
  }, [text, autosize]);

  // 숨어 있는 동안 붙은 글은 높이를 못 쟀다 — 다시 보이는 순간 한 번 잰다.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => autosize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [autosize]);

  // 턴 진행 중에도 보낼 수 있다: main 이 프롬프트 큐에 넣고 턴이 끝나면 자동 전송한다.
  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0 && files.length === 0) || disabled) return;
    setError(null);
    setImageLimit(false);
    // CLI 의 /clear 를 앱의 대화 비우기로 잇는다. 그냥 흘려보내면 CLI 는 제 맥락만 비우고,
    // 화면은 앱이 따로 쌓아 둔 기록으로 그려지므로 아무것도 달라지지 않는다.
    // 커맨드 목록에 clear 가 있다고 비켜서지 않는다 — SDK 가 주는 159개 안에 들어 있어서,
    // 그걸 보고 물러나면 이 가로채기가 영영 동작하지 않는다(처음 만들 때 그렇게 걸렸다).
    if (trimmed === "/clear" && images.length === 0 && files.length === 0 && onClear) {
      if (draftKey) clearComposerDraft(draftKey);
      setText("");
      onClear();
      return;
    }
    try {
      await onSend(
        withAttachedFiles(trimmed, files, t("chat.composer.attachedFiles")),
        images.map(({ name, mime, base64 }) => ({ name, mime, base64 })),
      );
      // 보내는 사이 다른 탭으로 갔으면 이 컴포넌트는 이미 내려가 setText 의 효과가 없다 — 초안은 모듈에서 직접 비운다.
      if (draftKey) {
        clearComposerDraft(draftKey);
        saveComposerFiles(draftKey, []);
      }
      setText("");
      setImages([]);
      setFiles([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [text, images, files, disabled, onSend, draftKey, onClear, t]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한국어 IME 조합 중 Enter 는 조합 확정이지 전송이 아니다.
    // (isComposing 이 false 로 오는 브라우저/시점이 있어 keyCode 229 도 같이 본다)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 커맨드 팝오버가 열려 있으면 화살표·Tab·Enter 는 목록 조작이다.
    if (popoverOpen && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickRow(matches[Math.min(selected, matches.length - 1)]);
        return;
      }
    }
    if (popoverOpen && e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      return;
    }
    // 중단 버튼이 "중단 (esc)" 라고 적어 두고 정작 esc 는 아무 데서도 처리하지 않았다.
    // 승인 창은 입력창이 포커스일 때 키를 무시하므로(PermissionPrompt) 여기서 겹치지 않는다.
    if (e.key === "Escape" && running) {
      e.preventDefault();
      onAbort();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const addFiles = (files: File[]) => {
    const imgs = files.filter((f) => IMAGE_MIMES.has(f.type));
    if (imgs.length === 0) return;
    if (images.length + imgs.length > MAX_IMAGES) {
      setImageLimit(true);
      return;
    }
    for (const file of imgs) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        setImages((prev) => [
          ...prev,
          {
            name: file.name || "clipboard",
            mime: file.type as ChatImageDto["mime"],
            base64,
            dataUrl,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.some((f) => IMAGE_MIMES.has(f.type))) {
      e.preventDefault();
      addFiles(files);
    }
  };

  // ===== 끌어다 놓기: 이미지는 첨부, 그 밖의 파일·폴더는 경로를 커서 자리에 넣는다 =====
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // 안쪽 요소로 옮겨 갈 때도 leave 가 온다. 영역 밖으로 나갈 때만 끈다.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
  };
  // 끌어다 놓은 것: 이미지는 이미지로 첨부하고, 그 밖의 파일·폴더는 파일 카드로 붙인다.
  // 채팅 화면 다른 곳에 놓은 것도 여기로 온다(ChatView → dropComposerFiles).
  const takeFiles = (list: File[]) => {
    addFiles(list);
    // 경로가 없는 것(웹 페이지에서 끈 이미지 등)은 위 addFiles 로만 다룬다.
    const picked = list
      .filter((f) => !IMAGE_MIMES.has(f.type))
      .map((f) => ({ path: window.sudal.files.pathFor(f), name: f.name }))
      .filter((f) => !!f.path);
    if (picked.length === 0) return;
    setFiles((cur) => [...cur, ...picked.filter((f) => !cur.some((c) => c.path === f.path))].slice(0, 20));
    requestAnimationFrame(() => ref.current?.focus());
  };
  const takeFilesRef = useRef(takeFiles);
  takeFilesRef.current = takeFiles;
  useEffect(() => (draftKey ? onComposerFilesDrop(draftKey, (list) => takeFilesRef.current(list)) : undefined), [draftKey]);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    // 채팅 화면 쪽 놓기 처리가 또 받지 않게.
    e.stopPropagation();
    takeFiles(Array.from(e.dataTransfer.files));
  };

  const canSend = !disabled && (text.trim().length > 0 || images.length > 0 || files.length > 0);

  return (
    // @container: 채팅 열이 좁아지면(에디터·오른쪽 패널을 함께 열었을 때) 툴바 글자를 숨기고 아이콘만 남겨 줄바꿈으로 깨지지 않게 한다.
    <div className="@container relative px-3 pb-4 pt-2 @[520px]:px-6" data-composer>
      {popoverOpen && (
        <div
          className="absolute bottom-full left-6 right-6 z-10 mb-1 overflow-hidden rounded-lg border border-line bg-panel shadow-pop"
          role="listbox"
        >
          {loadingCommands ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />
              {t("chat.composer.loadingCommands")}
            </div>
          ) : (
            <>
              <div
                ref={listRef}
                className="max-h-72 overflow-y-auto overflow-x-hidden py-1"
              >
                {matches.map((row, i) => (
                  <button
                    key={row.key}
                    role="option"
                    aria-selected={i === selected}
                    onMouseDown={(e) => e.preventDefault()} // textarea 포커스 유지
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => pickRow(row)}
                    className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left ${
                      i === selected
                        ? "bg-panel-2 text-fg"
                        : "text-fg hover:bg-panel-2/60"
                    }`}
                    data-palette-row={row.kind}
                  >
                    {row.kind === "snippet" ? (
                      <>
                        <span className="mono shrink-0 text-[12px]">
                          /{row.snippet.name}
                        </span>
                        <span className="label shrink-0 rounded bg-accent-tint px-1 py-px text-[9px] text-accent">
                          {row.snippet.workspaceId ? t("chat.composer.snippet") : t("chat.composer.snippetAll")}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                          {snippetSummary(row.snippet.text)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="mono shrink-0 text-[12px]">
                          /{row.command.name}
                        </span>
                        {row.command.argumentHint && (
                          <span
                            className="mono max-w-[38%] shrink-0 truncate text-[12px] text-muted-2"
                            title={row.command.argumentHint}
                          >
                            {row.command.argumentHint}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                          {row.command.description}
                        </span>
                        {row.command.aliases && row.command.aliases.length > 0 && (
                          <span className="mono shrink-0 text-[10px] text-muted-2">
                            {row.command.aliases.map((a) => `/${a}`).join(" ")}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                ))}
              </div>
              <div className="label flex gap-3 border-t border-line px-3 py-1.5 text-[9px]">
                <span>{t("chat.composer.keyMove")}</span>
                <span>{t("chat.composer.keySelect")}</span>
                <span>{t("chat.composer.keyClose")}</span>
              </div>
            </>
          )}
        </div>
      )}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`relative rounded-xl border bg-panel shadow-pop focus-within:border-accent/50 ${dropping ? "border-accent" : "border-line"}`}
      >
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-panel/95 text-[12px] text-accent">
            {t("chat.composer.dropHint")}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex gap-2 px-4 pt-3">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-14 w-14 rounded-md object-cover"
                />
                <button
                  onClick={() =>
                    setImages((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-line text-fg"
                >
                  <Icon name="x" size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-composer-files>
            {files.map((f) => (
              <div key={f.path} className="flex max-w-[260px] items-center gap-1.5 rounded-md border border-line bg-panel-2 py-1 pl-2 pr-1 text-[11.5px]" title={f.path} data-composer-file={f.name}>
                <Icon name={/\.[a-z0-9]{1,8}$/i.test(f.name) ? "file" : "folder"} size={12} className="shrink-0 text-muted" />
                <span className="min-w-0 truncate text-fg">{f.name}</span>
                <button onClick={() => setFiles((cur) => cur.filter((c) => c.path !== f.path))} className="shrink-0 rounded p-0.5 text-muted hover:text-fg" title={t("chat.composer.removeFile")}>
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          rows={1}
          placeholder={
            disabled
              ? (disabledText ?? t("chat.composer.placeholderNeedCwd"))
              : running
                ? (runningHint ?? t("chat.composer.placeholderQueue"))
                : t("chat.composer.placeholder")
          }
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[13.5px] leading-6 outline-none placeholder:text-muted disabled:opacity-50"
          style={{ userSelect: "text" }}
        />
        <div className="flex items-center gap-1 whitespace-nowrap px-3 pb-2.5 pt-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
            title={t("chat.composer.attachImage")}
          >
            <Icon name="paperclip" size={13} />
            <span className="hidden @[440px]:inline">{t("chat.composer.attach")}</span>
          </button>
          {onSaveSnippet && text.trim().length > 0 && slashQuery === null && (
            <button
              onClick={() => {
                setSaveOpen((o) => !o);
                setSaveError(null);
              }}
              disabled={disabled}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-panel-2 hover:text-fg disabled:opacity-40 ${
                saveOpen ? "text-fg" : "text-muted"
              }`}
              title={t("chat.composer.saveSnippetHint")}
              data-snippet-save
            >
              <Icon name="copy" size={13} />
              <span className="hidden @[440px]:inline">{t("chat.composer.saveSnippet")}</span>
            </button>
          )}
          <span className="label ml-auto hidden min-w-0 items-center gap-2 truncate text-accent @[380px]:flex" title={`${providerLabel} · ${POLICY_TAG[policy]}`}>
            <span className="truncate">{providerLabel.toUpperCase()}</span>
            <span className="text-muted">·</span>
            <span className="text-muted">{POLICY_TAG[policy]}</span>
          </span>
          <span className="ml-auto @[380px]:hidden" />
          {running ? (
            <>
              {canSend && (
                <button
                  onClick={() => void submit()}
                  className="ml-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-fg hover:bg-panel-2"
                  title={t("chat.composer.queueHint")}
                  data-queue-add
                >
                  <Icon name="clock" size={12} />
                  <span className="hidden @[440px]:inline">{t("chat.composer.queue")}</span>
                </button>
              )}
              <button
                onClick={onAbort}
                className="ml-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-err/50 px-3 text-err hover:bg-err/10"
                title={t("chat.composer.abortHint")}
              >
                <Icon name="x" size={12} />
                <span className="hidden @[440px]:inline">{t("chat.composer.abort")}</span>
              </button>
            </>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!canSend}
              className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-40"
              title={t("chat.composer.sendHint")}
            >
              <Icon name="arrowUp" size={15} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      {saveOpen && onSaveSnippet && (
        <div
          className="mt-1.5 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px]"
          data-snippet-form
        >
          <span className="mono text-muted">/</span>
          <input
            autoFocus
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void saveSnippet();
              if (e.key === "Escape") setSaveOpen(false);
            }}
            placeholder={t("chat.composer.snippetName")}
            className="mono min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
            style={{ userSelect: "text" }}
          />
          <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label={t("chat.composer.snippetScope")}>
            {[
              { v: false, label: t("chat.composer.scopeWorkspace") },
              { v: true, label: t("chat.composer.scopeGlobal") },
            ].map((o) => (
              <button
                key={String(o.v)}
                role="radio"
                aria-checked={saveGlobal === o.v}
                onClick={() => setSaveGlobal(o.v)}
                className={`rounded px-2 py-0.5 text-[11px] ${
                  saveGlobal === o.v ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {saveError && <span className="text-err">{saveError}</span>}
          <button
            onClick={() => void saveSnippet()}
            className="rounded bg-primary px-2 py-0.5 font-medium text-on-primary hover:bg-primary-hover"
          >
            {t("common.save")}
          </button>
          <button
            onClick={() => setSaveOpen(false)}
            className="rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg"
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      )}
      <div className="mono mt-1.5 flex justify-between gap-2 overflow-hidden whitespace-nowrap px-1 text-[10px] text-muted">
        <span className="min-w-0 truncate">
          {error ? (
            <span className="text-err">{error}</span>
          ) : imageLimit ? (
            <span className="text-err">{t("chat.composer.imageLimit", { count: MAX_IMAGES })}</span>
          ) : (
            <span className="hidden @[440px]:inline">{t("chat.composer.pasteImage")}</span>
          )}
        </span>
        <span className="hidden shrink-0 @[380px]:inline">{t("chat.composer.sendKeys")}</span>
      </div>
    </div>
  );
}
