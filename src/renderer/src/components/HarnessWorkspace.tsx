import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { harnessCriterionStatus, type HarnessAction, type HarnessSnapshot, type HarnessTask } from "@shared/harness";
import type { Block, VerifyBlock } from "@shared/session-state";
import { userErrorMessage } from "@shared/error-message";
import { conversationConfirmations, conversationVerificationLinks, harnessBlockBefore, harnessProposalBlock, harnessReadyBlock } from "../harness-conversation";
import { Icon } from "./Icon";
import { HarnessPanel } from "./HarnessPanel";
import { VerifyCard } from "./VerifyCard";
import { sameCwdOrNull } from "@shared/any-path";
import { hasModalDialog } from "./Modal";
import { usePaneFocusRef } from "../pane-focus";

const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const secondary = "inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-40";
const primary = `${secondary} bg-panel-2 text-fg`;
const input = "w-full rounded-md border border-line bg-inset px-2.5 py-2 text-xs leading-5 outline-none focus:border-accent/50";

/** One controller owns the bar, conversation actions and task detail panel. */
export function HarnessWorkspace({ tabId, cwd, blocks, conversationSlot, detailSlot, detailActive, homeRequest, onOpenDetails, onCloseDetails }: {
  tabId: string; cwd: string; blocks: Block[]; conversationSlot: ReadonlyMap<string, HTMLElement>; detailSlot: HTMLElement | null; detailActive: boolean; homeRequest: number; onOpenDetails: () => void; onCloseDetails: () => void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`chat.harness.${key}` as never) as string;
  const ui = (key: string, args?: Record<string, unknown>) => String(t(`chat.harnessFlow.${key}` as never, args as never));
  const resultLabel = (status: VerifyBlock["status"]) => ui(status === "passed" ? "resultPassed" : status === "failed" ? "resultFailed" : "resultAborted");
  const [snapshot, setSnapshot] = useState<HarnessSnapshot | null>(null);
  const [popover, setPopover] = useState(false);
  const [view, setView] = useState<"task" | "settings" | "history" | "start" | "edit" | "finish" | "link" | null>("task");
  const [linkTarget, setLinkTarget] = useState<{ taskId: string; runId: string; criteria: { id: string; revision: number }[] } | null>(null);
  const [linkSelection, setLinkSelection] = useState<string[]>([]);
  const [selection, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [noteTarget, setNoteTarget] = useState<{ taskId: string; criterionId: string; revision: number } | null>(null);
  const [editTarget, setEditTarget] = useState<{ taskId: string; criteria: { id: string; revision: number }[] } | null>(null);
  const [finishTarget, setFinishTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [commands, setCommands] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState<{ id?: string; description: string; method: string }[]>([]);
  const [autoRepair, setAutoRepair] = useState(false);
  const [checkMode, setCheckMode] = useState<"evidence" | "manual" | "command">("evidence");
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const error = actionError || refreshError;
  const hiddenKey = `sudal:harness-hidden:${tabId}:${cwd}`;
  const [hiddenSuggestions, setHiddenSuggestions] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(hiddenKey) ?? "[]"); return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string").slice(-100) : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(hiddenKey, JSON.stringify(hiddenSuggestions.slice(-100))); } catch { /* UI preferences must not prevent task actions. */ } }, [hiddenKey, hiddenSuggestions]);
  const controller = useRef({ alive: true, sequence: 0, mutating: false, refreshing: false, refreshAgain: false });
  const top = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const focusRequested = useRef(false);
  const paneFocus = usePaneFocusRef();
  const popId = useId(), panelId = useId();
  const refresh = useCallback(async (): Promise<void> => {
    const owner = controller.current;
    if (owner.mutating || owner.refreshing) { owner.refreshAgain = true; return; }
    owner.refreshing = true;
    const sequence = ++owner.sequence;
    try {
      const value = await window.sudal.chat.harness(tabId, { type: "snapshot" });
      if (owner.alive && sequence === owner.sequence && !owner.mutating) { setSnapshot(value); setRefreshError(""); }
    } catch (err) { if (owner.alive && sequence === owner.sequence) setRefreshError(userErrorMessage(err)); }
    finally {
      owner.refreshing = false;
      if (owner.alive && owner.refreshAgain && !owner.mutating) { owner.refreshAgain = false; void refresh(); }
    }
  }, [tabId]);
  useEffect(() => {
    controller.current.alive = true;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden" && document.hasFocus()) void refresh(); }, 5000);
    const focus = () => void refresh();
    const off = window.sudal.chat.onHarnessChanged(focus);
    window.addEventListener("focus", focus);
    return () => { controller.current.alive = false; controller.current.sequence++; clearInterval(timer); off(); window.removeEventListener("focus", focus); };
  }, [refresh]);
  // Terminal blocks also change after evidence writes; polling covers writes that follow the event itself.
  const latestBlock = blocks.at(-1);
  useEffect(() => { if (latestBlock?.kind === "turn" || latestBlock?.kind === "verify" || latestBlock?.kind === "review" || latestBlock?.kind === "text" && !latestBlock.streaming) void refresh(); }, [latestBlock, refresh]);
  const dispatch = async (action: HarnessAction): Promise<HarnessSnapshot> => {
    const owner = controller.current;
    if (owner.mutating) throw new Error(ui("busy"));
    owner.mutating = true; owner.sequence++;
    setBusy(true); setError("");
    try {
      const value = await window.sudal.chat.harness(tabId, (action.type === "status" && action.status === "completed" || action.type === "confirm" || action.type === "linkVerification") ? { ...action, afterBlockId: blocks.at(-1)?.id } : action);
      if (owner.alive) { setSnapshot(value); setRefreshError(""); }
      return value;
    } catch (err) {
      if (owner.alive) {
        const message = userErrorMessage(err);
        setError(message.includes("Completion requires a reason") ? label("reasonRequired") : message.includes("trusted") ? label("trustRequired") : message.includes("Task criteria changed") ? ui("criteriaChanged") : message);
      }
      throw err;
    } finally {
      owner.mutating = false;
      if (owner.alive) {
        setBusy(false);
        if (owner.refreshAgain) { owner.refreshAgain = false; void refresh(); }
      }
    }
  };
  const act = async (action: HarnessAction) => { try { await dispatch(action); return true; } catch { return false; } };
  const task = snapshot?.tasks.find(item => item.tabId === tabId && item.status === "active");
  const paused = !task ? snapshot?.tasks.findLast(item => item.tabId === tabId && item.status === "paused") : undefined;
  const shownTask = task ?? paused;
  const selected = selection.filter(id => shownTask?.criteria.some(item => item.id === id));
  const noteCriterion = selected.length === 1 ? task?.criteria.find(item => item.id === selected[0]) : undefined;
  const noteValid = !!task && !!noteCriterion && noteTarget?.taskId === task.id && noteTarget.criterionId === noteCriterion.id && noteTarget.revision === noteCriterion.revision;
  const editConflict = view === "edit" && (!task || task.id !== editTarget?.taskId || JSON.stringify(task.criteria.map(({ id, revision }) => ({ id, revision }))) !== JSON.stringify(editTarget.criteria));
  const completions = snapshot?.tasks.filter(item => item.tabId === tabId && item.status === "completed") ?? [];
  const liveVerify = blocks.findLast((block): block is VerifyBlock => block.kind === "verify" && block.status === "running");
  const statusOf = (item: NonNullable<typeof task>["criteria"][number], owner = shownTask!) => harnessCriterionStatus(owner, item, snapshot?.revision);
  const passed = task?.criteria.filter(item => statusOf(item) === "passed").length ?? 0;
  const allPassed = !!task && passed === task.criteria.length && task.criteria.length > 0;
  const confirmationCandidates = useMemo(() => task ? conversationConfirmations(blocks, task) : [], [blocks, task]);
  const suggestions = confirmationCandidates.filter(item => !hiddenSuggestions.includes(`${item.blockId}:${item.criterionId}`));
  const verifications = blocks.filter((block): block is VerifyBlock => block.kind === "verify" && block.status !== "running" && sameCwdOrNull(block.cwd, cwd)).slice(-10).reverse();
  const latestVerification = verifications[0];
  const linkCandidates = useMemo(() => task ? conversationVerificationLinks(blocks, task, cwd) : [], [blocks, task, cwd]);
  const recommendation = linkCandidates.findLast(item => item.runId === latestVerification?.id);
  const verificationKey = latestVerification ? `verification:${latestVerification.id}:${recommendation?.blockId ?? "result"}` : undefined;
  const candidate = task && !liveVerify && latestVerification && !hiddenSuggestions.includes(verificationKey!) &&
    (recommendation || !snapshot?.tasks.some(owner => owner.evidence.some(item => item.source === "command" && item.reference === latestVerification.id))) ? latestVerification : undefined;
  const hideVerifications = () => { if (verificationKey) setHiddenSuggestions(previous => [...new Set([...previous, verificationKey])]); };
  const candidateProposal = candidate && recommendation?.runId === candidate.id ? recommendation : undefined;
  const linkRun = verifications.find(block => block.id === linkTarget?.runId);
  const linkConflict = !!linkTarget && (!task || task.id !== linkTarget.taskId || JSON.stringify(task.criteria.map(({ id, revision }) => ({ id, revision }))) !== JSON.stringify(linkTarget.criteria));
  useEffect(() => { setSelected([]); setNote(""); setReason(""); setCommands(null); setAutoRepair(false); }, [shownTask?.id]);
  const showTask = () => { setView("task"); setError(""); void refresh(); };
  const closePanel = () => {
    focusRequested.current = false;
    if (view !== "task") { showTask(); return; }
    setError(""); onCloseDetails(); void refresh();
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  };
  useEffect(() => { if (homeRequest) { setView("task"); setError(""); } }, [homeRequest]);
  const openPanel = (next: NonNullable<typeof view>) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusRequested.current = true;
    setPopover(false); setError(""); setView(next); onOpenDetails();
  };
  useEffect(() => {
    if (focusRequested.current && view && detailActive && paneFocus.current && !hasModalDialog() && panel.current) {
      panel.current.focus(); focusRequested.current = false;
    }
  });
  useEffect(() => {
    if (!popover && !detailActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !paneFocus.current || hasModalDialog()) return;
      if (popover) {
        if (!top.current?.contains(event.target as Node)) return;
        event.stopPropagation();
        setPopover(false);
        top.current?.querySelector<HTMLButtonElement>("[data-harness-status]")?.focus();
      } else if (view && detailActive && panel.current?.contains(event.target as Node)) { event.stopPropagation(); closePanel(); }
    };
    const outside = (event: PointerEvent) => { if (popover && !top.current?.contains(event.target as Node)) setPopover(false); };
    document.addEventListener("keydown", onKey); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", outside); };
  }, [popover, view, detailActive]);
  const startEditor = (proposal = snapshot?.proposal) => {
    setEditTarget(null);
    setGoal(proposal?.goal ?? ""); setCriteria(proposal?.criteria.map(item => ({ ...item })) ?? [{ description: "", method: "" }]); openPanel("start");
  };
  const openCriterion = (id: string) => { setSelected([id]); setNote(""); setCheckMode("evidence"); openPanel("task"); };
  const selectCriterion = (id: string) => {
    setNote("");
    if (task && checkMode === "command") setSelected(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]);
    else if (task && checkMode === "manual") setSelected([id]);
    else setSelected(selected.includes(id) ? selected.filter(item => item !== id) : [id]);
  };
  const openEvidence = () => { setCheckMode("evidence"); if (!selected.length && shownTask?.criteria[0]) setSelected([shownTask.criteria[0].id]); openPanel("task"); };
  const chooseVerification = (runId: string, ids: string[] = []) => {
    if (!task) return;
    setLinkTarget({ taskId: task.id, runId, criteria: task.criteria.map(({ id, revision }) => ({ id, revision })) });
    setLinkSelection(ids);
  };
  const openLink = (runId?: string, ids: string[] = []) => { setLinkTarget(null); setLinkSelection([]); if (runId) chooseVerification(runId, ids); openPanel("link"); };
  const finish = async () => {
    if (!task) return;
    if (!allPassed) { setFinishTarget(task.id); setReason(""); openPanel("finish"); return; }
    if (await act({ type: "status", taskId: task.id, status: "completed" })) showTask();
  };
  const editTask = () => {
    if (!task) return;
    setEditTarget({ taskId: task.id, criteria: task.criteria.map(({ id, revision }) => ({ id, revision })) });
    setCriteria(task.criteria.map(({ id, description, method }) => ({ id, description, method })));
    openPanel("edit");
  };
  const saveTask = async () => {
    if (view === "edit") {
      if (editConflict || !editTarget) { setError(ui("criteriaChanged")); return; }
      if (await act({ type: "edit", taskId: editTarget.taskId, criteria, expectedCriteria: editTarget.criteria })) { setSelected([]); showTask(); }
    } else if (view === "start" && await act({ type: "start", goal, criteria })) showTask();
  };
  const card = "min-w-0 space-y-4 rounded-xl border border-line bg-panel p-4 text-sm [overflow-wrap:anywhere]";
  const taskRows = (owner: HarnessTask, selectable = false, inline = false) => owner.criteria.map(item => {
    const status = statusOf(item, owner);
    return <div key={item.id}><div className={`-mx-2 flex items-start gap-2.5 rounded-md px-2 py-2.5 transition-colors ${selected.includes(item.id) ? "bg-panel-2" : "hover:bg-panel-2/50"}`}>
      {selectable && <input type="checkbox" className="mt-1 accent-accent" aria-label={item.description} checked={selected.includes(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />}
      <Icon name={status === "passed" ? "check" : status === "failed" ? "alert" : status === "stale" ? "refresh" : "clock"} size={15} className={`mt-0.5 shrink-0 ${status === "passed" ? "text-ok" : status === "failed" ? "text-err" : "text-muted"}`} />
      <button className="min-w-0 flex-1 text-left" aria-pressed={selected.includes(item.id)} onClick={() => inline ? selectCriterion(item.id) : openCriterion(item.id)}><span className="break-words text-xs leading-5">{item.description}</span><span className="mt-0.5 block text-[11px] text-muted">{label(status)}{(!inline || checkMode === "command") && item.method ? ` · ${item.method}` : ""}</span></button>
      <Icon name="chevronRight" size={13} className="mt-1 shrink-0 text-muted" />
    </div>
    {inline && selected.includes(item.id) && (!task || checkMode !== "command") && <div className="mb-2 ml-1.5 space-y-3 border-l border-line pb-3 pl-5" data-harness-criterion-detail>
      {item.method && <p className="text-[11px] leading-5 text-muted">{item.method}</p>}
      {owner.evidence.filter(e => e.criterionId === item.id).length === 0 && <p className="text-[11px] text-muted">{ui("noEvidence")}</p>}
      {owner.evidence.filter(e => e.criterionId === item.id).map(e => <div className="space-y-1 text-xs" key={e.id}><span className="text-[10px] text-muted">{label(e.source)} · {label(e.result)}</span><p className="break-words whitespace-pre-wrap leading-5">{e.reference}</p></div>)}
    </div>}
    </div>;
  });
  const conversation = snapshot?.enabled && !!(snapshot.proposal || suggestions.length || candidate || allPassed || completions.length || error) && <div className="space-y-4" data-harness-conversation>
    {candidate && <section className={card} data-harness-link-suggestion data-harness-anchor={candidateProposal?.blockId ?? candidate.id}>
      <span className="text-xs text-muted">{ui("linkResult")}</span>
      <h3 className="font-medium">{resultLabel(candidate.status)}</h3>
      <p className="mono break-words text-xs text-muted">{candidate.commands.map(command => command.cmd).join(" · ")}</p>
      <time className="block text-[11px] text-muted">{new Date(candidate.endedAt ?? candidate.ts).toLocaleString()}</time>
      {candidateProposal ? <><p className="text-xs text-muted">{ui("linkProposalHint")}</p><ul className="space-y-1 text-xs">{candidateProposal.criteria.map(item => <li key={item.id}>{task!.criteria.find(criterion => criterion.id === item.id)?.description}</li>)}</ul>{(!candidate.codeRevision || candidate.codeRevision !== snapshot?.revision) && <p className="text-xs text-warn">{ui("linkStaleHint")}</p>}</> : <p className="text-xs text-muted">{ui("linkHint")}</p>}
      <div className="flex flex-wrap gap-2">
        {candidateProposal && <button className={primary} disabled={busy} onClick={() => void act({ type: "linkVerification", taskId: task!.id, runId: candidate.id, criteria: candidateProposal.criteria }).then(ok => { if (ok) hideVerifications(); })}>{ui("linkResult")}</button>}
        <button className={candidateProposal ? secondary : primary} disabled={busy} onClick={() => openLink(candidate.id, candidateProposal?.criteria.map(item => item.id))}>{ui("chooseLinkCriteria")}</button>
        <button className={secondary} onClick={hideVerifications}>{label("dismiss")}</button>
      </div>
    </section>}
    {snapshot.proposal && <section className={card} data-harness-proposal data-harness-anchor={harnessProposalBlock(blocks, snapshot.proposal)}><span className="text-xs text-accent">{label("proposal")}</span><h3 className="font-medium">{snapshot.proposal.goal}</h3><ul className="space-y-2 text-xs text-muted">{snapshot.proposal.criteria.map((item, i) => <li key={i} className="flex gap-2"><span>○</span><span>{item.description}</span></li>)}</ul><div className="flex flex-wrap gap-2"><button className={primary} disabled={busy} onClick={() => void act({ type: "start", ...snapshot.proposal! })}>{ui("accept")}</button><button className={secondary} disabled={busy} onClick={() => startEditor()}>{label("edit")}</button><button className="px-2 text-xs text-muted hover:text-fg" disabled={busy} onClick={() => void act({ type: "dismiss" })}>{label("dismiss")}</button></div><p className="text-xs text-muted">{task ? ui("replaceHint") : ui("proposalHint")}</p></section>}
    {suggestions.map(item => <section className={card} key={`${item.blockId}:${item.criterionId}`} data-harness-confirmation data-harness-anchor={item.blockId}><span className="text-xs text-accent">{ui("confirmationSuggestion")}</span><h3>{task!.criteria.find(c => c.id === item.criterionId)?.description}</h3><blockquote className="border-l-2 border-accent/40 pl-3 text-sm text-muted whitespace-pre-wrap">{item.quote}</blockquote><p className="text-xs text-muted">{ui("confirmationHint")}</p><div className="flex gap-2"><button className={primary} disabled={busy} onClick={() => void act({ type: "confirm", taskId: task!.id, criterionId: item.criterionId, criterionRevision: item.criterionRevision, note: item.quote, confirmationBlockId: item.blockId })}>{ui("saveConfirmation")}</button><button className={secondary} onClick={() => setHiddenSuggestions([...hiddenSuggestions, `${item.blockId}:${item.criterionId}`])}>{label("dismiss")}</button></div></section>)}
    {allPassed && <section className={card} data-harness-ready data-harness-anchor={harnessReadyBlock(blocks, task)}><div className="flex gap-2 text-ok"><Icon name="check" size={17} /><h3>{ui("ready")}</h3></div><p className="text-xs text-muted">{task.goal} · {ui("progress", { count: passed, total: task.criteria.length })}</p><div className="flex gap-2"><button className={primary} disabled={busy} onClick={() => void finish()}>{label("complete")}</button><button className={secondary} onClick={openEvidence}>{label("evidence")}</button></div></section>}
    {completions.map(completed => <section key={completed.id} className={`${card} text-muted`} data-harness-completed data-harness-anchor={completed.completedAfterBlockId ?? harnessBlockBefore(blocks, completed.completedAt)}><span className="flex items-center gap-2 text-xs"><Icon name="check" size={14} />{label("completed")}</span><h3 className="text-fg">{completed.goal}</h3><p className="text-xs">{ui("evidenceKept")}</p>{completed.completionReason && <p className="text-xs whitespace-pre-wrap">{completed.completionReason}</p>}<button className={secondary} onClick={() => openPanel("history")}>{ui("completionRecord")}</button></section>)}
    {error && <p className="text-xs text-err" role="alert">{error}</p>}
  </div>;
  if (!cwd) return null;
  return <>
    <section ref={top} className="relative z-20 shrink-0 border-b border-line bg-panel/60 text-xs" data-harness-panel data-harness-workspace>
      <div className="flex h-11 min-w-0 items-center gap-2 px-4">
        <button data-harness-status className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!snapshot} aria-expanded={popover} aria-controls={popId} onClick={() => snapshot?.enabled && shownTask ? setPopover(!popover) : snapshot?.enabled ? startEditor() : openPanel("settings")}>
          <Icon name={snapshot?.enabled && shownTask ? "list" : "plus"} size={13} className="shrink-0 text-muted" /><span className="shrink-0 text-muted">{!snapshot ? label("loading") : !snapshot.enabled ? ui("off") : paused ? label("paused") : task ? ui("currentTask") : ui("noTask")}</span>
          {snapshot?.enabled && shownTask && <><span className="truncate">{shownTask.goal}</span><span className="ml-auto shrink-0 text-accent">{task ? liveVerify ? ui("verifying") : allPassed ? ui("readyShort") : task.criteria.some(item => statusOf(item) === "failed") ? label("failed") : task.criteria.some(item => statusOf(item) === "stale") ? label("stale") : ui("remaining", { count: task.criteria.length - passed }) : label("resume")}</span><Icon name="chevronDown" size={12} /></>}
        </button>
        {snapshot?.enabled && !shownTask && <button className="shrink-0 px-2 text-muted hover:text-fg" disabled={busy} onClick={() => startEditor()}>{label("start")}</button>}
        <button className="shrink-0 rounded p-1.5 text-muted hover:bg-panel-2 hover:text-fg" title={label("history")} aria-label={label("history")} onClick={() => openPanel("history")}><Icon name="clock" size={14} /></button>
        <button className="shrink-0 rounded p-1.5 text-muted hover:bg-panel-2 hover:text-fg" title={ui("settings")} aria-label={ui("settings")} onClick={() => openPanel("settings")}><Icon name="settings" size={14} /></button>
      </div>
      {popover && snapshot?.enabled && shownTask && <div id={popId} className="absolute left-3 right-3 top-full mt-1 max-h-[60vh] max-w-md overflow-auto rounded-xl border border-line bg-panel p-4 shadow-2xl" data-harness-popover><div className="flex items-center justify-between gap-3"><span className="text-muted">{ui("currentTask")}</span><button aria-label={ui("close")} onClick={() => setPopover(false)}><Icon name="x" size={14} /></button></div><h3 className="mb-2 mt-2 break-words text-sm font-medium">{shownTask.goal}</h3>{taskRows(shownTask)}<div className="mt-4 flex flex-wrap gap-2">{paused ? <button className={primary} disabled={busy} onClick={() => void act({ type: "status", taskId: paused.id, status: "active" })}>{label("resume")}</button> : <><button className={primary} disabled={busy} onClick={() => allPassed ? void finish() : (setSelected([]), setCheckMode("command"), openPanel("task"))}>{allPassed ? label("complete") : ui("checkCriteria")}</button><button className={secondary} onClick={openEvidence}>{label("evidence")}</button></>}<button className={secondary} onClick={() => openPanel("task")}>{ui("more")}</button></div></div>}
      {error && !detailActive && <p className="px-4 pb-2 text-xs text-err" role="alert">{error}</p>}
    </section>
    {conversation && Children.toArray(conversation.props.children).map((child, index) => {
      if (!isValidElement<{ "data-harness-anchor"?: string; role?: string }>(child)) return null;
      const anchor = child.props["data-harness-anchor"] ?? (child.props.role === "alert" ? blocks.at(-1)?.id : undefined);
      const slot = anchor && conversationSlot.get(anchor);
      return slot ? createPortal(<div data-harness-conversation>{child as ReactNode}</div>, slot, String(child.key ?? index)) : null;
    })}
    {detailSlot && view && createPortal(<aside ref={panel} tabIndex={-1} id={panelId} aria-label={view === "settings" ? ui("settings") : view === "link" ? ui("linkResult") : ui("currentTask")} className="pointer-events-auto flex h-full w-full min-w-0 flex-col bg-panel outline-none" data-harness-detail>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4"><Icon name={view === "settings" ? "settings" : view === "history" ? "clock" : "list"} size={14} className="text-muted" /><h2 className="min-w-0 flex-1 text-xs font-medium">{view === "settings" ? ui("settings") : view === "history" ? label("history") : view === "start" ? label("start") : view === "edit" ? label("edit") : view === "finish" ? label("complete") : view === "link" ? ui("linkResult") : ui("taskDetails")}</h2><button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label={ui("close")} onClick={closePanel}><Icon name="x" size={14} /></button></header>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4 text-xs">
        {error && <p className="whitespace-pre-wrap text-xs text-err" role="alert">{error}</p>}
        {view === "settings" && <HarnessPanel tabId={tabId} cwd={cwd} settingsOnly controller={{ snapshot, dispatch }} />}
        {view === "link" && !task && <p className="text-xs text-muted">{ui("noTask")}</p>}
        {view === "link" && task && <section className="space-y-4" data-harness-link-editor>
          <p className="text-xs leading-5 text-muted">{ui("linkHint")}</p>
          {!linkRun ? <div className="space-y-2">{verifications.length === 0 && <p className="text-muted">{ui("noLinkResults")}</p>}{verifications.map(run => <button key={run.id} className={secondary + " w-full justify-start text-left"} onClick={() => chooseVerification(run.id)}><span>{label(run.status === "passed" ? "passed" : run.status === "failed" ? "failed" : "unconfirmed")}</span><span className="mono min-w-0 truncate">{run.commands.map(command => command.cmd).join(" · ")}</span></button>)}</div> : <>
            <div className="space-y-2 rounded-md border border-line p-3"><p className="font-medium">{label(linkRun.status === "passed" ? "passed" : linkRun.status === "failed" ? "failed" : "unconfirmed")}</p><pre className="mono whitespace-pre-wrap break-words text-xs">{linkRun.commands.map(command => command.cmd).join("\n")}</pre><details><summary className="cursor-pointer text-xs text-muted">{ui("resultOutput")}</summary><pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{linkRun.commands.map(command => command.output ?? "").join("\n")}</pre></details><button className="text-xs text-muted hover:text-fg" onClick={() => { setLinkTarget(null); setLinkSelection([]); }}>{ui("changeResult")}</button></div>
            {(!linkRun.codeRevision || linkRun.codeRevision !== snapshot?.revision) && <p className="text-xs leading-5 text-warn">{ui("linkStaleHint")}</p>}
            {linkConflict && <p className="text-xs text-warn" role="alert">{ui("criteriaChanged")}</p>}
            <fieldset className="space-y-2" disabled={busy || linkConflict}><legend className="mb-2 text-xs text-muted">{ui("chooseLinkCriteria")}</legend>{task.criteria.map(item => {
              const linked = task.evidence.some(evidence => evidence.source === "command" && evidence.reference === linkRun.id && evidence.criterionId === item.id && evidence.criterionRevision === item.revision);
              return <label key={item.id} className="flex items-start gap-2 text-xs leading-5"><input className="mt-1 accent-accent" type="checkbox" checked={linkSelection.includes(item.id)} onChange={event => setLinkSelection(event.target.checked ? [...linkSelection, item.id] : linkSelection.filter(id => id !== item.id))} /><span>{item.description}{linked && <span className="ml-2 text-muted">{ui("alreadyLinked")}</span>}</span></label>;
            })}</fieldset>
            <div className="flex flex-wrap gap-2"><button className={primary} disabled={busy || linkConflict || !linkSelection.some(id => !task.evidence.some(e => e.source === "command" && e.reference === linkRun.id && e.criterionId === id && e.criterionRevision === task.criteria.find(item => item.id === id)?.revision)) || !snapshot?.enabled} onClick={() => {
              if (!linkTarget) return;
              void act({ type: "linkVerification", taskId: linkTarget.taskId, runId: linkTarget.runId, criteria: linkTarget.criteria.filter(item => linkSelection.includes(item.id)) }).then(ok => { if (ok) { hideVerifications(); showTask(); } });
            }}>{ui("linkResult")}</button><button className={secondary} disabled={busy || linkConflict || !linkSelection.length || !!liveVerify || !snapshot?.enabled} onClick={() => void act({ type: "verify", taskId: task.id, criterionIds: linkSelection, commands: linkRun.commands.map(command => command.cmd) }).then(ok => { if (ok) { hideVerifications(); showTask(); } })}>{ui("rerunAndLink")}</button></div>
          </>}
        </section>}
        {(view === "start" || view === "edit") && <>
          {editConflict && <p role="alert" className="text-xs text-warn">{ui("criteriaChanged")}</p>}
          {view === "start" && <label className="grid gap-2 text-xs text-muted">{label("goal")}<input className={input} value={goal} onChange={event => setGoal(event.target.value)} /></label>}
          {view === "start" && <button className={secondary} disabled={busy || !goal.trim() || !snapshot?.enabled} onClick={() => {
            setBusy(true); setError("");
            void window.sudal.chat.send(tabId, { text: ui("suggestPrompt", { goal }) }).then(result => { if (result.ok) closePanel(); else setError(result.error); }).catch(err => setError(userErrorMessage(err))).finally(() => setBusy(false));
          }}>{ui("suggestCriteria")}</button>}
          <p className="text-xs text-muted">{ui("criteriaHint")}</p>
          {criteria.map((item, i) => <div key={item.id ?? i} className="space-y-2 rounded-lg border border-line p-3"><label className="grid gap-2 text-xs text-muted">{ui("criterionNumber", { count: i + 1 })}<input className={input} value={item.description} onChange={event => setCriteria(criteria.map((c, index) => index === i ? { ...c, description: event.target.value } : c))} /></label><label className="grid gap-2 text-xs text-muted">{label("method")}<input className={input} value={item.method} placeholder={ui("methodPlaceholder")} onChange={event => setCriteria(criteria.map((c, index) => index === i ? { ...c, method: event.target.value } : c))} /></label><button className="text-xs text-muted hover:text-err" disabled={criteria.length === 1} onClick={() => setCriteria(criteria.filter((_, index) => index !== i))}>{ui("remove")}</button></div>)}
          <div className="flex flex-wrap gap-2"><button className={secondary} disabled={criteria.length >= 30} onClick={() => setCriteria([...criteria, { description: "", method: "" }])}>{ui("addCriterion")}</button><button className={primary} disabled={busy || editConflict || !snapshot?.enabled || !criteria.length || criteria.some(item => !item.description.trim()) || view === "start" && !goal.trim()} onClick={() => void saveTask()}>{view === "start" ? ui("accept") : label("save")}</button></div>
          {task && view === "start" && <p className="text-xs text-warn">{ui("replaceHint")}</p>}
        </>}
        {view === "task" && !snapshot && !error && <p className="text-xs text-muted">{label("loading")}</p>}
        {view === "task" && snapshot && !shownTask && <div className="space-y-3"><p className="text-xs text-muted">{ui(snapshot?.enabled ? "noTask" : "off")}</p><button className={secondary} onClick={() => snapshot?.enabled ? startEditor() : openPanel("settings")}>{snapshot?.enabled ? label("start") : ui("settings")}</button></div>}
        {view === "task" && shownTask && <>
          <section className="space-y-3 pb-1"><span className="label">{ui("currentTask")}</span><h3 className="break-words text-sm font-medium leading-6">{shownTask.goal}</h3><div className="flex items-center gap-3"><div className="h-1 flex-1 overflow-hidden rounded-full bg-panel-2"><div className="h-full rounded-full bg-accent/70 transition-all" style={{ width: `${shownTask.criteria.length ? shownTask.criteria.filter(item => statusOf(item) === "passed").length / shownTask.criteria.length * 100 : 0}%` }} /></div><span className="mono shrink-0 text-[10px] text-muted">{shownTask.criteria.filter(item => statusOf(item) === "passed").length} / {shownTask.criteria.length}</span></div></section>
          {!snapshot?.revision && <p className="text-xs text-warn">{label("unknown")}</p>}
          {task && <button className={secondary} onClick={() => openLink()}>{ui("existingResult")}</button>}
          <section className="border-t border-line pt-3"><div className="mb-1 flex items-center justify-between"><span className="label">{ui("criteriaTitle")}</span>{task && <button className="text-[11px] text-muted hover:text-fg" onClick={editTask}>{label("edit")}</button>}</div>{taskRows(shownTask, !!task && checkMode === "command", true)}</section>
          {task && <>
            <div className="flex gap-4 border-b border-line" role="group" aria-label={ui("checkMethod")}>{(["evidence", "manual", "command"] as const).map(value => <button key={value} className={`border-b-2 px-0.5 pb-2 pt-1 text-xs ${checkMode === value ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg"}`} aria-pressed={checkMode === value} onClick={() => setCheckMode(value)}>{value === "evidence" ? label("evidence") : value === "manual" ? label("confirm") : ui("commandCheck")}</button>)}</div>
            <p className="text-xs text-muted">{checkMode === "manual" && selected.length !== 1 ? ui("manualSelection") : selected.length ? ui("selected", { count: selected.length }) : ui(checkMode === "evidence" ? "evidenceSelection" : "selectionHint")}</p>
            {checkMode === "manual" && selected.length === 1 && <section className="space-y-3 border-t border-line pt-4"><h3 className="text-xs font-medium">{label("confirm")}</h3><textarea className={input} rows={3} aria-label={label("note")} value={noteValid ? note : ""} maxLength={4000} placeholder={ui("notePlaceholder")} onChange={event => { if (!noteCriterion) return; setNote(event.target.value); setNoteTarget({ taskId: task.id, criterionId: noteCriterion.id, revision: noteCriterion.revision }); }} /><button className={secondary} disabled={busy || !noteValid || !note.trim() || !snapshot?.enabled} onClick={() => void act({ type: "confirm", taskId: task.id, criterionId: noteTarget!.criterionId, criterionRevision: noteTarget!.revision, note }).then(ok => { if (ok) setNote(""); })}>{ui("saveConfirmation")}</button></section>}
            {checkMode === "command" && <section className="space-y-3 border-t border-line pt-4"><label className="grid gap-2 text-xs text-muted">{label("commands")}<textarea className={`${input} mono`} rows={3} aria-label={label("commands")} value={commands ?? snapshot?.config.commands.join("\n") ?? ""} onChange={event => setCommands(event.target.value)} /></label><p className="text-xs text-muted">{ui("commandHint")}</p><label className="flex items-start gap-2 text-xs text-muted"><input type="checkbox" checked={autoRepair} onChange={event => setAutoRepair(event.target.checked)} />{t("chat.feedback.enable")}</label><div className="flex flex-wrap gap-2"><button className={primary} disabled={busy || !snapshot?.enabled || !!liveVerify || !selected.length || !lines(commands ?? snapshot?.config.commands.join("\n") ?? "").length} onClick={() => void act({ type: "verify", taskId: task.id, criterionIds: selected, commands: lines(commands ?? snapshot?.config.commands.join("\n") ?? ""), autoRepair })}>{ui("runCommands", { count: lines(commands ?? snapshot?.config.commands.join("\n") ?? "").length })}</button><button className={secondary} disabled={busy || !snapshot?.enabled || !selected.length} onClick={() => void act({ type: "review", taskId: task.id, criterionIds: selected })}>{label("review")}</button></div>{liveVerify && <button className={secondary} onClick={() => void window.sudal.chat.verifyAbort(tabId)}>{t("chat.verifyCard.abort")}</button>}</section>}
          </>}

          {checkMode === "evidence" && blocks.filter((block): block is VerifyBlock => block.kind === "verify" && shownTask.evidence.some(evidence => evidence.source === "command" && evidence.reference.includes(block.id))).slice(-2).map(block => <VerifyCard key={block.id} block={block} tabId={tabId} layout="panel" />)}
          <details className="border-t border-line pt-4"><summary className="text-xs text-muted">{ui("more")}</summary><div className="mt-3 flex flex-wrap gap-2">{task ? <><button className={secondary} disabled={busy} onClick={() => void act({ type: "status", taskId: task.id, status: "paused" })}>{label("pause")}</button></> : paused && <button className={primary} disabled={busy || !snapshot?.enabled} onClick={() => void act({ type: "status", taskId: paused.id, status: "active" })}>{label("resume")}</button>}</div></details>
        </>}
        {view === "finish" && task?.id !== finishTarget && <p role="alert" className="text-xs text-warn">{ui("taskChanged")}</p>}
        {view === "finish" && task && task.id === finishTarget && <><h3>{task.goal}</h3><p className="text-xs text-warn">{label("reasonRequired")}</p><ul className="space-y-2 text-xs text-muted">{task.criteria.filter(item => statusOf(item) !== "passed").map(item => <li key={item.id}>{item.description} · {label(statusOf(item))}</li>)}</ul><textarea className={input} rows={4} aria-label={label("completionReason")} value={reason} onChange={event => setReason(event.target.value)} /><button className={primary} disabled={busy || !reason.trim()} onClick={() => void act({ type: "status", taskId: finishTarget!, status: "completed", reason }).then(ok => { if (ok) showTask(); })}>{label("complete")}</button></>}
        {view === "history" && <>{snapshot?.tasks.filter(item => item.status !== "active").slice().reverse().map(item => <section key={item.id} className="space-y-3 border-b border-line pb-4"><div className="flex gap-2 text-xs text-muted"><Icon name={item.status === "completed" ? "check" : "clock"} size={14} />{label(item.status)}</div><h3 className="break-words">{item.goal}</h3>{item.completionReason && <p className="text-xs text-muted whitespace-pre-wrap">{item.completionReason}</p>}<details><summary className="text-xs text-muted">{label("evidence")}</summary><div className="mt-2 space-y-2">{item.evidence.map(evidence => <p className="break-words whitespace-pre-wrap text-xs text-muted" key={evidence.id}>{label(evidence.source)} · {label(evidence.result)} · {evidence.reference}</p>)}</div></details><button className={secondary} disabled={busy || !snapshot?.enabled} onClick={() => void act({ type: "status", taskId: item.id, status: "active" })}>{label("resume")}</button></section>)}{snapshot?.tasks.every(item => item.status === "active") && <p className="text-xs text-muted">{ui("noHistory")}</p>}</>}
      </div>
      {view === "task" && task && <footer className="shrink-0 border-t border-line px-4 py-3"><button className={primary + " w-full"} disabled={busy || !snapshot?.enabled} onClick={() => void finish()}>{allPassed ? label("complete") : ui("finishWithReason")}</button></footer>}
    </aside>, detailSlot)}
  </>;
}
