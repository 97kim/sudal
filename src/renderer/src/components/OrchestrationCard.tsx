// 코디네이터 탭에 남는 오케스트레이션 카드 — Run 의 Task 상태·워커 탭 링크·주의(질문/에스컬레이션/통지) 수. "패널" 로 인박스를 연다.
import { useTranslation } from "react-i18next";
import type { OrchestrationBlock } from "@shared/session-state";
import { PROVIDER_NAME } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

const TASK_TONE = {
  pending: "text-muted-2",
  running: "text-accent",
  succeeded: "text-ok",
  failed: "text-err",
  abandoned: "text-warn",
} as const;

const EXEC_KEYS = ["running", "queued", "waiting_permission", "waiting_reply", "limit_wait", "idle", "error"] as const;

export function OrchestrationCard({ block, onOpen }: { block: OrchestrationBlock; onOpen: (runId: string) => void }) {
  const { t } = useTranslation();
  const attention = block.questions + block.escalations;
  return (
    <div className="content-indent rounded-lg border border-line bg-panel" data-orch-card={block.id} data-orch-status={block.status}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="list" size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium">{t("orchestration.card.title")}</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted" title={block.objective}>
          {block.objective}
        </span>
        <span className="flex-1" />
        {block.questions > 0 && (
          <span className="label text-warn" data-orch-questions={block.questions}>
            {t("orchestration.card.questions", { count: block.questions })}
          </span>
        )}
        {block.escalations > 0 && <span className="label text-err">{t("orchestration.card.escalations", { count: block.escalations })}</span>}
        {block.gates > 0 && (
          <span className="label text-warn" data-orch-gates={block.gates}>
            {t("orchestration.card.gatesWaiting", { count: block.gates })}
          </span>
        )}
        {block.status === "closed" && <span className="label text-muted-2">{t("orchestration.card.closed")}</span>}
        <button
          onClick={() => onOpen(block.id)}
          className={`rounded-md border px-2 py-0.5 text-[10.5px] ${attention > 0 ? "border-warn/40 bg-warn-bg text-warn hover:bg-warn/10" : "border-line text-muted hover:bg-panel-2 hover:text-fg"}`}
          title={t("orchestration.card.openTitle")}
          data-orch-open
        >
          {t("orchestration.card.open")}
        </button>
      </div>
      <div>
        {block.tasks.length === 0 && <div className="px-3 py-2 text-[11.5px] text-muted">{t("orchestration.card.noTasks")}</div>}
        {block.tasks.map((task) => {
          const known = task.status in TASK_TONE ? (task.status as keyof typeof TASK_TONE) : null;
          const label = known ? t(`orchestration.card.taskStatus.${known}`) : task.status;
          const tone = known ? TASK_TONE[known] : "text-muted";
          const exec = EXEC_KEYS.find((k) => k === task.execution);
          return (
            <div key={task.id} className="flex items-start gap-2 border-t border-line px-3 py-1.5 first:border-t-0" data-orch-task={task.id} data-orch-task-status={task.status}>
              <span className="mono mt-0.5 w-4 shrink-0 text-[11px] text-muted">{task.seq}</span>
              {task.provider ? <ProviderLogo provider={task.provider} size={14} className="mt-0.5 shrink-0" /> : <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[12px]" title={task.spec}>
                    {task.spec}
                  </span>
                  <span className={`label shrink-0 ${tone}`}>{task.status === "pending" && (task.blockedBy || task.blocked) ? (task.blockedBy ? (task.blockedBy.kind === "deps" ? t("cli.blocked.deps", { seqs: task.blockedBy.seqs.join(",") }) : t("cli.blocked.gates")) : task.blocked) : label}</span>
                  {task.status === "running" && exec && <span className="shrink-0 text-[10.5px] text-muted-2">{t(`orchestration.card.execution.${exec}`)}</span>}
                  <span className="flex-1" />
                  {task.tabId && (
                    <button onClick={() => void window.sudal.workspaces.activateTab(task.tabId!)} className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title={t("orchestration.card.openTabTitle", { provider: task.provider ? PROVIDER_NAME[task.provider] : "" })} data-orch-task-tab>
                      {t("orchestration.card.openTab")}
                    </button>
                  )}
                </div>
                {task.summary && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted" style={{ userSelect: "text" }}>{task.summary}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
