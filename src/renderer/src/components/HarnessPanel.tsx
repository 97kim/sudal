import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { harnessCriterionStatus, type HarnessAction, type HarnessSnapshot } from "@shared/harness";
import { userErrorMessage } from "@shared/error-message";
import { Icon } from "./Icon";

const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function HarnessPanel({ tabId, cwd, settingsOnly = false, controller }: {
  tabId: string; cwd: string; settingsOnly?: boolean;
  controller?: { snapshot: HarnessSnapshot | null; dispatch: (action: HarnessAction) => Promise<HarnessSnapshot> };
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`chat.harness.${key}` as never) as string;
  const describeError = (error: unknown) => {
    const message = userErrorMessage(error);
    if (message.includes("Completion requires a reason")) return label("reasonRequired");
    if (message.includes("Configuration changed")) return label("configChanged");
    if (message.includes("another tab")) return label("taskBusy");
    if (message.includes("trusted")) return label("trustRequired");
    if (message.includes("Invalid completion criteria")) return label("criteriaRequired");
    if (message.includes("Invalid task goal")) return label("goalRequired");
    if (message.includes("Describe the problem")) return label("problemRequired");
    return message;
  };
  const [localSnapshot, setSnapshot] = useState<HarnessSnapshot | null>(null);
  const snapshot = controller ? controller.snapshot : localSnapshot;
  const [open, setOpen] = useState(settingsOnly), [mode, setMode] = useState<"config" | "task" | "edit" | null>(null);
  const [goal, setGoal] = useState(""), [criteria, setCriteria] = useState(""), [commands, setCommands] = useState("");
  const [documents, setDocuments] = useState(""), [procedures, setProcedures] = useState(""), [token, setToken] = useState("");
  const [completionReason, setCompletionReason] = useState("");
  const [improvementNote, setImprovementNote] = useState("");
  const [verifyCommands, setVerifyCommands] = useState<string | null>(null);
  const [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [history, setHistory] = useState(false);
  const [draftToken, setDraftToken] = useState<string | undefined>();
  const [improvementId, setImprovementId] = useState<string | undefined>();
  const [autoRepair, setAutoRepair] = useState(false);
  const [improve, setImprove] = useState(false), [problem, setProblem] = useState("");
  useEffect(() => {
    if (controller) return;
    let alive = true, pending = false;
    setSnapshot(null); setMode(null); setSelected([]); setOpen(settingsOnly); setError(""); setAutoRepair(false);
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try { const state = await window.sudal.chat.harness(tabId, { type: "snapshot" }); if (alive) setSnapshot(state); }
      catch (error) { if (alive) setError(describeError(error)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.hasFocus()) void refresh(); }, 10000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [tabId, cwd, !!controller]);
  const act = async (action: HarnessAction) => {
    setBusy(true); setError("");
    try { const state = await (controller ? controller.dispatch(action) : window.sudal.chat.harness(tabId, action)); setSnapshot(state); return true; }
    catch (error) { setError(describeError(error)); return false; }
    finally { setBusy(false); }
  };
  const task = snapshot?.tasks.find(task => task.tabId === tabId && task.status === "active");
  useEffect(() => { setSelected([]); setNote(""); setCompletionReason(""); setImprovementNote(""); setAutoRepair(false); }, [task?.id]);
  const configure = (improvement = false, linkedId = snapshot?.configDraftImprovementId) => {
    if (!snapshot) return;
    const source = snapshot.configDraft && !improvement && snapshot.configDraftImprovementId === linkedId ? snapshot.configDraft : snapshot.config;
    setDraftToken(source === snapshot.configDraft ? snapshot.configDraftToken : undefined);
    setDocuments(source.documents.join("\n"));
    setCommands(source.commands.join("\n"));
    setProcedures(source.procedures.join("\n"));
    setToken(snapshot.configToken); setImprovementId(improvement ? undefined : linkedId); setMode("config"); setImprove(improvement); setProblem("");
  };
  const draft = () => {
    setGoal(snapshot?.proposal?.goal ?? "");
    setCriteria(snapshot?.proposal?.criteria.map(item => item.description + " | " + item.method).join("\n") ?? "");
    setMode("task");
  };
  const inputClass = "w-full min-w-0 resize-y rounded-md border border-line bg-inset px-3 py-2 text-xs leading-6 outline-none transition-colors focus:border-accent/50";
  const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40";
  const field = (name: string, value: string, change: (value: string) => void) => <label className="grid min-w-0 gap-2"><span className="font-medium text-fg">{label(name)}</span><textarea className={`${inputClass} ${name === "documents" || name === "commands" ? "mono" : ""}`} rows={3} aria-label={label(name)} value={value} onChange={event => change(event.target.value)} /></label>;
  if (!cwd) return null;
  return <section className={settingsOnly ? "text-xs" : "shrink-0 border-b border-line bg-panel text-xs"} data-harness-panel>
    {!settingsOnly && <div className="flex items-center gap-2 px-4 py-2">
      <button className="text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>{label("title")}</button>
      {snapshot?.enabled && task && <span className="truncate text-muted">{task.goal} · {task.criteria.filter(item => harnessCriterionStatus(task, item, snapshot.revision) === "passed").length}/{task.criteria.length}</span>}
      {snapshot?.enabled && !task && <span className="text-muted">{label(snapshot.proposal ? "proposal" : "empty")}</span>}
    </div>}
    {open && <div className={settingsOnly ? "space-y-4" : "max-h-[45vh] space-y-3 overflow-y-auto border-t border-line px-4 py-3"}>
      <div className="flex items-start justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0 space-y-2"><h3 className="text-sm font-medium">{label("enable")}</h3><p className="break-words text-xs leading-5 text-muted">{label("stopHint")}</p></div>
        <button type="button" role="switch" aria-label={label("enable")} aria-checked={snapshot?.enabled ?? false} disabled={busy || !snapshot} className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 ${snapshot?.enabled ? "bg-accent" : "bg-panel-2 ring-1 ring-inset ring-line"}`} onClick={() => void act({ type: "enable", enabled: !snapshot?.enabled })}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${snapshot?.enabled ? "left-0.5 translate-x-4" : "left-0.5"}`} /></button>
      </div>
      {!snapshot && !error && <p>{label("loading")}</p>}
      {snapshot?.configError && <p role="alert" className="text-danger">{label("configInvalid")}</p>}
      {error && <p role="alert" className="text-danger whitespace-pre-wrap">{error}</p>}
      {snapshot?.enabled && <>
        <div className="flex flex-wrap items-center gap-2">
          <button className={buttonClass} disabled={busy} onClick={() => configure()}><Icon name="edit" size={13} />{label("setup")}</button>
          {!settingsOnly && <button className={buttonClass} disabled={busy} onClick={draft}>{label("start")}</button>}
          {!settingsOnly && <button className={buttonClass} onClick={() => setHistory(!history)}>{label("history")}</button>}
          <button className={buttonClass} onClick={() => configure(true, undefined)}>{label("improve")}</button>
        </div>
        {snapshot.configDraft && !mode && <button className={buttonClass} onClick={() => configure()}>{label("draftReady")}</button>}
        {!settingsOnly && snapshot.proposal && !mode && <div className="rounded border border-accent/30 p-3 space-y-2">
          <p>{label("proposal")} · {snapshot.proposal.goal}</p>
          <button className={buttonClass} onClick={draft}>{label("accept")}</button>{" "}<button className={buttonClass} onClick={() => void act({ type: "dismiss" })}>{label("dismiss")}</button>
        </div>}
        {settingsOnly && mode === null && <div className="divide-y divide-line" data-harness-config-summary>
          {(["documents", "commands", "procedures"] as const).map(name => <section key={name} className="space-y-3 py-4 first:pt-1">
            <div className="flex items-center gap-2"><Icon name={name === "documents" ? "file" : name === "commands" ? "terminal" : "list"} size={14} className="text-muted" /><h3 className="flex-1 font-medium">{label(`${name}Title`)}</h3><span className="text-[11px] text-muted">{snapshot.config[name].length}</span></div>
            <p className="text-[11px] leading-5 text-muted">{label(`${name}Hint`)}</p>
            {snapshot.config[name].length ? <ul className="space-y-1.5">{snapshot.config[name].map((value, index) => <li key={index} className={`break-words text-xs leading-5 ${name !== "procedures" ? "mono" : ""}`}>{value}</li>)}</ul> : <p className="text-xs text-muted-2">{label("notConfigured")}</p>}
          </section>)}
        </div>}
        {mode === "config" && <div className="grid min-w-0 gap-5" data-harness-config-editor>
          <p className="text-[11px] leading-5 text-muted">{label("configHint")}</p>
          <details className="text-[11px] text-muted"><summary className="cursor-pointer hover:text-fg">{label("projectFiles")}</summary><div className="mt-2 grid gap-1.5">{snapshot.inspection.map(item => <span key={item.path} className="break-words">{item.path} · {label(item.found ? "found" : "missing")}</span>)}</div></details>
          {improve && <>{field("problem", problem, setProblem)}<p className="text-muted">{label("improveHint")}</p></>}
          <button className={buttonClass} disabled={busy} onClick={() => {
            let prompt = `Read this project and propose a harness configuration. Do not edit files, run commands, install tools or change permissions. Use existing documents and suggest reusable verification procedures. Explain the evidence, unknowns, and proposed changes in the conversation language. Return an optional fenced sudal-harness JSON block with {version:1,documents:string[],commands:string[],procedures:string[]}. Proposals are not approval to apply changes. Current configuration: ${JSON.stringify(snapshot.config)}. ${improve ? `Problem to prevent: ${problem}. Explain the missed check and suggest targeted improvements without adding unrelated rules.` : ""}`;
            setBusy(true); void (async () => {
              if (improve) {
                const action: HarnessAction = { type: "improve", problem, taskId: task?.id };
                const state = await (controller ? controller.dispatch(action) : window.sudal.chat.harness(tabId, action));
                const id = state.improvements.at(-1)?.id;
                setSnapshot(state); setImprovementId(undefined);
                prompt += ` Include improvementId: ${JSON.stringify(id)} in the sudal-harness JSON object to associate this draft with this improvement.`;
              }
              return window.sudal.chat.send(tabId, { text: prompt });
            })().then(result => { if (!result.ok) setError(result.error); else setMode(null); }).catch(error => setError(userErrorMessage(error))).finally(() => setBusy(false));
          }}>{label("suggest")}</button>
          {field("documents", documents, setDocuments)}{field("commands", commands, setCommands)}{field("procedures", procedures, setProcedures)}
          <details className="text-[11px] text-muted"><summary className="cursor-pointer hover:text-fg">{label("applyConfirm")}</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify({ version: 1, documents: lines(documents), commands: lines(commands), procedures: lines(procedures) }, null, 2)}</pre></details>
          <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => void act({ type: "configure", token, improvementId, draftToken, config: { version: 1, documents: lines(documents), commands: lines(commands), procedures: lines(procedures) } }).then(ok => { if (ok) { setMode(null); setImprovementId(undefined); } })}>{label("save")}</button><button className={buttonClass} onClick={() => { setMode(null); setImprovementId(undefined); }}>{label("cancel")}</button></div>
        </div>}
        {(mode === "task" || mode === "edit") && <div className="grid gap-3 rounded border border-line p-3">
          {mode === "task" && field("goal", goal, setGoal)}
          {field("criteria", criteria, setCriteria)}<p className="text-muted">{label("criteria")} | {label("method")}</p>
          <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => {
            const items = lines(criteria).map(line => { const [description, ...rest] = line.split("|"); return { description: description.trim(), method: rest.join("|").trim() }; });
            void act(mode === "edit" && task ? { type: "edit", taskId: task.id, criteria: items.map((item, index) => ({ ...item, id: task.criteria[index]?.id })) } : { type: "start", goal, criteria: items }).then(ok => { if (ok) { setMode(null); setSelected([]); } });
          }}>{label("save")}</button><button className={buttonClass} onClick={() => { setMode(null); setImprovementId(undefined); }}>{label("cancel")}</button></div>
        </div>}
        {!settingsOnly && task && <div className="space-y-3">
          <div className="flex gap-2"><strong>{task.goal}</strong><button className={buttonClass} onClick={() => { setCriteria(task.criteria.map(item => item.description + " | " + item.method).join("\n")); setMode("edit"); }}>{label("edit")}</button></div>
          {!snapshot.revision && <p className="text-muted">{label("unknown")}</p>}
          <p className="text-muted">{label("select")}</p>
          {task.criteria.map(item => <div key={item.id} className="space-y-1 border-l-2 border-line pl-3">
            <label className="flex items-start gap-2"><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{item.description} · {label(harnessCriterionStatus(task, item, snapshot.revision))}</span></label>
            <p className="text-muted">{item.method}</p>
            <button className={buttonClass} disabled={busy || !note.trim()} onClick={() => void act({ type: "confirm", taskId: task.id, criterionId: item.id, note }).then(ok => { if (ok) setNote(""); })}>{label("confirm")}</button>
            {task.evidence.filter(evidence => evidence.criterionId === item.id).length > 0 && <details><summary>{label("evidence")}</summary>{task.evidence.filter(evidence => evidence.criterionId === item.id).map(evidence => <p key={evidence.id} className="break-all">{label(evidence.source)} · {label(evidence.result)} · {evidence.reference}</p>)}</details>}
          </div>)}
          {field("commands", verifyCommands ?? snapshot.config.commands.join("\n"), setVerifyCommands)}
          <label className="flex gap-2"><input type="checkbox" checked={autoRepair} onChange={event => setAutoRepair(event.target.checked)} />{t("chat.feedback.enable")}</label>
          <div className="flex gap-2"><button className={buttonClass} disabled={busy || !selected.length} onClick={() => void act({ type: "verify", autoRepair, taskId: task.id, criterionIds: selected, commands: lines(verifyCommands ?? snapshot.config.commands.join("\n")) })}>{label("verify")}</button><button className={buttonClass} disabled={busy || !selected.length} onClick={() => void act({ type: "review", taskId: task.id, criterionIds: selected })}>{label("review")}</button></div>
          {field("note", note, setNote)}{field("completionReason", completionReason, setCompletionReason)}
          <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => void act({ type: "status", taskId: task.id, status: "completed", reason: completionReason })}>{label("complete")}</button><button className={buttonClass} disabled={busy} onClick={() => void act({ type: "status", taskId: task.id, status: "paused" })}>{label("pause")}</button></div>
        </div>}
        {snapshot.improvements.length > 0 && <details><summary>{label("improve")}</summary><div className="space-y-2">{snapshot.improvements.map(item => <div key={item.id} className="rounded border border-line p-2"><p>{item.problem} ? {label(item.status)}</p>{item.confirmation && <p>{item.confirmation}</p>}{item.status === "proposed" && <button className={buttonClass} onClick={() => configure(false, item.id)}>{label("draftReady")}</button>}{item.status === "applied" && <><input className={inputClass} aria-label={label("note")} value={improvementNote} onChange={event => setImprovementNote(event.target.value)} /><button className={buttonClass} disabled={busy || !improvementNote.trim()} onClick={() => void act({ type: "improvementConfirm", improvementId: item.id, note: improvementNote }).then(ok => { if (ok) setImprovementNote(""); })}>{label("confirm")}</button></>}</div>)}</div></details>}
        {history && <div className="space-y-2">{snapshot.tasks.filter(item => item.id !== task?.id).map(item => <div key={item.id} className="rounded border border-line p-2"><p>{item.goal} · {label(item.status)}</p>{item.completionReason && <p>{item.completionReason}</p>}<button className={buttonClass} disabled={busy} onClick={() => void act({ type: "status", taskId: item.id, status: "active" })}>{label("resume")}</button></div>)}</div>}
      </>}
    </div>}
  </section>;
}
