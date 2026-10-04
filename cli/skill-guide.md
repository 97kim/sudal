# Sudal CLI guide (for agents)

`sudal` controls the running Sudal app. Use it only for work where Sudal's workspaces, tabs, and sessions are the source of truth. Every command prints a single JSON object, except `--help` (plain text) and `skills get` (this Markdown). A failure exits with 1 and prints `{"error":{"code","message"}}`.

Write everything the user reads in the user's language: follow their language setting, and otherwise the language of their request. This guide being in English does not change that.

## Model

- **Workspace**: a name plus an optional default path. It groups tabs.
- **Tab**: one chat session. It has a provider (claude|codex), a policy (ask|auto_edit|full), a cwd, and a status (idle|running|queued|waiting_permission|error).
- **Selector `<sel>`**: `self` (the tab you are running in) · `active` (the tab the person is looking at in the app) · a tab id · an exact title · a unique title prefix. An ambiguous selector fails with `ambiguous` and lists the candidates. Omitting `--tab` means `active`.
- **`self` is not `active`.** You often run in a tab that is not on screen (a worker, the other side of a split, a scheduled run). `self` comes from `SUDAL_TAB_ID`, which the app sets for the agents it runs. Outside an Sudal tab, `self` fails with `no_self_tab`.

## Common flows

Open a new tab, send a prompt, and get the reply:

```text
sudal tab new --ws <name> --cwd /abs/repo --provider claude --policy auto_edit --title "auth bug" --prompt "Find why login returns 500" --activate
sudal tab wait --tab "auth bug" --timeout-ms 600000
sudal tab read --tab "auth bug" --last 6
```

Send a follow-up to an existing tab and get just that reply (send and wait in one step):

```text
sudal tab send --tab "auth bug" --text "Add a test too" --wait --timeout-ms 900000
```

- If `send.queued` is true in the `send` result, the tab is waiting its turn under the concurrency limit. If `send.pending` is true, the tab is running another turn and your prompt went into its prompt queue (it is sent automatically when that turn ends). Neither is an error. In the tab info, `pending` is the number of prompts left in the queue, and `limitWait` means the tab is waiting to retry after a usage limit.
- Judge a `wait` result by `wait.satisfied`. A timeout is normal output with `satisfied:false`. Do not send again; wait again. `send --wait` is satisfied only when the turn for the message you just sent has actually finished (past any queue or limit wait). A standalone `wait` is satisfied immediately if the tab has nothing left to do.
- With `satisfied:true`, `reply` holds the assistant text after the last user message, joined together. If you also need the tool calls, use `tab read`.
- Pass long text through stdin with `--text -` / `--prompt -`.

See state:

```text
sudal status
sudal ws list
sudal tab list                # open tabs; --all includes closed tabs
sudal tab list --ws <name>
sudal tab status --tab <sel>
```

Manage tabs:

```text
sudal tab activate --tab <sel>   # switch the app to that tab
sudal tab abort --tab <sel>      # stop the turn in progress
sudal tab close --tab <sel>      # close the tab (the history is kept)
sudal ws add --path /abs/dir     # add a workspace (one tab is created with it)
```

Verify (run tests or builds and leave a result card):

```text
sudal tab verify --tab <sel> --wait                          # run the workspace's saved verify commands in order, in that tab's cwd
sudal tab verify --tab <sel> --cmd "yarn typecheck" --cmd "yarn test" --wait --timeout-ms 1800000
sudal tab verify-abort --tab <sel>
```

- The result stays in that tab's conversation as a verify card. With `--wait`, `result` carries `status` (passed|failed|aborted), the `head` at run time (sha, branch, dirty), and per-command `status`/`exitCode`/`output` (the tail). If one command fails, the later ones are `skipped`.
- `--cmd` runs only those commands and does not save them. Saving is done in the app, in the editor next to the Verify button.
- Before you commit on the user's behalf, run verification with this command and confirm `status:passed`.

Open things in the app:

```text
sudal file open --path /abs/file.ts --line 42 [--tab <sel>]   # open the file at that line in that tab's editor panel
sudal browser open --url http://localhost:3000 [--tab <sel>]  # open it in that tab's in-app browser
sudal browser read [--tab <sel>]                             # visible text plus clickable items (with selectors)
sudal browser click --selector "#save" [--tab <sel>]         # or --text "Save"
sudal browser fill --selector "#email" --value "a@b.c"       # React state is updated too
```

Fan-out (send the same prompt to several isolated sessions at once and compare):

```text
sudal tab fanout --tab <sel> --prompt "<prompt>" --provider claude --provider codex --policy auto_edit --wait --timeout-ms 1800000
```

- Each session gets its own git worktree of the repository and a new tab, so they do not touch each other's files. In the `--wait` result, `result.variants[]` carries each session's `status` (done|failed|waiting), change stats (`files`/`added`/`deleted`), and a summary of its answer. `waiting` means that tab is waiting for a permission answer (a person must look at it).
- The user picks which session to adopt in the app's comparison view (the patch is applied to the original). The CLI does not adopt.

## Orchestration (several workers that need supervision)

Use this when you must split several jobs across worker tabs, answer their questions, and collect their completion reports. If you only need to pass work to another tab, "Handoff" below is enough.
Model: **Run** (the coordinator's inbox) > **Task** (a self-contained job spec) > **Dispatch** (the one authoritative attempt at that job = one worker tab). Authority is bound to dispatchId + capability.

### Coordinator (when you supervise from inside a tab)

```text
sudal orch run-create --objective "<objective>" --coordinator self       # pass the coordinatorKey from the response as --key on every command
sudal orch worker-start --run <run> --key <k> --spec "<Task spec>" --agent codex --worktree
sudal orch worker-start --run <run> --key <k> --spec "<another Task>" --agent claude --worktree
sudal orch check --run <run> --key <k> --wait --types worker_done,question,escalation,note --timeout-ms 900000
sudal orch reply --run <run> --key <k> --id <question_id> --body "<answer>"
sudal orch send  --run <run> --key <k> --type followup --to dispatch:<id> --body "<instruction>"
sudal orch check --run <run> --key <k> --ack <delivery_id> --wait --types worker_done,question,escalation,note --timeout-ms 900000
sudal orch worker-release --run <run> --key <k> --dispatch <id>           # clean up a settled worker (the tab stays)
```

- Use `--coordinator self`, not `active`: the coordinator is the tab you are running in, which may not be the tab on screen.
- Write each Task spec to be self-contained: the target (files, components), the change, the constraints (what must not be touched), the ownership scope (what this worker may edit), and a checkable completion criterion (tests, output).
- Start independent jobs all at once, then wait. `check --wait` returns the oldest batch in the inbox first (a Delivery). **After handling every message in it**, wait for the next one with `--ack <delivery_id>`. Until you ack, the same batch comes again.
- An empty wait or a timeout is a checkpoint, not a failure. As long as workers are alive, wait again. Among app notes, `turn_ended_without_report` means a worker's turn ended without a report: look at the tab and send a follow-up, or `worker-abandon`.
- A worker that edits files must be isolated with `--worktree`. Never put two editing workers on the same path. A worktree starts from the original's HEAD, so uncommitted changes in the original do not carry over.
- While a coordinator tab has open Dispatches in an active Run, it does not count toward the concurrency limit, so waiting with `check --wait` does not take a worker's slot.
- A follow-up reaches a worker when it runs `orch check`; if the worker's turn has already ended, the app wakes its tab so it reads the follow-up. Send follow-ups with `--to dispatch:<id>` or a group: `@all` · `@claude` · `@codex` · `@idle` (delivered to each live worker). A worker tab cannot create a new Run (`nested_run`).
- If a person presses "Take over" in the app's orchestration panel, your key becomes `consumer_fenced`. Stop and tell the user.
- Chain jobs with `task-create --deps` only when the order is truly required. If a dependency Task is not succeeded, worker-start fails with `deps_unmet`. `task-list --ready` returns the Tasks you can start now: start the independent ones together (a wave), then start the next wave when they finish. deps mean order only: where the earlier Task's output lives must be written in the later Task's spec.
- If a person or the coordinator must decide something before a Task starts, put a gate on it with `gate-create` (unresolved gates fail with `gate_pending`). A gate is not a substitute for a worker's question (ask).
- A settled worker's tab can be reused for the next Task with `worker-start --task <next> --terminal <tabId>` (same provider and path). When you no longer need it, `worker-cleanup` closes the tab and deletes the worktree. This differs from release (ending supervision), and uncommitted changes are lost.
- The app note `worker_tab_missing` means a worker's tab disappeared (its execution state is unknown): check, then abandon.

### Worker (when your prompt starts with "[Sudal orchestration · worker contract v…]" or "[Sudal 오케스트레이션 · 워커 계약 v…]")

Copy the commands from the preamble exactly as given (--run/--dispatch/--capability). Rules:

- Do only that Task.
- To ask the coordinator something, use `orch ask`. It blocks; on a timeout, wait for the same question again with `--resume <message_id>` (do not create a new question).
- Read the coordinator's follow-ups with `orch check` before starting a new file, after running tests, and right before reporting. If there are messages, act on them and then confirm with `orch check … --ack <ackSeq>` using the `ackSeq` from the response. Until you confirm, the same follow-ups come again. This `ackSeq` is the worker's; it is not the coordinator's `delivery_id`.
- If `consumer_fenced` comes back, stop immediately.
- Send the completion report exactly once with `orch send --type worker_done --outcome succeeded|failed`. Do not hide a failure inside the body.
- After reporting, do not start new work; end the turn.
- Do not start other workers or create a Run.
- If there are unread follow-ups, the report is rejected with `followup_pending`. Check first.

## Handoff (passing work to another tab)

Create a new tab, send it a briefing, and stop once you have confirmed it was received (`send.ok:true`). Do not `wait` unless the request was to wait until that tab finishes.

```text
sudal tab new --ws <name> --cwd /abs/repo --provider codex --title "<job name>" --prompt "<briefing>" --json
```

## Rules

- Sending a prompt to the tab the person is looking at (`active`) cuts into their conversation. Unless the user said so, create a new tab and use that.
- `--policy full` runs without approval. Use it only when the user allowed it.
- Do not wait on your own tab: `tab wait --tab self` and `tab send --tab self --wait` can never finish, because the tab is done only when your current turn ends. The CLI rejects them with `self_wait`. Use `--tab self` when you need your own tab id, for example `sudal tab status --tab self`.
- The `blocks` in `read` are in order, oldest first. `kind` is one of user · assistant · tool · turn · error · notice · compacted · review (cross-review) · verify (verify result) · fanout (fan-out) · orchestration (orchestration card).
- If the app is not running, commands fail with `not_running` (`skills get` and `--help` still work). Ask the user to open the app, and stop.
