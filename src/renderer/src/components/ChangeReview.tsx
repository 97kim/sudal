// 변경 리뷰 오버레이: 커밋 전에 파일별 diff 를 훑고, 커밋 대상 체크·되돌리기·커밋을 한 화면에서 한다.
import { usePaneFocusRef } from "../pane-focus";
// 컨텍스트 패널 안에서 열리지만 채팅 전체를 덮어야 해서 body 에 포털로 그린다.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { FileViewDto, GitChangeDto } from "@shared/ipc";
import { gitResultText, type GitChangesState } from "../hooks/useGitChanges";
import { buildDiff, CodeTable, DiffTable, highlight } from "./FileViewer";
import { Icon } from "./Icon";
import { CheckMark, KindBadge } from "./CheckMark";
import { Modal } from "./Modal";
import { joinAny } from "@shared/any-path";
import { isMod } from "../platform";

const KIND_CLASS: Record<GitChangeDto["kind"], string> = {
  added: "text-ok",
  modified: "text-warn",
  deleted: "text-err",
  renamed: "text-warn",
};

export function ChangeReview({
  cwd,
  gitState,
  canCommit,
  onClose,
}: {
  cwd: string;
  gitState: GitChangesState;
  /** 턴 실행 중에는 false — 파일이 바뀌는 중일 수 있어 커밋·되돌리기를 잠근다. */
  canCommit: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const g = gitState;
  const [current, setCurrent] = useState<string | null>(g.changes[0]?.path ?? null);
  const [file, setFile] = useState<FileViewDto | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);

  // 목록이 바뀌어(커밋·되돌리기) 현재 파일이 사라지면 첫 파일로.
  useEffect(() => {
    if (current && !g.changes.some((c) => c.path === current)) setCurrent(g.changes[0]?.path ?? null);
    else if (!current && g.changes[0]) setCurrent(g.changes[0].path);
  }, [g.changes, current]);

  useEffect(() => {
    if (!current) {
      setFile(null);
      return;
    }
    let alive = true;
    setFile(null);
    setFileError(null);
    const abs = g.git ? joinAny(g.git.root, current) : current;
    window.sudal.files
      .read(cwd, abs)
      .then((f) => alive && setFile(f))
      .catch((e) => alive && setFileError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [cwd, current, g.git, g.changes]);

  // Esc 로 닫기 (파일 뷰어와 같이 캡처 단계에서 먹는다)
  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (confirmRevert) setConfirmRevert(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, confirmRevert]);

  const diff = useMemo(
    () => (file && file.headContent !== null && file.content !== null ? buildDiff(file.headContent, file.content) : null),
    [file],
  );
  const shown = file?.content ?? file?.headContent ?? "";
  const html = useMemo(() => (file && !diff ? highlight(shown, file.path) : ""), [file, diff, shown]);
  const currentChange = g.changes.find((c) => c.path === current) ?? null;
  const total = g.changes.reduce((n, c) => ({ a: n.a + c.added, d: n.d + c.deleted }), { a: 0, d: 0 });

  return createPortal(
    <Modal variant="window" onClose={onClose} className="flex h-full w-full max-w-[1280px] flex-col overflow-hidden" data-change-review>
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Icon name="branch" size={15} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t("panel.review.title")}</div>
          <div className="mono mt-0.5 text-[10.5px] text-muted">
            {g.git?.name ?? cwd}
            {g.git?.branch ? ` · ${g.git.branch}` : ""} · {t("panel.review.fileCount", { count: g.changes.length })} ·{" "}
            <span className="text-ok">+{total.a}</span> <span className="text-err">−{total.d}</span>
          </div>
        </div>
        <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title={t("panel.review.closeTitle")}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 파일 목록 */}
        <div className="flex w-[300px] shrink-0 flex-col border-r border-line">
          <div className="flex items-center justify-between px-3 py-2 text-[10.5px] text-muted">
            <span>{t("panel.review.commitTargets", { count: g.selectedPaths.length })}</span>
            <button
              onClick={() => g.selectAll(g.selectedPaths.length !== g.changes.length)}
              className="rounded px-1 hover:bg-panel-2 hover:text-fg"
            >
              {g.selectedPaths.length === g.changes.length ? t("panel.changes.deselectAll") : t("panel.changes.selectAll")}
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-review-list>
            {g.changes.length === 0 && <li className="px-2 py-6 text-center text-muted">{t("panel.changes.none")}</li>}
            {g.changes.map((c) => {
              const label = t(`panel.changes.kind.${c.kind}`);
              const cls = KIND_CLASS[c.kind];
              const active = c.path === current;
              return (
                <li key={c.path} data-review-file={c.path}>
                  <div
                    onClick={() => setCurrent(c.path)}
                    className={`group flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 ${
                      active ? "bg-panel-2" : "hover:bg-panel-2/60"
                    }`}
                  >
                    <CheckMark
                      checked={g.selected.has(c.path)}
                      onToggle={() => g.toggle(c.path)}
                      label={t("panel.changes.includeInCommit", { path: c.path })}
                      className="mt-[1px]"
                    />
                    <KindBadge kind={c.kind} />
                    <span className={`min-w-0 flex-1 ${g.selected.has(c.path) ? "" : "opacity-55"}`}>
                      <span className="mono block truncate text-[11.5px] text-fg" title={c.path}>
                        {c.path}
                      </span>
                      <span className="mono text-[10px] tabular-nums">
                        <span className={cls}>{label}</span>
                        {c.added > 0 && <span className="ml-1.5 text-ok">+{c.added}</span>}
                        {c.deleted > 0 && <span className="ml-1 text-err">−{c.deleted}</span>}
                      </span>
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmRevert(c.path);
                      }}
                      disabled={!canCommit || g.busy !== null}
                      className="rounded p-1 text-muted opacity-0 hover:bg-err-bg hover:text-err group-hover:opacity-100 disabled:opacity-0"
                      title={t("panel.review.revertTitle")}
                      data-review-revert
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  </div>
                  {confirmRevert === c.path && (
                    <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-err/40 bg-err-bg px-2 py-1.5 text-[11px] text-err" data-review-confirm>
                      <span className="min-w-0 flex-1">
                        {c.kind === "added" ? t("panel.review.confirmDelete") : t("panel.review.confirmDiscard")}
                      </span>
                      <button
                        onClick={() => {
                          setConfirmRevert(null);
                          void g.revert(c.path);
                        }}
                        className="rounded bg-err px-2 py-0.5 font-medium text-white hover:opacity-90"
                        data-review-confirm-yes
                      >
                        {t("panel.review.discard")}
                      </button>
                      <button onClick={() => setConfirmRevert(null)} className="rounded px-1.5 py-0.5 hover:bg-err/10">
                        {t("common.cancel")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* diff */}
        <div className="flex min-w-0 flex-1 flex-col">
          {currentChange && (
            <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[11px] text-muted">
              <span className="mono truncate text-fg">{currentChange.path}</span>
              {currentChange.oldPath && <span className="mono truncate">← {currentChange.oldPath}</span>}
              <span className={`label ml-auto shrink-0 ${KIND_CLASS[currentChange.kind]}`}>
                {t(`panel.changes.kind.${currentChange.kind}`)}
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto bg-inset">
            {!current && <Empty>{t("panel.review.pickFile")}</Empty>}
            {current && fileError && <Empty>{t("panel.review.readFailed", { error: fileError })}</Empty>}
            {current && !fileError && !file && <Empty>{t("common.loading")}</Empty>}
            {file && file.binary && <Empty>{t("panel.review.binary")}</Empty>}
            {file && file.tooLarge && <Empty>{t("panel.review.tooLarge")}</Empty>}
            {file && !file.binary && !file.tooLarge && (diff ? (
              diff.added + diff.deleted === 0 ? <Empty>{t("panel.review.metaOnly")}</Empty> : <DiffTable rows={diff.rows} />
            ) : shown ? (
              <>
                <div className="border-b border-line px-4 py-2 text-[11px] text-muted">
                  {file.missing ? t("panel.review.deletedFile") : t("panel.review.newFile")}
                </div>
                <CodeTable html={html} lines={shown.split("\n").length} />
              </>
            ) : (
              <Empty>{t("panel.review.emptyFile")}</Empty>
            ))}
          </div>
        </div>
      </div>

      {/* 커밋 바 */}
      <div className="flex items-start gap-2 border-t border-line px-4 py-3" data-review-commit>
        <textarea
          value={g.message}
          onChange={(e) => g.setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMod(e)) {
              e.preventDefault();
              void g.commit();
            }
          }}
          rows={g.message.includes("\n") ? 4 : 2}
          placeholder={t("panel.changes.commitPlaceholder")}
          disabled={g.busy !== null}
          className="mono min-w-0 flex-1 resize-none rounded-md border border-line bg-inset px-2.5 py-1.5 text-[12px] leading-5 text-fg outline-none placeholder:text-muted focus:border-accent/50 disabled:opacity-60"
          style={{ userSelect: "text" }}
        />
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={() => void g.draft()}
              disabled={g.busy !== null || g.selectedPaths.length === 0}
              className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
              title={t("panel.changes.draftTitle")}
            >
              <Icon name="sparkles" size={11} />
              {g.busy === "draft" ? t("panel.changes.drafting") : t("panel.changes.draft")}
            </button>
            <button
              onClick={() => void g.commit()}
              disabled={g.busy !== null || !canCommit || g.selectedPaths.length === 0 || !g.message.trim()}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
              title={!canCommit ? t("panel.changes.commitBlocked") : t("panel.review.commitTitle")}
              data-review-commit-button
            >
              <Icon name="check" size={11} />
              {g.busy === "commit" ? t("panel.changes.committing") : t("panel.changes.commitButton", { n: g.selectedPaths.length })}
            </button>
          </div>
          {g.result && (
            <span className={`mono text-[10.5px] ${g.result.ok ? "text-ok" : "text-err"}`} data-review-result>
              {gitResultText(t, g.result)}
            </span>
          )}
        </div>
      </div>
    </Modal>,
    document.body,
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-muted">{children}</div>;
}
