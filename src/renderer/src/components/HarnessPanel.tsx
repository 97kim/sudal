import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { harnessCriterionStatus, type HarnessAction, type HarnessSnapshot } from "@shared/harness";
import { userErrorMessage } from "@shared/error-message";

const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function HarnessPanel({ tabId, cwd }: { tabId: string; cwd: string }) {
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
  const [snapshot, setSnapshot] = useState<HarnessSnapshot | null>(null);
  const [open, setOpen] = useState(false), [mode, setMode] = useState<"config" | "task" | "edit" | null>(null);
  const [goal, setGoal] = useState(""), [criteria, setCriteria] = useState(""), [commands, setCommands] = useState("");
  const [documents, setDocuments] = useState(""), [procedures, setProcedures] = useState(""), [token, setToken] = useState("");
  const [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [history, setHistory] = useState(false);
  const [improvementId, setImprovementId] = useState<string | undefined>();
  const [autoRepair, setAutoRepair] = useState(false);
  const [improve, setImprove] = useState(false), [problem, setProblem] = useState("");
  useEffect(() => {
    let alive = true, pending = false;
    setSnapshot(null); setMode(null); setSelected([]); setOpen(false); setError(""); setAutoRepair(false);
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
  }, [tabId, cwd]);
  const act = async (action: HarnessAction) => {
    setBusy(true); setError("");
    try { const state = await window.sudal.chat.harness(tabId, action); setSnapshot(state); return true; }
    catch (error) { setError(describeError(error)); return false; }
    finally { setBusy(false); }
  };
  const task = snapshot?.tasks.find(task => task.tabId === tabId && task.status === "active");
  const configure = (improvement = false) => {
    if (!snapshot) return;
    setDocuments((snapshot.configDraft ?? snapshot.config).documents.join("\n"));
    setCommands((snapshot.configDraft ?? snapshot.config).commands.join("\n"));
    setProcedures((snapshot.configDraft ?? snapshot.config).procedures.join("\n"));
    setToken(snapshot.configToken); setImprovementId(undefined); setMode("config"); setImprove(improvement); setProblem("");
  };
  const draft = () => {
    setGoal(snapshot?.proposal?.goal ?? "");
    setCriteria(snapshot?.proposal?.criteria.map(item => item.description + " | " + item.method).join("\n") ?? "");
    setMode("task");
  };
  const inputClass = "w-full rounded border border-line bg-bg px-2 py-1.5 text-xs";
  const buttonClass = "rounded border border-line px-2 py-1 text-xs hover:bg-panel-2 disabled:opacity-40";
  const field = (name: string, value: string, change: (value: string) => void) => <label className="grid gap-1">{label(name)}<textarea className={inputClass} rows={3} value={value} onChange={event => change(event.target.value)} /></label>;
  if (!cwd) return null;
  return <section className="shrink-0 border-b border-line bg-panel text-xs" data-harness-panel>
    <div className="flex items-center gap-2 px-4 py-2">
      <button className="text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>{label("title")}</button>
      {snapshot?.enabled && task && <span className="truncate text-muted">{task.goal} · {task.criteria.filter(item => harnessCriterionStatus(task, item, snapshot.revision) === "passed").length}/{task.criteria.length}</span>}
      {snapshot?.enabled && !task && <span className="text-muted">{label(snapshot.proposal ? "proposal" : "empty")}</span>}
    </div>
    {open && <div className="max-h-[45vh] space-y-3 overflow-y-auto border-t border-line px-4 py-3">
      <label className="flex items-center gap-2"><input type="checkbox" disabled={busy || !snapshot} checked={snapshot?.enabled ?? false} onChange={event => void act({ type: "enable", enabled: event.target.checked })} />{label("enable")}</label>
      <p className="text-muted">{label("stopHint")}</p>
      {!snapshot && !error && <p>{label("loading")}</p>}
      {error && <p role="alert" className="text-danger whitespace-pre-wrap">{error}</p>}
      {snapshot?.enabled && <>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} onClick={() => configure()}>{label("setup")}</button>
          <button className={buttonClass} disabled={busy} onClick={draft}>{label("start")}</button>
          <button className={buttonClass} onClick={() => setHistory(!history)}>{label("history")}</button>
          <button className={buttonClass} onClick={() => configure(true)}>{label("improve")}</button>
        </div>
        {snapshot.configDraft && !mode && <button className={buttonClass} onClick={() => configure()}>{label("draftReady")}</button>}
        {snapshot.proposal && !mode && <div className="rounded border border-accent/30 p-3 space-y-2">
          <p>{label("proposal")} · {snapshot.proposal.goal}</p>
          <button className={buttonClass} onClick={draft}>{label("accept")}</button>{" "}<button className={buttonClass} onClick={() => void act({ type: "dismiss" })}>{label("dismiss")}</button>
        </div>}
        {mode === "config" && <div className="grid gap-3 rounded border border-line p-3">
          <p className="text-muted">{label("configHint")}</p>
          <div className="grid gap-1">{snapshot.inspection.map(item => <span key={item.path}>{item.path} · {label(item.found ? "found" : "missing")}</span>)}</div>
          {improve && <>{field("problem", problem, setProblem)}<p className="text-muted">{label("improveHint")}</p></>}
          <button className={buttonClass} disabled={busy} onClick={() => {
            const prompt = `Read this project and propose a harness configuration. Do not edit files, run commands, install tools or change permissions. Use existing documents and suggest reusable verification procedures. Explain the evidence, unknowns, and proposed changes in the conversation language. Return an optional fenced sudal-harness JSON block with {version:1,documents:string[],commands:string[],procedures:string[]}. Proposals are not approval to apply changes. Current configuration: ${JSON.stringify(snapshot.config)}. ${improve ? `Problem to prevent: ${problem}. Explain the missed check and suggest targeted improvements without adding unrelated rules.` : ""}`;
            setBusy(true); void (async () => {
              if (improve) {
                const state = await window.sudal.chat.harness(tabId, { type: "improve", problem, taskId: task?.id });
                setSnapshot(state); setImprovementId(state.improvements.at(-1)?.id);
              }
              return window.sudal.chat.send(tabId, { text: prompt });
            })().then(result => { if (!result.ok) setError(result.error); else setMode(null); }).catch(error => setError(userErrorMessage(error))).finally(() => setBusy(false));
          }}>{label("suggest")}</button>
          {field("documents", documents, setDocuments)}{field("commands", commands, setCommands)}{field("procedures", procedures, setProcedures)}
          <details><summary>{label("applyConfirm")}</summary><pre className="whitespace-pre-wrap">{JSON.stringify({ version: 1, documents: lines(documents), commands: lines(commands), procedures: lines(procedures) }, null, 2)}</pre></details>
          <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => void act({ type: "configure", token, improvementId, config: { version: 1, documents: lines(documents), commands: lines(commands), procedures: lines(procedures) } }).then(ok => { if (ok) setMode(null); })}>{label("save")}</button><button className={buttonClass} onClick={() => setMode(null)}>{label("cancel")}</button></div>
        </div>}
        {(mode === "task" || mode === "edit") && <div className="grid gap-3 rounded border border-line p-3">
          {mode === "task" && field("goal", goal, setGoal)}
          {field("criteria", criteria, setCriteria)}<p className="text-muted">{label("criteria")} | {label("method")}</p>
          <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => {
            const items = lines(criteria).map(line => { const [description, ...rest] = line.split("|"); return { description: description.trim(), method: rest.join("|").trim() }; });
            void act(mode === "edit" && task ? { type: "edit", taskId: task.id, criteria: items.map((item, index) => ({ ...item, id: task.criteria[index]?.id })) } : { type: "start", goal, criteria: items }).then(ok => { if (ok) { setMode(null); setSelected([]); } });
          }}>{label("save")}</button><button className={buttonClass} onClick={() => setMode(null)}>{label("cancel")}</button></div>
        </div>}
        {task && <div className="space-y-3">
          <div className="flex gap-2"><strong>{task.goal}</strong><button className={buttonClass} onClick={() => { setCriteria(task.criteria.map(item => item.description + " | " + item.method).join("\n")); setMode("edit"); }}>{label("edit")}</button></div>
          {!snapshot.revision && <p className="text-muted">{label("unknown")}</p>}
          <p className="text-muted">{label("select")}</p>
          {task.criteria.map(item => <div key={item.id} className="space-y-1 border-l-2 border-line pl-3">
            <label className="flex items-start gap-2"><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{item.description} · {label(harnessCriterionStatus(task, item, snapshot.revision))}</span></label>
            <p className="text-muted">{item.method}</p>
            <button className={buttonClass} disabled={busy || !note.trim()} onClick={() => void act({ type: "confirm", taskId: task.id, criterionId: item.id, note })}>{label("confirm")}</button>
            {task.evidence.filter(evidence => evidence.criterionId === item.id).length > 0 && <details><summary>{label("evidence")}</summary>{task.evidence.filter(evidence => evidence.criterionId === item.id).map(evidence => <p key={evidence.id} className="break-all">{label(evidence.source)} · {label(evidence.result)} · {evidence.reference}</p>)}</details>}
          </div>)}
          {field("commands", commands || snapshot.config.commands.join("\n"), setCommands)}
          <label className="flex gap-2"><input type="checkbox" checked={autoRepair} onChange={event => setAutoRepair(event.target.checked)} />{t("chat.feedback.enable")}</label>
          <div className="flex gap-2"><button className={buttonClass} disabled={busy || !selected.length} onClick={() => void act({ type: "verify", autoRepair, taskId: task.id, criterionIds: selected, commands: lines(commands || snapshot.config.commands.join("\n")) })}>{label("verify")}</button><button className={buttonClass} disabled={busy || !selected.length} onClick={() => void act({ type: "review", taskId: task.id, criterionIds: selected })}>{label("review")}</button></div>
          {field("note", note, setNote)}
          <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => void act({ type: "status", taskId: task.id, status: "completed", reason: note })}>{label("complete")}</button><button className={buttonClass} disabled={busy} onClick={() => void act({ type: "status", taskId: task.id, status: "paused" })}>{label("pause")}</button></div>
        </div>}
        {snapshot.improvements.length > 0 && <details><summary>{label("improve")}</summary><div className="space-y-2">{snapshot.improvements.map(item => <div key={item.id} className="rounded border border-line p-2"><p>{item.problem} ? {label(item.status)}</p>{item.confirmation && <p>{item.confirmation}</p>}{item.status === "proposed" && <button className={buttonClass} onClick={() => { configure(); setImprovementId(item.id); }}>{label("draftReady")}</button>}{item.status === "applied" && <><input className={inputClass} aria-label={label("note")} value={note} onChange={event => setNote(event.target.value)} /><button className={buttonClass} disabled={busy || !note.trim()} onClick={() => void act({ type: "improvementConfirm", improvementId: item.id, note })}>{label("confirm")}</button></>}</div>)}</div></details>}
        {history && <div className="space-y-2">{snapshot.tasks.filter(item => item.id !== task?.id).map(item => <div key={item.id} className="rounded border border-line p-2"><p>{item.goal} · {label(item.status)}</p>{item.completionReason && <p>{item.completionReason}</p>}<button className={buttonClass} disabled={busy} onClick={() => void act({ type: "status", taskId: item.id, status: "active" })}>{label("resume")}</button></div>)}</div>}
      </>}
    </div>}
  </section>;
}
