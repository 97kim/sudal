// 검증 결과 카드 — 저장한 명령을 순서대로 돌린 결과(명령별 통과/실패·출력 꼬리·실행 시점 HEAD). 진행 중엔 출력이 흐르고 중단할 수 있다.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { VerifyCommandResult } from "@shared/chat-events";
import type { VerifyBlock } from "@shared/session-state";
import { formatOutputAttachment } from "@shared/attachments";
import { failedCommandTitle, formatDuration, verifyOutputText, verifySummary } from "@shared/verify";
import { appendComposerDraft } from "../composer-draft";
import { Icon } from "./Icon";
import { useNow } from "../hooks/useNow";

function StatusDot({ status }: { status: VerifyCommandResult["status"] }) {
  if (status === "passed") return <Icon name="check" size={11} className="text-ok" />;
  if (status === "failed") return <Icon name="x" size={11} className="text-err" />;
  if (status === "running") return <span className="spin inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-accent border-t-transparent" />;
  if (status === "aborted") return <Icon name="minus" size={11} className="text-warn" />;
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-2/60" />;
}

function CommandRow({ c, tabId, live }: { c: VerifyCommandResult; tabId: string; live: boolean }) {
  const { t, i18n } = useTranslation();
  // 실패·실행 중은 출력을 펼쳐 두고, 통과한 것은 접어 둔다(클릭으로 펼침)
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (c.status === "failed" || c.status === "running");
  const outputText = verifyOutputText(i18n, c);
  const hasOutput = !!outputText.trim();
  const attach = () => appendComposerDraft(tabId, formatOutputAttachment({ title: failedCommandTitle(c, t), text: outputText }));
  return (
    <div className="border-t border-line first:border-t-0" data-verify-cmd={c.status}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="flex w-3.5 shrink-0 items-center justify-center">
          <StatusDot status={c.status} />
        </span>
        <button
          onClick={() => hasOutput && setOpen(!expanded)}
          className={`mono min-w-0 flex-1 truncate text-left ${c.status === "skipped" || c.status === "pending" ? "text-muted-2" : ""} ${hasOutput ? "hover:text-accent" : "cursor-default"}`}
          title={hasOutput ? (expanded ? t("chat.verifyCard.hideOutput") : t("chat.verifyCard.showOutput")) : c.cmd}
        >
          {c.cmd}
        </button>
        {c.status === "failed" && typeof c.exitCode === "number" && <span className="mono shrink-0 text-[10.5px] text-err">exit {c.exitCode}</span>}
        {c.status === "skipped" && <span className="shrink-0 text-[10.5px] text-muted-2">{t("chat.verifyCard.skipped")}</span>}
        {c.status === "aborted" && <span className="shrink-0 text-[10.5px] text-warn">{t("chat.verifyCard.aborted")}</span>}
        {typeof c.durationMs === "number" && <span className="mono shrink-0 text-[10.5px] text-muted-2">{formatDuration(c.durationMs, t)}</span>}
        {c.status === "failed" && hasOutput && (
          <button
            onClick={attach}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
            title={t("chat.verifyCard.attachHint")}
            data-verify-attach
          >
            {t("chat.verifyCard.attach")}
          </button>
        )}
      </div>
      {expanded && hasOutput && (
        <pre
          className={`mono mx-3 mb-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-inset p-2.5 text-[11px] leading-[1.5] ${c.status === "failed" ? "text-fg" : "text-muted"}`}
          style={{ userSelect: "text" }}
          data-verify-output
          ref={(el) => {
            if (el && live) el.scrollTop = el.scrollHeight;
          }}
        >
          {outputText}
        </pre>
      )}
    </div>
  );
}

export function VerifyCard({ block, tabId, onRerun }: { block: VerifyBlock; tabId: string; onRerun?: () => void }) {
  const { t } = useTranslation();
  const running = block.status === "running";
  const elapsed = Math.max(0, useNow(running) - block.ts);
  const total = running ? elapsed : (block.endedAt ?? block.ts) - block.ts;
  const tone = block.status === "passed" ? "text-ok" : block.status === "failed" ? "text-err" : block.status === "aborted" ? "text-warn" : "text-accent";
  return (
    <div className="content-indent rounded-lg border border-line bg-panel" data-verify-card={block.id} data-verify-status={block.status}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded ${block.status === "passed" ? "bg-ok/15" : block.status === "failed" ? "bg-err/15" : "bg-panel-2"}`}>
          {running ? <span className="spin inline-block h-3 w-3 rounded-full border-[1.5px] border-accent border-t-transparent" /> : <Icon name={block.status === "passed" ? "check" : block.status === "failed" ? "x" : "minus"} size={11} className={tone} />}
        </span>
        <span className="font-medium">{t("chat.verifyCard.title")}</span>
        <span className={`label ${tone}`}>
          {running ? (
            <span className="shimmer" style={{ "--shimmer-base": "var(--color-accent)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}>
              {t("shared.verify.status.running")}
            </span>
          ) : (
            t(`shared.verify.status.${block.status}`)
          )}
        </span>
        <span className="text-[11px] text-muted" data-verify-summary>
          {verifySummary(block.commands, t)}
        </span>
        <span className="flex-1" />
        {block.head && (
          <span className="mono flex shrink-0 items-center gap-1 text-[10.5px] text-muted-2" title={t(block.head.dirty ? "chat.verifyCard.headDirty" : "chat.verifyCard.head")} data-verify-head={block.head.sha}>
            <Icon name="branch" size={10} />
            {block.head.branch ? `${block.head.branch} ` : ""}
            {block.head.sha}
            {block.head.dirty && <span className="text-warn">{t("chat.verifyCard.dirty")}</span>}
          </span>
        )}
        <span className="mono shrink-0 text-[10.5px] text-muted-2">{formatDuration(total, t)}</span>
        {running ? (
          <button
            onClick={() => void window.sudal.chat.verifyAbort(tabId)}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-err/10 hover:text-err"
            title={t("chat.verifyCard.abortHint")}
            data-verify-abort
          >
            {t("chat.verifyCard.abort")}
          </button>
        ) : (
          onRerun && (
            <button onClick={onRerun} className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title={t("chat.verifyCard.rerunHint")} data-verify-rerun>
              {t("chat.verifyCard.rerun")}
            </button>
          )
        )}
      </div>
      <div>
        {block.commands.map((c, i) => (
          <CommandRow key={i} c={c} tabId={tabId} live={running && c.status === "running"} />
        ))}
      </div>
    </div>
  );
}
