// 우측 패널의 파일 탐색기. 디렉토리는 펼칠 때 main 에서 목록을 받아오고(lazy), 파일을 누르면 코드 뷰어로 연다.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DirEntryDto, GitChangeDto } from "@shared/ipc";
import { useOpenFile } from "./FileViewer";
import { Icon } from "./Icon";
import { CheckMark } from "./CheckMark";
import { closeEditorPaths, dirtyEditorPathsUnder, renameEditorPaths } from "../editor-tabs";
import { shortenHome } from "@shared/path-display";
import { basenameAny, dirnameAny, joinAny, relativeAny } from "@shared/any-path";

/** 편집 중(저장 안 됨)인 파일을 건드리는 조작은 거부한다 — 이름 변경·삭제는 에디터 버퍼를 조용히 버리기 때문. */
function dirtyBlockMessage(t: TFunction, path: string): string | null {
  const d = dirtyEditorPathsUnder(path);
  if (d.length === 0) return null;
  const name = basenameAny(d[0]);
  return d.length === 1 ? t("panel.fileTree.dirtyOne", { name }) : t("panel.fileTree.dirtyMany", { count: d.length });
}

/** 파일 조작(새 파일·폴더, 이름 변경, 삭제)과 디렉토리별 새로 고침. 트리 어디서든 context 로 쓴다. */
interface TreeOps {
  root: string;
  /** 디렉토리 목록을 다시 읽게 한다 (그 디렉토리의 DirChildren 만). */
  refreshDir(dir: string): void;
  versionOf(dir: string): number;
  openMenu(e: React.MouseEvent, target: DirEntryDto | null): void;
  /** 이름 입력 중인 항목: 새 항목은 {dir, kind}, 이름 변경은 {entry}. */
  pending: PendingEdit | null;
  setPending(p: PendingEdit | null): void;
  error: string | null;
}
type PendingEdit =
  | { mode: "create"; dir: string; kind: "file" | "dir" }
  | { mode: "rename"; entry: DirEntryDto };
const TreeOpsContext = createContext<TreeOps | null>(null);

/** git 상태: 절대 경로 → 변경 종류, 그리고 변경을 품은 디렉토리 집합(펼치기 전에도 점으로 표시). */
interface GitStatus {
  files: Map<string, GitChangeDto["kind"]>;
  dirs: Set<string>;
}
const EMPTY_STATUS: GitStatus = { files: new Map(), dirs: new Set() };
const GitStatusContext = createContext<GitStatus>(EMPTY_STATUS);
const TreeRootContext = createContext("");

/** 변경 파일 행: 글자색만으로는 눈에 안 띄어 행 배경을 같은 계열로 칠한다. */
const STATUS_CLASS: Record<GitChangeDto["kind"], string> = {
  added: "text-ok bg-ok-bg hover:brightness-95",
  modified: "text-warn bg-warn-bg hover:brightness-95",
  renamed: "text-warn bg-warn-bg hover:brightness-95",
  deleted: "text-err bg-err-bg hover:brightness-95",
};
const STATUS_ICON: Record<GitChangeDto["kind"], string> = {
  added: "text-ok",
  modified: "text-warn",
  renamed: "text-warn",
  deleted: "text-err",
};

/**
 * 변경 목록을 트리가 쓰기 좋은 형태로. 키는 트리 루트(cwd) 기준 상대 경로 — 심링크 cwd 에서도 항목 경로와 맞는다.
 * status 의 경로는 레포 루트 기준이라 cwd 의 prefix 를 떼어 낸다(cwd 밖의 변경은 트리에 없으니 버린다).
 */
function buildStatus(prefix: string, changes: GitChangeDto[]): GitStatus {
  const files = new Map<string, GitChangeDto["kind"]>();
  const dirs = new Set<string>();
  const pre = prefix ? `${prefix}/` : "";
  for (const c of changes) {
    if (pre && !c.path.startsWith(pre)) continue;
    const rel = c.path.slice(pre.length);
    files.set(rel, c.kind);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return { files, dirs };
}

/** 트리 항목의 절대 경로 → 트리 루트 기준 상대 경로. git 키처럼 / 구분이라 Windows 의 \ 경로도 맞는다. */
function relToRoot(root: string, abs: string): string {
  return relativeAny(abs, root) || abs;
}

/** 펼쳐도 보통 쓸모없는 큰 폴더. 숨기진 않고 흐리게만. */
const DIM_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "release",
  "build",
  ".next",
  "target",
  "__pycache__",
]);

const HIDDEN_KEY = "sudal.fileTree.showHidden";
const ShowHiddenContext = createContext(false);

export function FileTree({ root }: { root: string }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const openFile = useOpenFile();
  // 파일 조작 상태: 우클릭 메뉴, 이름 입력 중인 항목, 마지막 오류, 디렉토리별 새로 고침 카운터
  const [menu, setMenu] = useState<{ x: number; y: number; target: DirEntryDto | null } | null>(null);
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [dirVersions, setDirVersions] = useState<Record<string, number>>({});
  const [confirmDelete, setConfirmDelete] = useState<DirEntryDto | null>(null);
  const refreshDir = useCallback((dir: string) => setDirVersions((v) => ({ ...v, [dir]: (v[dir] ?? 0) + 1 })), []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  const parentOf = (p: string) => dirnameAny(p);
  const doDelete = async (entry: DirEntryDto) => {
    setConfirmDelete(null);
    const blocked = dirtyBlockMessage(t, entry.path);
    if (blocked) return setOpError(blocked);
    const r = await window.sudal.files.remove(root, entry.path);
    if (!r.ok) return setOpError(r.error);
    closeEditorPaths(entry.path);
    refreshDir(parentOf(entry.path));
  };
  const ops: TreeOps = {
    root,
    refreshDir,
    versionOf: (dir) => dirVersions[dir] ?? 0,
    openMenu: (e, target) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, target });
    },
    pending,
    setPending: (p) => {
      setOpError(null);
      setPending(p);
    },
    error: opError,
  };
  const menuDir = menu ? (menu.target ? (menu.target.kind === "dir" ? menu.target.path : parentOf(menu.target.path)) : root) : root;
  // git 상태: 마운트·새로 고침 때 읽고, 열려 있는 동안 4초마다 갱신(에이전트가 파일을 고치는 중에도 색이 따라온다).
  const [status, setStatus] = useState<GitStatus>(EMPTY_STATUS);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let lastKey = "";
    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const info = await window.sudal.git.info(root);
        if (!alive) return;
        if (!info) {
          if (lastKey !== "") {
            lastKey = "";
            setStatus(EMPTY_STATUS);
          }
          return;
        }
        const changes = await window.sudal.git.changes(root);
        if (!alive) return;
        // 같은 결과면 새 Map 을 만들지 않는다 (트리 전체 리렌더 방지)
        const key = JSON.stringify([info.prefix, changes]);
        if (key === lastKey) return;
        lastKey = key;
        setStatus(buildStatus(info.prefix, changes));
      } finally {
        inFlight = false;
      }
    };
    void load().catch(() => {});
    const t = setInterval(() => void load().catch(() => {}), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [root, version]);
  // 숨김 항목(dot 파일·폴더) 표시 여부. 기본은 숨김, 선택은 저장.
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_KEY, showHidden ? "1" : "0");
    } catch {
      /* 무시 */
    }
  }, [showHidden]);
  return (
    <ShowHiddenContext.Provider value={showHidden}>
      <GitStatusContext.Provider value={status}>
      <TreeRootContext.Provider value={root}>
      <TreeOpsContext.Provider value={ops}>
      <div className="flex h-full flex-col" onContextMenu={(e) => ops.openMenu(e, null)}>
        <div className="flex items-center gap-2 px-3 pb-1">
          <span
            className="mono min-w-0 flex-1 truncate text-[10.5px] text-muted"
            title={root}
          >
            {shortenHome(root)}
          </span>
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="flex shrink-0 cursor-default items-center gap-1.5 rounded px-1 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
            title={t("panel.fileTree.showHiddenTitle")}
            role="checkbox"
            aria-checked={showHidden}
          >
            <CheckMark checked={showHidden} />
            {t("panel.fileTree.showHidden")}
          </button>
          <button
            onClick={() => ops.setPending({ mode: "create", dir: root, kind: "file" })}
            className="shrink-0 rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
            title={t("panel.fileTree.newFileRoot")}
            data-tree-new-file
          >
            <Icon name="plus" size={11} />
          </button>
          <button
            onClick={() => setVersion((v) => v + 1)}
            className="shrink-0 rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
            title={t("common.refresh")}
          >
            <Icon name="refresh" size={11} />
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          data-file-tree
        >
          {opError && (
            <div className="mono mb-1 flex items-center gap-1 rounded bg-err-bg px-2 py-1 text-[10.5px] text-err" data-tree-error>
              <span className="min-w-0 flex-1 truncate">{opError}</span>
              <button onClick={() => setOpError(null)} className="rounded p-0.5 hover:bg-err/10">
                <Icon name="x" size={10} />
              </button>
            </div>
          )}
          {confirmDelete && (
            <div className="mb-1 flex items-center gap-2 rounded-md border border-err/40 bg-err-bg px-2 py-1.5 text-[11px] text-err" data-tree-confirm-delete>
              <span className="min-w-0 flex-1 truncate">
                {t(confirmDelete.kind === "dir" ? "panel.fileTree.trashDir" : "panel.fileTree.trashFile", { name: confirmDelete.name })}
              </span>
              <button onClick={() => void doDelete(confirmDelete)} className="rounded bg-err px-2 py-0.5 font-medium text-white hover:opacity-90" data-tree-confirm-yes>
                {t("common.delete")}
              </button>
              <button onClick={() => setConfirmDelete(null)} className="rounded px-1.5 py-0.5 hover:bg-err/10">
                {t("common.cancel")}
              </button>
            </div>
          )}
          <DirChildren key={version} dir={root} depth={0} />
        </div>
      </div>
      {menu && (
        <div
          role="menu"
          className="fixed z-40 w-[168px] rounded-md border border-line bg-panel p-1 shadow-xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 176), top: Math.min(menu.y, window.innerHeight - 170) }}
          onMouseDown={(e) => e.stopPropagation()}
          data-tree-menu
        >
          {menu.target?.kind === "file" && (
            <TreeMenuItem label={t("common.open")} onPick={() => { setMenu(null); openFile(menu.target!.path); }} />
          )}
          <TreeMenuItem label={t("panel.fileTree.newFile")} onPick={() => { setMenu(null); ops.setPending({ mode: "create", dir: menuDir, kind: "file" }); }} />
          <TreeMenuItem label={t("panel.fileTree.newFolder")} onPick={() => { setMenu(null); ops.setPending({ mode: "create", dir: menuDir, kind: "dir" }); }} />
          {menu.target && (
            <>
              <div className="my-1 h-px bg-line" />
              <TreeMenuItem label={t("common.rename")} onPick={() => { setMenu(null); ops.setPending({ mode: "rename", entry: menu.target! }); }} />
              <TreeMenuItem label={t("panel.fileTree.moveToTrash")} danger onPick={() => { setMenu(null); setConfirmDelete(menu.target); }} />
            </>
          )}
        </div>
      )}
      </TreeOpsContext.Provider>
      </TreeRootContext.Provider>
      </GitStatusContext.Provider>
    </ShowHiddenContext.Provider>
  );
}

function DirChildren({ dir, depth }: { dir: string; depth: number }) {
  const { t } = useTranslation();
  const [all, setAll] = useState<DirEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showHidden = useContext(ShowHiddenContext);
  const ops = useContext(TreeOpsContext);
  const version = ops?.versionOf(dir) ?? 0;
  const entries =
    all && !showHidden ? all.filter((e) => !e.name.startsWith(".")) : all;
  useEffect(() => {
    let alive = true;
    window.sudal.files
      .list(dir)
      .then((e) => alive && setAll(e))
      .catch(
        (e: unknown) =>
          alive && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [dir, version]);
  const creating = ops?.pending?.mode === "create" && ops.pending.dir === dir ? ops.pending : null;
  if (error)
    return (
      <div className="mono px-2 py-1 text-[10.5px] text-err">
        {t("panel.fileTree.readFailed", { error })}
      </div>
    );
  if (!entries)
    return (
      <div className="px-2 py-1 text-[10.5px] text-muted">{t("common.loading")}</div>
    );
  if (entries.length === 0 && !creating)
    return (
      <div className="px-2 py-1 text-[10.5px] text-muted">
        {all && all.length > 0 ? t("panel.fileTree.onlyHidden") : t("panel.fileTree.emptyFolder")}
      </div>
    );
  return (
    <ul>
      {creating && ops && (
        <li>
          <NameInput
            depth={depth + (creating.kind === "dir" ? 0 : 1)}
            kind={creating.kind}
            initial=""
            placeholder={creating.kind === "dir" ? t("panel.fileTree.newFolderName") : t("panel.fileTree.newFileName")}
            onCancel={() => ops.setPending(null)}
            onCommit={async (name) => {
              const r = await window.sudal.files.create(ops.root, joinAny(dir, name), creating.kind);
              if (!r.ok) return r.error;
              ops.setPending(null);
              ops.refreshDir(dir);
              return null;
            }}
          />
        </li>
      )}
      {entries.map((e) => (
        <li key={e.path}>
          {e.kind === "dir" ? (
            <DirNode entry={e} depth={depth} />
          ) : (
            <FileNode entry={e} depth={depth} />
          )}
        </li>
      ))}
    </ul>
  );
}

const ROW_CLASS = "flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12px] hover:bg-panel-2";

function DirNode({ entry, depth }: { entry: DirEntryDto; depth: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const dim = DIM_DIRS.has(entry.name) || entry.name.startsWith(".");
  const root = useContext(TreeRootContext);
  const hasChanges = useContext(GitStatusContext).dirs.has(relToRoot(root, entry.path));
  const ops = useContext(TreeOpsContext);
  // 이 폴더 안에 새 항목을 만들면 자동으로 펼친다
  const creatingInside = ops?.pending?.mode === "create" && ops.pending.dir === entry.path;
  useEffect(() => {
    if (creatingInside) setOpen(true);
  }, [creatingInside]);
  if (ops?.pending?.mode === "rename" && ops.pending.entry.path === entry.path) {
    return <RenameRow entry={entry} depth={depth} ops={ops} />;
  }
  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => ops?.openMenu(e, entry)}
        className={`${ROW_CLASS} ${dim ? "text-muted" : "text-fg"} ${
          hasChanges && !open ? "bg-warn-bg/60 hover:bg-warn-bg" : ""
        }`}
        style={{ paddingLeft: 6 + depth * 14 }}
        data-dir={entry.path}
        data-dir-has-changes={hasChanges ? "true" : undefined}
      >
        <Icon
          name="chevronRight"
          size={11}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Icon name="folder" size={12} className="shrink-0 text-accent" />
        <span className="truncate">{entry.name}</span>
        {hasChanges && !open && (
          <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title={t("panel.fileTree.hasChanges")} data-dir-changed />
        )}
      </button>
      {open && <DirChildren dir={entry.path} depth={depth + 1} />}
    </>
  );
}

function FileNode({ entry, depth }: { entry: DirEntryDto; depth: number }) {
  const { t } = useTranslation();
  const openFile = useOpenFile();
  const onClick = useCallback(
    () => openFile(entry.path),
    [openFile, entry.path],
  );
  const dim = entry.name.startsWith(".");
  const root = useContext(TreeRootContext);
  const kind = useContext(GitStatusContext).files.get(relToRoot(root, entry.path));
  const color = kind ? STATUS_CLASS[kind] : dim ? "text-muted" : "text-fg";
  const ops = useContext(TreeOpsContext);
  if (ops?.pending?.mode === "rename" && ops.pending.entry.path === entry.path) {
    return <RenameRow entry={entry} depth={depth} ops={ops} />;
  }
  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => ops?.openMenu(e, entry)}
      className={`${ROW_CLASS} ${kind ? "hover:bg-transparent" : ""} ${color}`}
      style={{ paddingLeft: 6 + 14 + depth * 14 }}
      title={`${entry.path} · ${fmtSize(entry.size)}${kind ? ` · ${t(`panel.fileTree.status.${kind}`)}` : ""}`}
      data-file={entry.path}
      data-git-kind={kind}
    >
      <Icon name="file" size={12} className={`shrink-0 ${kind ? STATUS_ICON[kind] : "text-muted"}`} />
      <span className="truncate">{entry.name}</span>
      {kind && <span className="mono ml-auto shrink-0 text-[9.5px] font-semibold opacity-80">{kind[0].toUpperCase()}</span>}
    </button>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function TreeMenuItem({ label, onPick, danger }: { label: string; onPick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onPick}
      className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-panel-2 ${danger ? "text-err" : "text-fg"}`}
    >
      {label}
    </button>
  );
}

/** 이름 입력 한 줄. Enter 로 확정, Esc/blur 로 취소. onCommit 이 오류 문자열을 돌려주면 그 자리에 보여 준다. */
function NameInput({
  depth,
  kind,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  initial: string;
  placeholder: string;
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = async () => {
    const name = value.trim();
    if (!name || name === initial) return onCancel();
    setBusy(true);
    const err = await onCommit(name);
    setBusy(false);
    if (err) {
      setError(err);
      // 오류를 보인 채 계속 고칠 수 있게 포커스를 유지한다 (잃으면 Esc 도 안 먹는다)
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };
  return (
    <div className="flex flex-col" style={{ paddingLeft: 6 + depth * 14 }}>
      <div className="flex items-center gap-1.5 py-[2px] pr-2">
        <Icon name={kind === "dir" ? "folder" : "file"} size={12} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          autoFocus
          value={value}
          readOnly={busy}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => {
            // 이름 변경이면 확장자 앞까지만 선택
            const dot = initial.lastIndexOf(".");
            e.target.setSelectionRange(0, kind === "file" && dot > 0 ? dot : initial.length);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void commit();
            else if (e.key === "Escape") onCancel();
          }}
          onBlur={() => { if (!busy) onCancel(); }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded border border-accent/50 bg-inset px-1 text-[12px] text-fg outline-none"
          style={{ userSelect: "text" }}
          data-tree-name-input
        />
      </div>
      {error && <div className="mono px-6 pb-1 text-[10px] text-err">{error}</div>}
    </div>
  );
}

function RenameRow({ entry, depth, ops }: { entry: DirEntryDto; depth: number; ops: TreeOps }) {
  const { t } = useTranslation();
  const parent = dirnameAny(entry.path);
  return (
    <NameInput
      depth={depth + (entry.kind === "dir" ? 0 : 1)}
      kind={entry.kind === "dir" ? "dir" : "file"}
      initial={entry.name}
      placeholder={t("panel.fileTree.newName")}
      onCancel={() => ops.setPending(null)}
      onCommit={async (name) => {
        const to = joinAny(parent, name);
        const blocked = dirtyBlockMessage(t, entry.path);
        if (blocked) return blocked;
        const r = await window.sudal.files.rename(ops.root, entry.path, to);
        if (!r.ok) return r.error;
        renameEditorPaths(entry.path, r.path);
        ops.setPending(null);
        ops.refreshDir(parent);
        return null;
      }}
    />
  );
}
