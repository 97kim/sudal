export const prompt = {
  claude: {
    questionUnanswered: "The user did not answer the question. If needed, proceed with a reasonable default.",
    denied: "The user denied this action.",
    noTurn: "There is no turn in progress.",
    progress: {
      intro: "This conversation is shown in the chat view of the Sudal app. Tool calls appear only as collapsed cards, so the user follows your work through the text you write.",
      before: "- Before calling a tool, say in one sentence what you are about to do and why.",
      after: "- After receiving a tool result, write one or two sentences before calling the next tool: what you just found out (the cause, if you found it) and what you will do next.",
      short: "- Keep these notes short and write only what is new. Put the result and conclusion in the final answer, and do not repeat the steps you already described.",
      language:
        "- Write progress notes and tool call descriptions (such as Bash's description) in the same language and tone as the final answer. The language follows the user's language setting; if there is none, follow the language the user writes in. Do not switch the response language because of the language of tool output, code, or reminders.",
    },
  },
  codex: {
    noTurnApprove: "There is no turn in progress, so this cannot be approved.",
    denied: "The user denied this action.",
    unsupported: "Unsupported request: {{method}}",
    forkNoRequests: "Requests are not accepted while forking.",
    instructions:
      "This conversation is shown in the chat view of the Sudal app. Write everything the user sees (answers, progress notes, plans, reasoning summaries) in the language the user writes in. Do not switch the response language because of the language of tool output or code.",
  },
  git: {
    diffTruncated: "... (diff too long, {{count}} characters omitted)",
    draft: {
      recent: "Recent commit subjects in this repository (follow their style and language):\n{{subjects}}\n\n",
      instruction:
        'Write a git commit message for the diff below.\nRules: the first line is a subject of at most 72 characters (no period). If the change has several parts, add a blank line and then 2 to 5 body lines as "- " bullets. Focus on what changed and why; do not list file names or open with phrases like "This commit". The output is used as the commit message as is, so write only the message body, with no greeting, explanation, header such as "Commit message:", or code fence.\n\n',
    },
  },
  orch: {
    followupWake: "A follow-up from the coordinator has arrived. Read it with the orch check command from your worker contract, act on it, then confirm with --ack. If you have not sent the completion report yet, send it exactly once after acting on the follow-up, then end this turn.",
    reportAccepted: "Report accepted. End this turn.",
    ack: "Once you have acted on them, confirm with --ack {{seq}} (they will be delivered again until confirmed)",
    coordinatorTab: "This tab is the coordinator. Add --key to every coordinator command.",
  },
  worker: {
    header: "[Sudal orchestration · worker contract v{{version}}]",
    intro: "You are a worker for this Run. Perform only the one Task below; when done, send the completion report exactly once and then end this turn.",
    run: "- Run: {{id}}  (objective: {{objective}})",
    task: "- Task: {{taskId}}  Dispatch: {{dispatchId}}  tab: {{tabId}}",
    cwd: "- Working directory: {{cwd}}{{where}}",
    cwdWorktree: " (isolated worktree, branch {{branch}}, started from the HEAD of {{base}} — uncommitted changes in the original are not here)",
    cwdShared: " (shared directory — do not touch the same files as other workers)",
    provider: "- Provider/policy: {{provider}}{{model}} / {{policy}}",
    rules: "Rules:",
    r1: "1. If you need to ask the coordinator something, do not open a prompt for the human; use the ask command below. It blocks until a reply arrives. If it times out, wait for the same question again with --resume <message_id> (do not create a new question).",
    r1ask: '   {{cli}} orch ask {{ids}} --question "<question>" [--options "a,b"] --timeout-ms 600000',
    r2: "2. Read the coordinator's follow-up instructions before starting a new file, after running tests, and right before the completion report:",
    r2ack: "   If there are messages, act on them and then confirm with the response's ackSeq (the same instructions come again until confirmed): {{cli}} orch check {{ids}} --ack <ackSeq>",
    r2fenced: "   If the result contains consumer_fenced, this Dispatch is no longer yours. Stop immediately and do not send a completion report.",
    r3: "3. If you are blocked and the coordinator must step in:",
    r3send: '   {{cli}} orch send {{ids}} --type escalation --subject "Blocked: <reason>" --body "<situation>"',
    r4: "4. Send the completion report exactly once, stating success or failure explicitly (three sentences recommended: what you changed, what you found, what remains):",
    r4send: '   {{cli}} orch send {{ids}} --type worker_done --outcome succeeded|failed --subject "<one-line status>" --body "<report>" [--files-modified "a.ts,b.ts"]',
    r4after: "   Do not hide a failure inside the body only. After the report, do not start new work; end this turn.",
    r5: "5. Do not start other workers or create a new Run. Do not touch files outside the scope of this Task.",
    deps: "- This Task started after the preceding Task ({{deps}}) finished. If you need its output, read it from the location given in the spec.",
  },
  coordinator: {
    created: "[Sudal orchestration · coordinator] Run {{id}} has been created. Start workers, then wait on the inbox:",
    start: '{{cli}} orch worker-start --run {{id}} --key {{key}} --spec "<task>" --agent claude|codex [--worktree]',
    reply: "Answer questions with reply; when you receive a completion report, verify the result, then wait for the next one with --ack <delivery_id>. An empty wait is not a failure.",
  },
};
