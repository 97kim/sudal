// 오케스트레이션 패널(오버레이): Run 목록 · Task/워커 · 인박스. 사람이 여기서 워커 질문에 답하고, 후속 지시를 보내고, 워커를 정리한다.
import { usePaneFocusRef } from "../pane-focus";
// 화면을 연 것만으로 코디네이터 Delivery 를 ack 하지 않는다(코디네이터 탭의 check 가 소비한다).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import { msgText } from "@shared/i18n/msg";
import type { OrchMessage, OrchRunState } from "@shared/orchestration";
import { attention, runSummary, taskBlockers, taskWaves } from "@shared/orchestration";
import { PROVIDER_NAME } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { cleanupState, createWorkerCleanup } from "../orch-cleanup";

const MSG_TONE: Record<OrchMessage["type"], string> = {
  question: "text-warn",
  reply: "text-muted",
  escalation: "text-err",
  worker_done: "text-ok",
  followup: "text-accent",
  note: "text-muted",
};

export function OrchestrationPanel({ initialRunId, onClose }: { initialRunId: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [runs, setRuns] = useState<OrchRunState[]>([]);
  const [selected, setSelected] = useState<string | null>(initialRunId);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [followup, setFollowup] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cleaning, setCleaning] = useState<Set<string>>(() => new Set());
  const loadVersion = useRef(0);
  const mounted = useRef(true);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showMessage = useCallback((message: { ok: boolean; text: string }) => {
    if (!mounted.current) return;
    if (messageTimer.current) clearTimeout(messageTimer.current);
    setMsg(message);
    messageTimer.current = setTimeout(() => setMsg(null), 6000);
  }, []);
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    const next = await window.sudal.orch.list();
    if (mounted.current && version === loadVersion.current) setRuns(next);
    return next;
  }, []);
  const load = useCallback(() => {
    const version = loadVersion.current + 1;
    void refresh().catch(() => {
      if (version === loadVersion.current) showMessage({ ok: false, text: t("orchestration.panel.loadFailed") });
    });
  }, [refresh, showMessage, t]);
  const cleanupAction = useMemo(() => createWorkerCleanup({
    remove: (runId, dispatchId) => window.sudal.orch.worker(runId, dispatchId, "cleanup"),
    refresh,
  }), [refresh]);
  useEffect(() => {
    mounted.current = true;
    load();
    const unsubscribe = window.sudal.orch.onChanged(load);
    return () => {
      mounted.current = false;
      loadVersion.current++;
      if (messageTimer.current) clearTimeout(messageTimer.current);
      unsubscribe();
    };
  }, [load]);
  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const run = useMemo(() => runs.find((r) => r.run.id === (selected ?? runs[0]?.run.id)) ?? null, [runs, selected]);
  const act = async (p: Promise<{ ok: true } | { ok: false; error: string }>, okText: string) => {
    const r = await p;
    showMessage(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
  };
  const cleanup = async (runId: string, dispatchId: string) => {
    if (cleanupAction.isPending(runId, dispatchId)) return;
    setCleaning((current) => new Set(current).add(dispatchId));
    const outcome = await cleanupAction.run(runId, dispatchId);
    if (!mounted.current) return;
    setCleaning((current) => { const next = new Set(current); next.delete(dispatchId); return next; });
    showMessage(outcome.kind === "confirmed"
      ? { ok: true, text: t(`orchestration.panel.cleanupMessage.${outcome.state}`) }
      : outcome.kind === "failed"
        ? { ok: false, text: outcome.error }
        : { ok: false, text: t("orchestration.panel.cleanupUnconfirmed") });
  };
  const a = run ? attention(run) : null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/60 p-5" onClick={onClose} data-orch-panel>
      <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Icon name="list" size={15} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{t("orchestration.panel.title")}</div>
            <div className="mt-0.5 text-[10.5px] text-muted">{t("orchestration.panel.description")}</div>
          </div>
          {msg && (
            <span className={`text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`} data-orch-msg={msg.ok ? "ok" : "error"}>
              {msg.text}
            </span>
          )}
          <button onClick={load} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title={t("orchestration.panel.reload")}>
            <Icon name="refresh" size={13} />
          </button>
          <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title={t("orchestration.panel.close")}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-line" data-orch-runs>
            {runs.length === 0 && <div className="px-3 py-3 text-[11.5px] text-muted">{t("orchestration.panel.noRuns")}</div>}
            {runs.map((r) => {
              const at = attention(r);
              return (
                <button key={r.run.id} onClick={() => setSelected(r.run.id)} className={`flex flex-col gap-0.5 border-b border-line px-3 py-2 text-left ${run?.run.id === r.run.id ? "bg-accent-tint" : "hover:bg-panel-2"}`} data-orch-run={r.run.id}>
                  <span className="truncate text-[12px]">{r.run.objective}</span>
                  <span className="mono text-[10px] text-muted-2">
                    {r.run.id} · {r.run.coordinator.kind === "tab" ? t("orchestration.panel.coordinatorTab") : t("orchestration.panel.coordinatorHuman")} · {r.run.status === "closed" ? t("orchestration.panel.runClosed") : runSummary(t, r)}
                    {at.questions.length > 0 ? ` · ${t("orchestration.panel.questionCount", { count: at.questions.length })}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {run ? (
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2">
                <span className="text-[13px] font-medium">{run.run.objective}</span>
                <span className="mono text-[10.5px] text-muted-2">{run.run.id}</span>
                <span className="flex-1" />
                {run.run.coordinator.kind === "tab" && run.run.status === "active" && (
                  <button onClick={() => void act(window.sudal.orch.takeover(run.run.id), t("orchestration.panel.takeoverDone"))} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title={t("orchestration.panel.takeoverTitle")} data-orch-takeover>
                    {t("orchestration.panel.takeover")}
                  </button>
                )}
                {run.run.status === "active" && (
                  <button onClick={() => void act(window.sudal.orch.close(run.run.id), t("orchestration.panel.closeRunDone"))} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-close>
                    {t("orchestration.panel.closeRun")}
                  </button>
                )}
              </div>
              <div className="border-b border-line px-4 py-2">
                <div className="label mb-1 text-muted">{t("orchestration.panel.tasksAndWorkers")}</div>
                {(() => { const waves = taskWaves(run); const maxWave = Math.max(0, ...waves.values()); return run.tasks.map((task) => { const wave = waves.get(task.id) ?? 1;
                  const ds = run.dispatches.filter((d) => d.taskId === task.id);
                  const b = taskBlockers(run, task);
                  const gates = run.gates.filter((g) => g.taskId === task.id);
                  return (
                    <div key={task.id} className="mb-1.5 rounded-md border border-line" data-orch-panel-task={task.id}>
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="mono text-[11px] text-muted">{task.seq}</span>
                        {maxWave > 1 && <span className="mono rounded bg-inset px-1 text-[10px] text-muted-2" title={t("orchestration.panel.waveTitle")} data-orch-wave={wave}>W{wave}</span>}
                        <span className="min-w-0 flex-1 truncate text-[12px]" title={task.spec}>
                          {task.spec.split("\n")[0]}
                        </span>
                        {task.deps.length > 0 && (
                          <span className="mono text-[10px] text-muted-2" title={t("orchestration.panel.depsTitle", { deps: task.deps.join(", ") })}>
                            ← {task.deps.map((id) => run.tasks.find((x) => x.id === id)?.seq ?? "?").join(",")}
                          </span>
                        )}
                        {task.status === "pending" && b.unmetDeps.length > 0 && <span className="label text-muted-2">{t("orchestration.panel.waitingDeps")}</span>}
                        {task.status === "pending" && b.pendingGates.length > 0 && <span className="label text-warn">{t("orchestration.panel.waitingGate")}</span>}
                        <span className={`label ${task.status === "succeeded" ? "text-ok" : task.status === "failed" || task.status === "abandoned" ? "text-err" : task.status === "running" ? "text-accent" : "text-muted-2"}`}>{t(`orchestration.panel.taskStatus.${task.status}`)}</span>
                      </div>
                      {gates.map((g) => (
                        <div key={g.id} className="flex flex-wrap items-center gap-2 border-t border-line bg-warn-bg/40 px-2.5 py-1 text-[11.5px]" data-orch-gate={g.id} data-orch-gate-resolved={g.resolution ? "true" : "false"}>
                          <span className="label text-warn">{t("orchestration.panel.gate")}</span>
                          <span className="min-w-0 flex-1">{g.question}</span>
                          {g.resolution ? (
                            <span className="text-ok">{t("orchestration.panel.gateResolved", { choice: g.resolution.choice })}</span>
                          ) : (
                            g.options.map((o) => (
                              <button key={o} onClick={() => void act(window.sudal.orch.gate(run.run.id, g.id, o), t("orchestration.panel.gateDecided", { choice: o }))} className="rounded-md border border-warn/40 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/10" data-orch-gate-option={o}>
                                {o}
                              </button>
                            ))
                          )}
                        </div>
                      ))}
                      {ds.map((d) => (
                        <div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-1 text-[11.5px]" data-orch-dispatch={d.id} data-orch-dispatch-status={d.status}>
                          <ProviderLogo provider={d.provider} size={13} />
                          <span className="text-muted">
                            {t("orchestration.panel.dispatchLine", {
                              provider: PROVIDER_NAME[d.provider],
                              attempt: d.attempt,
                              status: t(`orchestration.panel.dispatchStatus.${d.status}`),
                              execution: d.status === "live" ? t("orchestration.panel.dispatchExecution", { state: t(`orchestration.panel.execution.${d.execution.state}`) }) : "",
                              ownership: t(`orchestration.panel.ownership.${d.ownership}`),
                            })}
                          </span>
                          {d.worktree && <span className="mono text-[10px] text-muted-2">worktree</span>}
                          <span className="flex-1" />
                          {d.tabId && (
                            <button onClick={() => void window.sudal.workspaces.activateTab(d.tabId)} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg">
                              {t("orchestration.panel.openTab")}
                            </button>
                          )}
                          {(d.status === "live" || d.status === "reported") && (
                            <button onClick={() => void act(window.sudal.orch.worker(run.run.id, d.id, "stop"), t("orchestration.panel.stopRequested"))} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-err/10 hover:text-err" data-orch-worker-stop>
                              {t("orchestration.panel.stop")}
                            </button>
                          )}
                          {d.status === "live" && d.execution.state !== "running" && d.execution.state !== "queued" && d.execution.state !== "waiting_permission" && (
                            <button onClick={() => void act(window.sudal.orch.worker(run.run.id, d.id, "abandon"), t("orchestration.panel.abandonDone"))} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-warn/10 hover:text-warn" data-orch-worker-abandon>
                              {t("orchestration.panel.abandon")}
                            </button>
                          )}
                          {(d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start") && !d.cleaned && d.tabId && (
                            <button onClick={() => void cleanup(run.run.id, d.id)} disabled={cleaning.has(d.id)} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-err/10 hover:text-err disabled:opacity-40" title={d.worktree ? t("orchestration.panel.cleanupWorktreeTitle") : t("orchestration.panel.cleanupTabTitle")} data-orch-worker-cleanup>
                              {cleaning.has(d.id) ? t("orchestration.panel.cleanupWorking") : d.worktree ? t("orchestration.panel.deleteWorktree") : t("orchestration.panel.closeTab")}
                            </button>
                          )}
                          {(d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start") && !d.cleaned && d.tabId && d.worktree && (
                            <span className="text-[10.5px] text-warn">{t("orchestration.panel.cleanupWarning")}</span>
                          )}
                          {d.cleaned && <span className="text-[10px] text-muted-2">{t(`orchestration.panel.cleanupLabel.${cleanupState(d.cleaned)}`)}</span>}
                          {d.status === "settled" && d.ownership === "supervised" && (
                            <>
                              <button onClick={() => void act(window.sudal.orch.worker(run.run.id, d.id, "retain"), t("orchestration.panel.retainDone"))} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-worker-retain>
                                {t("orchestration.panel.retain")}
                              </button>
                              <button onClick={() => void act(window.sudal.orch.worker(run.run.id, d.id, "release"), t("orchestration.panel.releaseDone"))} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-worker-release>
                                {t("orchestration.panel.release")}
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                      {ds.some((d) => d.status === "live") && (
                        <div className="flex items-center gap-2 border-t border-line px-2.5 py-1">
                          <input
                            value={followup[task.id] ?? ""}
                            onChange={(e) => setFollowup((m) => ({ ...m, [task.id]: e.target.value }))}
                            placeholder={t("orchestration.panel.followupPlaceholder")}
                            className="min-w-0 flex-1 rounded border border-line bg-inset px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                            data-orch-followup-input
                          />
                          <button
                            onClick={() => {
                              const live = ds.find((d) => d.status === "live");
                              const body = (followup[task.id] ?? "").trim();
                              if (!live || !body) return;
                              void act(window.sudal.orch.followup(run.run.id, live.id, body), t("orchestration.panel.followupSent")).then(() => setFollowup((m) => ({ ...m, [task.id]: "" })));
                            }}
                            className="rounded border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
                            data-orch-followup-send
                          >
                            {t("orchestration.panel.send")}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }); })()}
              </div>
              <div className="px-4 py-2">
                <div className="label mb-1 text-muted">
                  {a && a.questions.length > 0 ? t("orchestration.panel.inboxWaiting", { count: a.questions.length }) : t("orchestration.panel.inbox")}
                </div>
                {run.messages.length === 0 && <div className="text-[11.5px] text-muted">{t("orchestration.panel.noMessages")}</div>}
                {run.messages
                  .slice()
                  .reverse()
                  .map((m) => {
                    const task = run.tasks.find((x) => x.id === m.taskId);
                    return (
                      <div key={m.id} className="mb-1.5 rounded-md border border-line px-2.5 py-1.5" data-orch-message={m.id} data-orch-message-type={m.type}>
                        <div className="flex items-center gap-2 text-[10.5px] text-muted-2">
                          <span className={`label ${MSG_TONE[m.type]}`}>{t(`orchestration.panel.messageType.${m.type}`)}</span>
                          <span>{t(`orchestration.panel.actor.${m.from.kind}`)}</span>
                          {task && <span>· {t("orchestration.panel.taskRef", { seq: task.seq })}</span>}
                          {m.outcome && <span className={m.outcome === "succeeded" ? "text-ok" : "text-err"}>· {m.outcome === "succeeded" ? t("orchestration.panel.taskStatus.succeeded") : t("orchestration.panel.taskStatus.failed")}</span>}
                          <span className="flex-1" />
                          <span className="mono">{new Date(m.ts).toLocaleTimeString(intlLocale(i18n.language as Locale), { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                        <div className="mt-0.5 whitespace-pre-wrap text-[12px]" style={{ userSelect: "text" }}>
                          {msgText(i18n, m.bodyMsg, m.body) || m.subject}
                        </div>
                        {m.filesModified && m.filesModified.length > 0 && <div className="mono mt-0.5 text-[10.5px] text-muted-2">{m.filesModified.join(", ")}</div>}
                        {m.type === "question" && !m.answer && (
                          <div className="mt-1.5 flex flex-col gap-1" data-orch-answer={m.id}>
                            {m.options && m.options.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {m.options.map((o) => (
                                  <button key={o} onClick={() => void act(window.sudal.orch.reply(run.run.id, m.id, o), t("orchestration.panel.answerSent"))} className="rounded-md border border-accent/40 bg-accent-tint px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent/15" data-orch-answer-option={o}>
                                    {o}
                                  </button>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <input
                                value={answers[m.id] ?? ""}
                                onChange={(e) => setAnswers((s) => ({ ...s, [m.id]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && (answers[m.id] ?? "").trim()) void act(window.sudal.orch.reply(run.run.id, m.id, answers[m.id].trim()), t("orchestration.panel.answerSent"));
                                }}
                                placeholder={t("orchestration.panel.answerPlaceholder")}
                                className="min-w-0 flex-1 rounded border border-line bg-inset px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                                data-orch-answer-input
                              />
                              <button onClick={() => (answers[m.id] ?? "").trim() && void act(window.sudal.orch.reply(run.run.id, m.id, answers[m.id].trim()), t("orchestration.panel.answerSent"))} className="rounded border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-answer-send>
                                {t("orchestration.panel.answerSend")}
                              </button>
                            </div>
                          </div>
                        )}
                        {m.type === "question" && m.answer && (
                          <div className="mt-1 text-[11.5px] text-ok" data-orch-answered>
                            {t("orchestration.panel.answered", { body: m.answer.body })} <span className="text-muted-2">({t(`orchestration.panel.actor.${m.answer.by.kind}`)})</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted">{t("orchestration.panel.pickRun")}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
