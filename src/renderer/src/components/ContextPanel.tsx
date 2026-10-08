import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PERMISSION_POLICIES, type PermissionPolicy } from "@shared/chat-events";
import type { SessionSnapshotDto } from "@shared/ipc";
import { gitResultText, useGitChanges } from "../hooks/useGitChanges";
import { ChangeReview } from "./ChangeReview";
import { CheckMark, KindBadge } from "./CheckMark";
import { contextUsage, type SessionState } from "@shared/session-state";
import { useOpenFile } from "./FileViewer";
import { Icon } from "./Icon";
import { shortenHome } from "@shared/path-display";
import { basenameAny, joinAny } from "@shared/any-path";
import { isMod } from "../platform";
import { useNow } from "../hooks/useNow";

const POLICY_IDS = PERMISSION_POLICIES;

export function ContextPanel({
  state,
  config,
  onPolicy,
  onClear,
}: {
  state: SessionState;
  config: SessionSnapshotDto | null;
  onPolicy: (p: PermissionPolicy) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const cwd = config?.cwd ?? null;
  const idle =
    state.status === "idle" ||
    state.status === "error" ||
    state.status === "queued";
  // 변경 파일 + 커밋 폼 상태. cwd 가 바뀌거나 턴이 끝날 때 새로 읽는다. 변경 리뷰 오버레이와 공유.
  const g = useGitChanges(cwd, `${idle}:${state.totals.turns}`);
  const { git, changes, selected, selectedPaths, toggle, message, setMessage, busy, draft, commit } = g;
  const gitResult = g.result;
  const [showAll, setShowAll] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: true; path: string } | { ok: false; text: string } | null>(null);
  const openFile = useOpenFile();

  const last = state.lastTurn;
  const ctx = contextUsage(state);
  const used = ctx?.used ?? 0;
  const contextWindow = ctx?.window ?? undefined;
  const pct = ctx?.pct ?? null;
  const isCodex = config?.provider === "codex";

  return (
    // 구분선 대신 배경 위에 떠 있는 둥근 카드. 섹션도 선이 아니라 여백으로 나눈다.
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <Section title={t("panel.context.repo")} badge={git ? "ACTIVE" : undefined}>
          {cwd ? (
            <>
              <div className="flex items-center gap-2 text-[14px] font-semibold">
                <Icon name="folder" size={14} className="text-muted" />
                {git?.name ?? basenameAny(cwd)}
              </div>
              <div className="mono mt-1 truncate text-muted" title={cwd}>
                {shortenHome(cwd)}
              </div>
              {git?.branch && (
                <div className="mt-2 flex gap-1.5">
                  <span className="mono inline-flex items-center gap-1 rounded bg-panel-2 px-2 py-0.5">
                    <Icon name="branch" size={11} />
                    {git.branch}
                  </span>
                </div>
              )}
              {!git && (
                <p className="mt-2 text-muted">{t("panel.context.notGit")}</p>
              )}
            </>
          ) : (
            <p className="text-muted">{t("panel.context.pickCwd")}</p>
          )}
        </Section>

        <Section
          title={t("panel.context.changedFiles")}
          badge={changes.length > 0 ? String(changes.length) : undefined}
        >
          {changes.length === 0 ? (
            <p className="text-muted">{t("panel.changes.none")}</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between text-[10.5px] text-muted">
                <span>{t("panel.context.selected", { count: selectedPaths.length })}</span>
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => g.selectAll(selectedPaths.length !== changes.length)}
                    className="rounded px-1 hover:bg-panel-2 hover:text-fg"
                  >
                    {selectedPaths.length === changes.length ? t("panel.changes.deselectAll") : t("panel.changes.selectAll")}
                  </button>
                  <span className="text-muted-2">·</span>
                  <button
                    onClick={() => setReviewOpen(true)}
                    className="flex items-center gap-1 rounded px-1 text-accent hover:bg-panel-2"
                    title={t("panel.context.reviewTitle")}
                    data-review-open
                  >
                    <Icon name="branch" size={10} />
                    {t("panel.context.review")}
                  </button>
                </span>
              </div>
              <ul className="flex flex-col gap-px" data-git-changes>
                {(showAll ? changes : changes.slice(0, 12)).map((c) => {
                  const on = selected.has(c.path);
                  const open = () => openFile(git ? joinAny(git.root, c.path) : c.path);
                  return (
                    <li key={c.path}>
                      {/* 행 전체가 토글. 파일 열기는 오른쪽 hover 아이콘 또는 더블클릭. */}
                      <div
                        role="checkbox"
                        aria-checked={on}
                        aria-label={t("panel.changes.includeInCommit", { path: c.path })}
                        tabIndex={0}
                        onClick={() => toggle(c.path)}
                        onDoubleClick={open}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggle(c.path);
                          }
                        }}
                        className={`group -mx-1.5 flex h-[26px] cursor-default items-center gap-2 rounded-md px-1.5 hover:bg-panel-2 ${
                          on ? "" : "opacity-55"
                        }`}
                        data-change-row={c.path}
                      >
                        <CheckMark checked={on} />
                        <KindBadge kind={c.kind} />
                        <span className="mono min-w-0 flex-1 truncate text-fg" title={c.path}>
                          {c.path}
                        </span>
                        <span className="mono shrink-0 text-[10px] tabular-nums group-hover:hidden">
                          {c.added > 0 && <span className="text-ok">+{c.added}</span>}
                          {c.added > 0 && c.deleted > 0 && " "}
                          {c.deleted > 0 && <span className="text-err">−{c.deleted}</span>}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            open();
                          }}
                          className="hidden shrink-0 rounded p-0.5 text-muted hover:bg-panel hover:text-fg group-hover:block"
                          title={t("panel.context.openFile")}
                          data-change-open
                        >
                          <Icon name="file" size={12} />
                        </button>
                      </div>
                    </li>
                  );
                })}
                {changes.length > 12 && (
                  <li>
                    <button
                      onClick={() => setShowAll((v) => !v)}
                      className="text-muted hover:text-fg"
                    >
                      {showAll ? t("panel.context.collapse") : t("panel.context.showMore", { count: changes.length - 12 })}
                    </button>
                  </li>
                )}
              </ul>

              <div className="mt-3 flex flex-col gap-1.5" data-git-commit>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isMod(e)) {
                      e.preventDefault();
                      void commit();
                    }
                  }}
                  rows={message.includes("\n") ? 5 : 2}
                  placeholder={t("panel.changes.commitPlaceholder")}
                  disabled={busy !== null}
                  className="mono w-full resize-none rounded-md border border-line bg-inset px-2 py-1.5 text-[11.5px] leading-5 text-fg outline-none placeholder:text-muted focus:border-accent/50 disabled:opacity-60"
                  style={{ userSelect: "text" }}
                />
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void draft()}
                    disabled={busy !== null || selectedPaths.length === 0}
                    className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                    title={t("panel.changes.draftTitle")}
                    data-git-draft
                  >
                    <Icon name="sparkles" size={11} />
                    {busy === "draft" ? t("panel.changes.drafting") : t("panel.changes.draft")}
                  </button>
                  <button
                    onClick={() => void commit()}
                    disabled={
                      busy !== null ||
                      !idle ||
                      selectedPaths.length === 0 ||
                      !message.trim()
                    }
                    className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
                    title={
                      !idle
                        ? t("panel.changes.commitBlocked")
                        : t("panel.context.commitTitle")
                    }
                    data-git-commit-button
                  >
                    <Icon name="check" size={11} />
                    {busy === "commit" ? t("panel.changes.committing") : t("panel.changes.commitButton", { n: selectedPaths.length })}
                  </button>
                </div>
                {gitResult && (
                  <p
                    className={`mono text-[10.5px] ${gitResult.ok ? "text-ok" : "text-err"}`}
                    data-git-result
                  >
                    {gitResultText(t, gitResult)}
                  </p>
                )}
              </div>
            </>
          )}
        </Section>

        <Section
          title={t("panel.context.usage")}
          badge={pct !== null ? `${pct}%` : undefined}
          badgeClass="text-accent"
        >
          {last ? (
            <>
              {pct !== null && (
                <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <div className="mono flex justify-between text-muted">
                <span>{t("panel.context.used", { amount: fmt(used) })}</span>
                <span>
                  {contextWindow ? t("panel.context.max", { amount: fmt(contextWindow) }) : t("panel.context.maxUnknown")}
                </span>
              </div>
              <div className="mono mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
                <Dot
                  color="bg-accent"
                  label={t("panel.context.input", { amount: fmt(last.usage.input) })}
                />
                <Dot
                  color="bg-accent-2"
                  label={t("panel.context.cache", { amount: fmt(last.usage.cacheRead) })}
                />
                <Dot color="bg-ok" label={t("panel.context.output", { amount: fmt(last.usage.output) })} />
              </div>
              <p className="mt-2 text-[10px] text-muted">
                {isCodex
                  ? t("panel.context.footerCodex", { count: state.totals.turns })
                  : t("panel.context.footerCost", { count: state.totals.turns, cost: state.totals.costUsd.toFixed(3) })}
              </p>
            </>
          ) : (
            <p className="text-muted">{t("panel.context.afterFirst")}</p>
          )}
        </Section>

        <Section title={t("panel.context.permissions")}>
          <div className="flex flex-col gap-1.5">
            {POLICY_IDS.map((id) => {
              const active = (config?.policy ?? "ask") === id;
              return (
                <button
                  key={id}
                  onClick={() => onPolicy(id)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left ${
                    active
                      ? "border-accent/50 bg-accent-tint text-fg"
                      : "border-line text-muted hover:text-fg"
                  }`}
                >
                  <Icon
                    name="shield"
                    size={13}
                    className={active ? "text-accent" : ""}
                  />
                  <span className="flex-1">
                    {t(`panel.context.policy.${id}.${isCodex ? "codexLabel" : "label"}`)}
                  </span>
                  {active && (
                    <Icon name="check" size={12} className="text-accent" />
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-muted">
            {t(`panel.context.policy.${config?.policy ?? "ask"}.${isCodex ? "codexHelp" : "help"}`)}
          </p>
        </Section>
      </div>

      <div className="bg-inset px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${idle ? "bg-muted" : "bg-ok"}`}
            />
            {idle ? t("panel.context.idle") : t("panel.context.running")}
          </span>
          <Timer since={config?.startedAt ?? null} />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() =>
              config &&
              void window.sudal.chat
                .exportMarkdown(config.tabId)
                .then((p) => p && setExportResult({ ok: true, path: p }))
                .catch((e: unknown) =>
                  setExportResult({ ok: false, text: e instanceof Error ? e.message : String(e) }),
                )
            }
            disabled={!config || state.blocks.length === 0}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-line py-2 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
            title={t("panel.context.exportTitle")}
            data-export-button
          >
            <Icon name="file" size={13} />
            {t("panel.context.export")}
          </button>
          {/* 휴지통은 과장이었다. 이 버튼은 대화를 지우지 않는다 — 화면에서 치우고 새 세션으로 갈 뿐이고,
              비운 대화는 보관본으로 남는다(탭당 10회분). Claude 쪽 기록도 원래부터 그대로 남아 있었다. */}
          <button
            onClick={onClear}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-line py-2 text-muted hover:bg-panel-2 hover:text-fg"
            title={t("panel.context.newChatTitle")}
            data-clear-button
          >
            <Icon name="refresh" size={13} />
            {t("panel.context.newChat")}
          </button>
        </div>
        {exportResult && (
          <p className={`mono mt-1.5 text-[10.5px] ${exportResult.ok ? "text-ok" : "text-err"}`}>{exportResult.ok ? t("panel.context.exported", { path: exportResult.path }) : exportResult.text}</p>
        )}
        {reviewOpen && cwd && (
          <ChangeReview cwd={cwd} gitState={g} canCommit={idle} onClose={() => setReviewOpen(false)} />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  badge,
  badgeClass = "",
  children,
}: {
  title: string;
  badge?: string;
  badgeClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 pb-5 pt-2">
      <div className="mb-3 flex items-center justify-between">
        <span className="label">{title}</span>
        {badge && (
          <span
            className={`label rounded bg-panel-2 px-1.5 py-0.5 ${badgeClass}`}
          >
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function Timer({ since }: { since: number | null }) {
  const now = useNow(!!since);
  if (!since) return <span className="mono text-muted">00:00:00</span>;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="mono text-muted">
      {pad(Math.floor(s / 3600))}:{pad(Math.floor((s % 3600) / 60))}:
      {pad(s % 60)}
    </span>
  );
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

