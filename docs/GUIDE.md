[한국어](GUIDE.ko.md)

# Sudal Feature Guide

This document covers what each feature does and how it works. If you're new, start with the [README](../README.md).

## Keyboard shortcuts

⌘T new session · ⌘W close (the code or browser tab if focus is in one, otherwise the session) · ⌘1~9 go to tab · ⌃Tab / ⌃⇧Tab next / previous tab · ⌘K switch workspace · ⌘F search chats · ⌘B collapse / expand sidebar · ⌘⇧T reopen closed code / browser tab · ⌘J terminal panel ·
⌘⇧E widen code / browser view ·
⌘⇧↓ / ⌘⇧↑ next / previous "Needs response" session (waiting for permission, or finished and unread; clicking "Needs response N" in the sidebar does the same)

Rename a session by clicking the title in the header or double-clicking its tab. A name you set yourself isn't overwritten by the automatic title from the first message; save it empty to go back to the automatic title.

## Sidebar

A workspace isn't a real directory; it's a label for a unit of work. You create one with just a name (the + in the sidebar, or type a name in the ⌘K palette), and pick the working directory per session
with the path button in the header. Changing the path starts a new provider session and keeps the conversation history. A new session in the same workspace
inherits the active session's path, and you can also set a default path from the workspace's right-click menu.

The left side is the workspace tree. Each workspace row has its sessions underneath (open sessions in tab-bar order, closed ones dimmed, most recent first).
Hover over a row and an × appears: it closes an open session, or asks to confirm deleting a closed one. The + on a workspace row opens a new session in it,
and clicking the row collapses it (remembered). Right-click menu: for sessions, Close / Open, Rename, Delete; for workspaces, New session, Collapse, Remove.
Collapse the sidebar with ⌘B (or the panel icon in the header); the state is saved and stays when you turn it back on. It doesn't disappear entirely but leaves a 52px strip, because on macOS the
traffic-light buttons float inside the window (`hiddenInset`), so a width of 0 would leave those buttons covering the content. The strip keeps buttons for expand, switching screens, new session, and
chat search, plus a button for sessions that need a response, shown as an icon only.

The refresh in the "Subscription limits" block at the bottom reads Claude by running the `/usage` local command through the SDK (no model call, no cost), and rescans
transcripts for Codex. The limits block on the Usage screen has the same button.

## How turns run

One Claude CLI process is kept alive per tab (SDK streaming input, the session pool in `src/main/claude-adapter.ts`), and only the user message is streamed in each turn.
Opening a fresh `query()` every turn, as it used to, cost 3 to 5 seconds each time for process startup, MCP server connections, and session restore (measured: time to first token 9 seconds cold, 2 seconds warm).
Interrupt uses `interrupt()` (the process stays; if there's no result within 8 seconds it's terminated), permission policy uses `setPermissionMode`, and the model uses `setModel`. Switching between bypass and non-bypass
is tied to a startup flag, so it starts a new process. The process is shut down when the cwd or session id changes, or on clearing the conversation, switching provider, detaching a tab, entering terminal mode, or quitting the app,
and it shuts itself down after 10 minutes without a turn (it starts again on the next turn). The permission-request callback is routed to "the turn currently in progress".
**Warm-up**: The process is started ahead of time when you activate a tab, when you change the cwd, provider, or policy, and for the active tab right after the app starts (`SessionManager.warm`), so even the first turn starts warm.

**Codex** works the same way. One `codex app-server` (JSON-RPC over stdio, `src/main/codex-app-server.ts`) is kept alive per tab, continuing the thread and sending only `turn/start` each turn
(measured time to first token: 15 seconds cold, 3 to 5 seconds warm). Interrupt uses `turn/interrupt`, and policy and model are passed as parameters each turn. Approval requests (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`) arrive as server requests and flow into the app's permission card, so Codex now really asks too: ask is `approvalPolicy: untrusted` plus a read-only
sandbox (a request for every untrusted command and write), auto_edit is `on-request` plus workspace-write (changes inside the working directory and network access are allowed; anything beyond that is requested), and full is `never` plus full access. For older CLIs without an app-server, it falls back to
the SDK exec path (`codex exec` each turn, sandbox only, no approvals).

## Slash commands

Type `/` in a Claude tab's input box and the commands available in that workspace appear (built-in, skills, `.claude/commands`, plugins).
↑↓ to move, Tab/Enter to select, Esc to close. The list comes from briefly launching the CLI without a prompt and reading the initialize response (`src/main/claude-commands.ts`,
no turn, no cost), and is cached per cwd. It refreshes when a `commands_changed` push arrives mid-turn. Terminal-only commands like `/exit` and `/resume` are
hidden. Codex tabs have no such API, so nothing appears there.

Commands the app handles itself (`src/shared/app-commands.ts`, marked "handled by the app" in the palette): `/model` opens the model picker, and with an argument like `/model opus` it
changes this session's model right away (`/model default` goes back to the CLI default; applies from the next turn, the session is kept, and the header shows the model you set). `/config` opens the settings screen.
Both exist because the TUI screens can't be shown in SDK mode. These commands aren't sent to the CLI, so they don't appear in the conversation history either.

`/mcp` returns only a one-line summary in SDK mode, so it isn't sent to the CLI; it opens the Settings → MCP servers screen instead. That screen reads each server's connection status, errors, and tool list
read-only in the same way (a CLI without a prompt + `mcpServerStatus()`, `src/main/claude-mcp.ts`). It waits up to 10 seconds for servers to connect. Reconnecting and toggling on/off apply only to that
process, which makes no sense in an app that starts a new process every turn, so they aren't offered, and OAuth sign-in (needs-auth) has to be done in a terminal.

## Prompt snippets

Save instructions you paste often under a name, and pull them up in the input box with `/name`. In the "/" palette, snippets come before slash commands, and
picking one inserts the whole body into the input box (a command inserts only its name). The scope is per workspace or global ("All workspaces"); the palette shows
global ones plus those for the current workspace. There are two ways to save: the "Snippet" button that appears when the input box has text (you set only the name and scope), and Settings > Snippets
(list, edit, delete). Even in a Codex tab with no slash commands, the palette opens if a snippet exists. They're stored in `userData/snippets.json`, and
removing a workspace deletes the snippets of that scope. The pure logic is in `src/shared/snippets.ts`.

## Prompt queue

Even while a turn is running, write your next instruction in the input box and press Enter (or the "Queue" button) to put it in the queue; when this turn **ends normally**, they're sent
automatically from the top (`SessionManager.promptQueue`). A "N requests to send next" list appears above the input box, where you can click an item to edit it or × to delete it.
If a turn ends with an error, the queue stays as it is and stops (no automatic sending), and "Stop" also clears the queue and any scheduled limit retry. Instructions sent
while waiting for a limit retry go behind the queue and only go out after the retry succeeds. In terminal mode the queue doesn't run and resumes when you come back. The queue holds up to 20.
The queue is saved to `userData/threads/<tabId>.queue.json` on every change (images store only the saved file path instead of base64, and are re-read on restore).
Even if you quit and restart the app, or close and reopen the tab, the waiting instructions are still shown. No turn is running then, so they don't go out automatically: the header
changes to "N queued requests · press Send now to start", and the "Send now" button sends the first one, or they go out in order once a turn you start with a new instruction ends.
Quitting the app or closing a tab keeps the queue, while "Stop", clearing the conversation, and deleting the tab clear it.

## Automatic retry at usage limit (Claude)

When a turn ends with a subscription-limit error (the error text starts with the SDK's limit-message prefix, or a `rate_limit_event` is rejected), that turn is held
and sent again automatically at the reset time (resetsAt from the rejection, or if absent the `|<epoch>` at the end of the error text) + 5 seconds. The user message isn't recorded again
(`src/shared/usage-limit.ts`, `SessionManager.scheduleLimitRetry`). A banner above the input box counts down the time left and offers "Retry now" and cancel. If the reset time is unknown,
only the banner shows, and it stops after 3 consecutive attempts. Stop and clearing the conversation also clear the schedule. Codex isn't covered.

## Context window warning

Take the input tokens in the **last assistant message** of the last turn (input + cache read/write, `turn_result.contextTokens`) and divide by the session model's context window. Above 80%, a warning banner appears
above the input box, and from 95% it turns red (`contextUsage` / `contextWarnLevel`, `src/shared/session-state.ts`; the same number as the context panel gauge). "Compact" leaves compaction to the provider:
for Claude it sends `/compact` through the SDK, and the model decides what to keep. Compaction is a boundary inside the session, so the session isn't cut, and the SDK's `compact_boundary` is received and
left in the conversation as a divider (`Compact · 39k → 6k`). If you want to say what to keep, you can type something like `/compact focus on the auth refactor and drop test debugging`
in the input box yourself (the app doesn't intercept it and passes it along as is). Codex's app-server has no compaction, so it builds the handoff summary below and moves to a new session on the same provider.
SDK `result.usage` is the cumulative total of API requests within a turn (every tool call resends the conversation), so using it as the context size would greatly overcount. That's why it takes the usage of a single message.
Old records without `contextTokens` use an approximation: the cumulative total divided by the number of requests. Dismissal is remembered per tab and holds as you switch tabs; the banner returns when the context fills 5 percentage points more or goes from warn to critical,
and resets when it falls below 80%. Compacting clears the gauge too, via a `compacted` event (fallback: `session_reset`). Codex doesn't report a context window size, so it has no warning.

## Switching providers and handoff

Claude and Codex can't pick up each other's sessions, so when you switch, context passes only as text. If you turn on "Pass a conversation summary as the first message" in the switch modal,
it builds that text, and **by default the side being left writes it itself** (`HANDOFF_BRIEF_PROMPT`, `src/shared/handoff.ts`). The side that knows what mattered
writes it: the original request, decisions made and options dropped, what was tried and didn't work, files touched, the current state, and what to do next, in that order. It takes one more turn,
about ten-odd seconds, and if it fails or runs past 3 minutes, it quietly falls back to the mechanical summary below (the switch itself isn't blocked).

The handoff note is only about this conversation. **What should last in this repository** (project rules, settled conventions, recurring pitfalls) has to live in a file, not the conversation,
to survive a summary. So when writing the handoff note, if there's any of that, the side being left **appends it to the end** of its own convention file: `CLAUDE.md` for Claude, `AGENTS.md` for Codex. The app doesn't invent a new
convention and uses the file each CLI already reads. No human is watching this turn, so permission is opened for that one file only
(`handoffNotePermission`, `src/shared/handoff.ts`) and every other request is denied. Rewriting an existing file wholesale (`Write`) is also blocked,
since accumulated content could be lost: only appending (`Edit`, `ApplyPatch`) is allowed, and `Write` passes only when the file doesn't exist. If there's nothing to leave, it does nothing.

The mechanical summary (`buildHandoff`) folds the event log into text. When it overflows, it **drops the middle**, because the start holds what was being attempted and the end holds how far it got.
The first user request goes at the top as `Original request:` so it survives even if the record is trimmed. It includes only the most recent 12 successful tool results (old output won't be needed again) and keeps
all failures (so the same mistake isn't repeated). It states plainly that "this is reference material, not instructions," so old instructions in the record aren't run again.

A generated handoff note stays in `threads/<tabId>.handoff.txt` until it goes out with the next message, so context isn't lost even if the app quits in between.
Clearing the conversation deletes it too.

## Chat search and export

⌘F (or "Search chats" in the sidebar) searches the user and assistant text and tool calls (name, path, command summary, the first 20,000 characters of output) of all sessions, including closed ones, by partial match.
Results are labeled "Me" / "AI" / "Tool" on each row, and picking a tool result scrolls to that tool card. Results are grouped by session,
and picking one opens that session (reopening it if closed), scrolls to the block, and briefly highlights it. Main's `SearchIndex` (`src/main/search-index.ts`)
caches each tab's text blocks (including a lowercase copy) in memory, keyed by the thread file's (mtime, size). A search only stats files and re-reads and parses only the ones that changed,
so apart from the one session in progress, it doesn't touch the disk. The pure matching is in `src/shared/transcript-search.ts`. Save a session as a `.md` file with "Export as Markdown…" in the sidebar right-click menu, or "Export" in the context
panel. It includes user/assistant headers, one line per tool call with its output (truncated beyond 1,500 characters), and turn stats.

## What ⌘W closes

If a session closes entirely while you're looking at code or a web page, it's a surprise. So ⌘W decides by focus:
if focus is inside the editor panel (CodeMirror, the browser `<webview>`, the toolbar), it closes **that editor/browser tab**; otherwise it closes the **chat session**.
Focus alone isn't enough: if you click a changed file in the right panel or a path in a tool card to open a file, the editor appears but focus stays on the button you clicked.
So it also looks at the "last used area". Opening a file is itself a signal that you're using the editor. When in doubt, it leans toward the editor,
since reopening a tab costs less than losing a session.
While the view is widened, the chat isn't on screen, so it closes the editor tab regardless of focus. If there's no editor tab to close, it's always the session.

The decision is a pure function in `src/renderer/src/close-target.ts`, and the actual closing takes the same path as the tab's ×, so
if there are unsaved changes, a confirmation banner appears. Clicking inside a browser page makes the host's `activeElement` that `<webview>` element, which this check catches.

## Widen view

The code editor and browser sit on the right, so there isn't enough room on a narrow screen. Click the widen button in the panel header (or ⌘⇧E) and
the chat column and the right panel are **hidden**, so the whole window is used. They're only hidden, not torn down, so the chat scroll position and half-written input,
the editor's cursor and undo, and the page the browser was viewing all stay alive. The same button restores it.

It's remembered separately per chat tab (`maximized` in `editor-tabs.ts`, saved to renderer-state.json), and collapsing the panel or closing the last file
releases it too, so that when you next expand it you don't return to a screen where the chat is gone.

## Code editor (split panel)

Click a changed file in the context panel (double-click or the open icon), the file tree, or a path in a tool card (Read/Edit/Write/MultiEdit/NotebookEdit), and
an editor panel opens to the right of the chat (`EditorPane.tsx`). Each file gets a tab (up to 12; files with the same name show their parent folder), and hidden tabs stay mounted so the cursor and undo remain.
Drag the left edge to change the width (360~1200px, saved), and collapse or expand with the panel's collapse button or "Code N" in the header. The list of open files is remembered per chat tab
(`editor-tabs.ts`). Each file is edited right in CodeMirror 6 (`CodeEditor.tsx`, `FileEditor.tsx`) and written with ⌘S or "Save". A file that differs from HEAD is edited in
`@codemirror/merge`'s unified view, with deleted lines slotted in as red and changed lines painted green. Saving doesn't recreate the editor, so
the cursor and undo are kept. Unsaved tabs are marked with a dot, and closing one asks "Save and close / Discard and close / Keep editing". If the file was changed outside after you read it,
saving shows a conflict banner offering "Overwrite with my content / Reload from disk". Saving is allowed only inside the session's repository (or the working directory if there's none).
The language is lazy-loaded by file name. Binary files and files over 1MB get a read-only notice only. Images (png/jpg/gif/webp/bmp/ico/avif/svg, up to 12MB) are
passed by main as a data URL, and the editor shows a preview on a checkerboard (with size and file weight, toggling between fit-to-screen and actual size; SVG is also drawn only as an `<img>`). Markdown (`.md/.markdown/.mdx`) first opens as a preview
rendered by the same renderer as the chat with document styling (`.md-doc`: large headings and dividers, a 780px reading width, striped tables), and you switch with "Edit" in the header (what you're editing is reflected in the preview as is, and the editor is only hidden so undo stays). Clicking the path of a Read tool card
selects that call's `offset`/`limit` line range and opens it scrolled to the center (if it's already open, it just moves).

**Language servers**: The server specs are in `src/shared/lsp-servers.ts`: TypeScript/JavaScript (`typescript-language-server --stdio`, `.ts/.tsx/.js/.jsx/.mjs/.cjs`) and
Python (`pyright-langserver --stdio`, `.py/.pyi`). A new language is added with one spec entry (executable, arguments, extensions, install notes). When you open a file a server handles, one process starts per (server, repository root)
(`src/main/lsp.ts`, relaying Content-Length frames over IPC), and CodeMirror's `@codemirror/lsp-client` attaches to it (`src/renderer/src/lsp-client.ts`).
You get type-based autocomplete, error diagnostics (gutter, underline, tooltip), hover, signature help, go to definition (F12), find references, and rename, and an "LSP" badge appears in the status line.
Servers are found on PATH (absolute-path entries only; you can also set each server's executable path directly in Settings > Find CLIs > the Language servers card, `lspServerPaths`), and if one isn't found, you get syntax highlighting only, with no badge.
Install with `npm i -g typescript-language-server typescript` and `npm i -g pyright`. The typescript package is looked up in this order: bundled with the server → `tsserver` on PATH → the project's `node_modules`, and it's slotted into
the initialize request's `tsserver.path` (without it, the server errors with "valid TypeScript installation"). The project's copy goes last so that just opening a repository
doesn't run the `tsserver.js` inside it (VS Code also defaults to the bundled version). Server children get only a minimal env such as PATH and HOME.
The server root is decided not by the renderer but by main, from the tab's cwd (the top level of the repository), and file read/write/operations/listing, git, MCP status, and server start are accepted only from the actual tab/workspace cwd (or inside it).
The tab cwd and the workspace path itself are accepted only inside roots the user picked in the directory picker (plus paths used in previous runs, and worktree roots), so the renderer can't widen the boundary
(you can add a root for verification with `SUDAL_APPROVED_ROOTS=path:path`).
If a server dies, the badge goes off and it's started again from the next file. When no TS/JS document is open (main counts `didOpen`/`didClose`) for 3 minutes,
the server is shut down, and started again the next time a file opens (adjust with `SUDAL_LSP_IDLE_MS`). Quitting the app ends the servers too.
Launch with `SUDAL_DEBUG_LSP=1` and the JSON-RPC round trips are written to the main log.

**File tree operations**: Right-click an item in the right-hand "Files" tab for a menu of Open / New file / New folder / Rename / Move to Trash (right-click on empty space or the + in the header makes a
new file or folder at the root), and the name is typed in place (Enter to confirm, Esc to cancel, and for files everything before the extension is selected). Creating and renaming are allowed only inside the session's repository, with no overwriting
(a rename that only changes case is allowed only when it's the same inode; on a case-sensitive volume it's a different file, so it's refused). For symlinks, the link itself is moved or deleted
and the target is left alone (a link pointing outside the repository can still be renamed or deleted, but creating or writing through it is refused). Deleting sends the item to the macOS Trash after confirmation, so it can be undone (`shell.trashItem`). If a file that was renamed or deleted is
open in the editor panel, the tab path follows the rename or the tab closes, but a file with unsaved changes (including any under a folder) can't be renamed or deleted:
save or close it first. When the 12-tab editor limit forces an old tab to close, tabs with unsaved changes are skipped too. Only changed directories are re-read, so the expanded state is kept.

## Git commits in the app

The "Changed files" in the right context panel use checkboxes to choose what to commit (everything by default, and new files are selected automatically). Write in the message box below
and press "Commit N" (⌘⏎ works too), and it commits **only those files** with `git add -A -- <chosen files>` then `git commit -- <chosen files>`. The staging state of other files
isn't touched, and files that disappeared after you looked at the list are skipped. While a turn is running, files may be mid-edit, so the commit button is locked.
"Draft" sends the chosen files' diff (up to 40KB) and the 8 most recent commit titles to Claude haiku once, and fills the box with the message it returns
(`src/main/git-draft.ts`: a one-off query with no session history, user settings, or MCP, and no tools). It doesn't push.

**Review changes**: Click "Review" in the section header and an overlay covering the chat opens (`ChangeReview.tsx`). On the left is the file list (checkbox = commit target,
kind, +/-), and on the right is the chosen file's diff against HEAD (the same hunk folding as the file viewer; new and deleted files show the full content). The revert button that appears when you hover over a file row
takes a two-step confirmation, then does `git checkout HEAD -- file` (modified, deleted), deletes the file or `git rm` (new file), or restores the old path and removes the new one (renamed).
It can't be undone (`gitRevert`). The commit bar below shares the same state (`useGitChanges`) as the panel's commit form. While a turn is running, commit and revert are locked.

**Browser tab**: "Browser" in the header opens a browser tab in the editor panel. Clicking a link in the chat or a Markdown preview shows an "In-app browser / Default browser"
choice popup, and "Don't ask again" remembers it (`localStorage` `workbench.linkOpenMode`; ⇧-click asks again, ⌘-click or middle-click goes straight to the default
browser, and ⌥-click goes straight to the in-app browser).
The address bar (without a scheme, localhost/IPs get http and everything else gets https; anything with a space is a search), back/forward/reload, and open in default browser. It uses an Electron `<webview>`, and
main's `will-attach-webview` locks it to no preload, no node, sandboxed, and http(s) only, and a new window from the webview opens in the same webview. Cookies and storage are separated from the app by the
`persist:sudal-browser` partition.

**Logins survive quitting and restarting the app.** Cookies with an expiry already stay on disk because the partition is `persist:`, but login sessions are usually session cookies with no expiry, and
Chromium throws them away on quit (it keeps them only in memory). So on quit it writes down the session cookies and puts them back on launch, the same mechanism as Chrome's "Continue where you left off"
(`src/main/browser-cookies.ts`). It adds no expiry when restoring, so they stay session cookies by nature, and host-only cookies get no `domain`, so they
don't spread to subdomains. Restoring finishes before the window (the webview) is shown, so you're logged in from the first page.

This keeps login credentials in the app data directory (`browser-session-cookies.json`, readable by the owner only) **in plaintext**. It was once encrypted with `safeStorage` (Keychain), but
that was reverted: using the Keychain makes macOS ask for access permission, and since this app is ad-hoc signed, it asks again with every build change. This **accepts** the risk of exposing session
credentials to anyone who can read this file (not because the protection is the same, but because for a local tool used by one person, the prompt burden was judged greater than that risk).
If an `.enc` file from the encrypted days is still there, it's deleted without decrypting, because decrypting is the moment the prompt we wanted to get rid of would appear, and logins are dropped that one time.
You can turn it off in Settings > General, and turning it off deletes what was written down right away. Navigation of the main window itself is blocked with `will-navigate` and sent to the external browser.

**Tabs show a favicon and the page title**, like Chrome. A favicon is a remote address, so the screen can't use it as is: the renderer CSP is `img-src 'self' data:`,
and loosening that would let the app screen fetch arbitrary remote images. So main fetches it through the browser partition and passes it over as a data URL
(`src/main/browser-favicon.ts`; http(s) only, `image/*` only, up to 128KB, remembered per address). If it can't be fetched or the site doesn't provide one, it falls back to a globe.

**The address bar remembers past visits.** As you type, it shows matching addresses from history (pick with ↑↓ and go with ⏎), with ones whose host starts with your text at the top:
typing just `loc` brings up `localhost:3000`. At equal rank, places you visit often come first, then recent ones, because during development you open the same address over and over.
History is one shared by the whole app (so you can find it next time whichever tab you opened it in) and keeps up to 200 entries. The ranking is a pure function in `src/shared/browser-history.ts`.

**Hard reload (⌘⇧R, or ⇧-click the reload button)** ignores the cache and fetches again. Use it when you fixed something but the screen looks the same. A normal reload (⌘R) only
asks the server with `max-age=0`, while a hard reload fetches with `no-cache`.

**Reopen closed tab (⌘⇧T)** brings back the code or browser tab you just closed. For a browser tab, the address it was viewing comes back too, because restoring only the key would leave a blank tab.
It remembers up to 10 per chat tab (a closed chat session stays in the sidebar, so it isn't covered here).

**Shortcuts are taken over only while you're looking at the browser**: `⌘F` becomes **Find in page** instead of chat search, `⌘L` goes to the address bar, `⌘R` reloads, and `⌘⇧R` hard-reloads.
It uses the same decision as ⌘W (`browser-active.ts`), so while you're using the chat, the original behavior stays. (The window reload gives up ⌘R and remains only in the menu.)

**Viewport width presets** let you check a narrow screen without shrinking the window: Full, Phone (390), Tablet (834), and Desktop (1280).
A preset wider than the panel follows the panel width, so use it together with widen view (⌘⇧E). **Zoom** is the −/percentage/+ in the toolbar, and clicking the percentage returns to 100%.

**Agents operate the browser directly.** Models can't see the screen, so until now a person had to hand it over with "Attach diagnostics". Now they read and click through the `sudal` CLI directly.

```bash
sudal browser read                                  # visible text + clickable items (with selectors)
sudal browser click --text "Save"                    # or --selector "#save"
sudal browser fill --selector "#email" --value a@b.c
```

`read` returns the body text (up to 20,000 characters) and up to 60 buttons, links, and inputs with their selectors and labels, so the model can decide what to click next. `click --text`
picks the **one with the shortest text** among the visible matches (so it catches the actual button rather than an outer container). `fill` sets the value with the prototype's native setter and
fires input and change, so frameworks that intercept values, like React, update their state too. The injected scripts are pure functions in `src/shared/browser-control.ts`, and selectors and input values are always
carried through `JSON.stringify` so quotes and backslashes can't break the code.

The target is **the one browser currently visible in that chat tab**. The renderer registers the webview's webContentsId with main on `dom-ready` (when only the element exists it
isn't attached yet, and asking for the id throws), and hidden tabs aren't registered, because an agent shouldn't operate a screen you can't see. If there's no browser, it says
"Open one first with `sudal browser open --url …`".

The toolbar has three more tools. **Pick element** injects a script into the page and pastes the clicked element's HTML and styles plus a screenshot of its area into the chat input box.
**Developer tools** opens that webview's console, network, and element inspector. **Attach diagnostics** attaches the current screen capture, console warnings and errors, and failed requests in one bundle,
which is the only channel, since the model can't see the browser's state. The renderer collects the console with `console-message` (cleared when the page changes),
and main collects failed requests (`src/main/browser-net.ts`; there's only one webRequest listener per session, so it's hooked in one place and tabs are told apart by `webContentsId`).
It lists network errors and 4xx/5xx separately, and if there are no errors at all it says "none" clearly, because the model has to tell "I couldn't see" from "I looked and it was clean".
The address you navigated to within a tab is kept outside (`browserUrls` in `editor-tabs.ts`), so even if you switch chat tabs or collapse and expand the panel, it returns to that page.

## Verify (tests and builds)

"Verify" in the header runs the commands saved for the workspace (for example `yarn typecheck`, `yarn test`) one after another in this session's working directory, and
leaves the results in the conversation as a card (`VerifyRunner` in `src/main/verify.ts`). You set the commands with the edit button next to it, and the first time it fills in suggestions from the manifest
in the cwd. Each command's exit code and output tail pile up on the card, and if any command failed, the card stays red so
you can follow up by telling the model to "fix this result". Unlike when the model runs tests itself, only the commands you set run, with no approval.

## Fan-out (the same instruction to several models)

"More" → "Fan-out" in the header sends the same instruction to 2 to 4 isolated sessions at once. Each session gets its own new isolated worktree and tab
(`fanout-a-claude-…`) so they don't touch each other's files, and you can pick the provider and model per session. The original purpose is to give Claude and Codex the same job
and pick between them. A fan-out card stays in the original tab and updates each session's progress, change stats, and answer summary every second.

When they finish, "Compare" on the card lays each session's diff side by side (the union of files on the left, a column per session). "Adopt" takes that session's worktree,
makes it into one patch against the merge-base, and applies it to the original working tree (commits, working tree, and new files together, without touching the index).
It refuses if this isn't the repository the fan-out was created from, and if the original tab has a turn running, it applies after it finishes.

**Cleanup isn't automatic.** Only pressing "Delete worktrees" on the card deletes each session's worktree and closes its tab (with one confirmation). Adopting doesn't clean up,
so you can keep looking at the comparison, but if you don't press it, the worktree folder (by default `~/sudal/worktrees/`) stays.

## Cross-review (Claude ↔ Codex)

"More" → "Cross-review" sends the working tree's changes (diff) to a new tab on the **other provider** for an independent review. Codex looks at what was written with Claude, and
Claude looks at what was written with Codex. The review tab opens in the same workspace with the ask policy, and the active tab returns to where it was, so what you were doing
isn't interrupted. A review card stays in the original tab showing progress, and when the review tab's turn ends (up to 30 minutes), the answer is copied to the card.
If the working tree is clean, there's nothing to send, so it refuses.

## Orchestration (coordinator and workers)

Run several sessions under one goal. Put Tasks inside a Run, and for each Task launch a Dispatch (= a worker tab) to hand the work to.
Workers run in isolated worktrees and can ask the coordinator (ask) or report (worker_done), and the coordinator sends an answer (reply) or
a follow-up instruction (send). Put a prerequisite (deps) on a Task and the next one starts only when the earlier one finishes, and a gate lets you make it wait for a human decision.
The record is appended to `userData/orchestration/<runId>.jsonl` per Run, and recovered by replay even if you quit and restart the app.

The coordinator can be a person or a **tab (Claude, Codex)**. The original use is for a tab coordinator to create a Run with `sudal orch …` and direct workers.
In the "More" → "Orchestration" panel you see a Run's Tasks, workers, and inbox, answer a worker's question yourself, decide gates,
and clean up finished workers. "Take over", where a person takes the coordinator role, is also done here.

**There's no UI for creating a Run yet.** For now you start with `sudal orch run-create …`, and the panel is where you handle a Run that already exists.

## Controlling from outside the app (sudal CLI)

Install the sudal CLI under Settings > General > "CLI and agent skills" and `~/.local/bin/sudal` is created. It connects to the running app over a Unix socket (`userData/control.sock`, 0600)
to control workspaces, tabs, and sessions: `sudal tab new --prompt …`, `tab send --wait`, `tab read`, `tab verify`, `tab fanout`,
`orch …`, `file open`, `browser open`. A tab selector takes `self` (the tab of the agent running the command), `active` (the tab on screen), an id, an exact title, or a unique prefix.
"Install skill" on the same screen installs a usage guide into Claude Code (`~/.claude/skills`) and Codex (`$CODEX_HOME/skills`).
That's how **an agent inside the app can control the app it lives in**: open a new tab and hand off work, launch workers, or read back results.

## Background task indicator

Even after a turn ends and the tab shows "idle", work may remain. That's the case for a Codex task handed off to the background: that process is detached from the app
(its parent is launchd), and when the turn ends the sub-agent mirror is shut down too, so it used to show nothing on screen for the 10 minutes it ran, and there was no notification when it finished.
Now it reads the job list that Claude Code plugins leave behind (the jobs in `<claude>/plugins/data/*/state/*/state.json`), finds the tab by `sessionId`, and,
while a job is running, shows one line below the conversation (kind, elapsed time, instruction summary) (`src/main/background-jobs.ts`). When it ends, the line disappears and a notification appears.
Because this feature relies on someone else's file format, if the format changes only the indicator quietly goes away, and the app keeps running as before.

## Isolated sessions (git worktree)

Running several sessions in the same repository makes them step on each other's files. In the sidebar, right-click a workspace → "Isolated session (git worktree)" and it creates a branch `sudal/<slug>` and a worktree
from the repository (the active tab's working directory or the workspace's default path), then opens a new session with that path as its working directory
(`src/main/worktree.ts`). The worktree goes outside the repository at `<worktree folder>/<repo>/<slug>` (by default `~/sudal/worktrees`, changeable in Settings > General > Storage location), so it doesn't show up as untracked in the original. You can't pick a folder inside the repository. Click
the branch chip in the session header to see the number of commits and uncommitted changes against base, and "Merge changes" runs `git merge --no-edit <branch>` in the original repository (only when the original is on the base
branch and neither side has uncommitted changes; on a conflict it rolls back with `merge --abort` and notifies you). "Clean up worktree" deletes the folder and returns the tab to the original path
(if there are uncommitted changes, it forces after confirmation; the branch is deleted with `-d` only if it has been merged into base). Deleting an isolated session tab stops its turn and terminal first and then deletes the worktree,
and if there are uncommitted changes, it keeps the tab and notifies you. If the original is in a detached HEAD or the base branch is gone, creating and merging are refused.

## Schedules (at set times)

Create them under Settings → **Schedules**. At the set time, a new session opens and the prompt is sent, and each run leaves a result
(`src/main/schedule-engine.ts`, `src/main/schedule-store.ts`). It only wakes up and looks every 30 seconds, so the app has to be open for it to run.

Pick the repeat from presets (Every hour, Every day, Weekdays, Every week), and for anything else choose "Custom" and write a 5-field cron. The time zone is
pinned by IANA name, so the schedule doesn't move if the Mac's time zone changes (`src/shared/cron.ts`). Before you save, it calculates and shows the next run time,
so that's where you confirm when your choice really runs. It won't save if the name, the message to send, the cron, or the target is missing (the screen and the CLI use the same validation).

**A run's status isn't just success or failure.** The reasons it "didn't run" differ, and the reason is itself the information you need:
`Completed`, `Failed`, `Waiting for approval`, `Interrupted`, plus four kinds of skip (`nothing to do`, `missed its time`, `couldn't run`, `previous run still going`).
The end is judged from SDK signals (`src/shared/run-completion.ts`): if background tasks remain, or the CLI has a turn scheduled to continue on its own,
it isn't over yet. A run whose end couldn't be seen because the app died is left as `Interrupted` on restart, and is never turned into a success.

- **Isolated session**: When on, each run creates a worktree and runs inside it. Since this runs while no one is watching, it's especially recommended together with "Fully automatic" permissions.
- **Permissions, model, and provider** use the values fixed in the schedule. If you switch a tab to "Fully automatic" during the day, that shouldn't raise the permissions of a schedule that runs at dawn.
- **Grace**: If it wakes up this far past the scheduled time, that run is skipped (120 minutes by default, CLI `--grace`, up to 720 minutes). It doesn't run in a batch the runs missed while the app was off.
- **Precheck**: One shell command runs first; exit code 0 means run, and 1 means skip as "nothing to do". Any other code or a timeout is recorded as a *failure*, kept distinct: "no changes" and "the command is broken" are different things.
- **Budget**: If the monthly budget is exceeded, it quietly stops.

It works from the terminal too:

```bash
sudal schedule add --name morning-check --cron "30 9 * * *" --prompt "…" --ws repo [--worktree] [--policy full]
sudal schedule list | runs --id <id> | run --id <id> | set --id <id> --enabled false | rm --id <id>
```

## Terminal

⌘J or the "Terminal" button in the chat header opens a terminal panel below the chat (`src/renderer/src/components/TerminalPanel.tsx`, xterm).
You can have several terminal tabs in the panel (add with +, quit with the tab's ×). The shell starts as a login shell (`$SHELL -l`) in the session's working directory, and
it gets PATH from the same shell environment the app uses for CLI detection, so you can run `claude`/`codex` right away. Collapsing the panel with "−" keeps the processes and
scrollback, and the "×" in the header quits all of that session's terminals. The processes are managed by main's `src/main/terminals.ts` (node-pty)
as "<session id>:<name>", with the most recent 200KB of output kept as a backlog, so the screen is restored even if you go to another session and come back.
The CLI in hybrid mode comes in as the `cli` tab. Drag the top edge of the panel to change the height.

## Continue in terminal (hybrid)

Click "Continue in terminal" in the session header and it launches the CLI in the terminal panel with the same session id (for Claude `claude --resume <id>`, or `--session-id <id>` for a new session;
for Codex `codex resume <id>`). Meanwhile the chat input is locked, and it tails the record file the CLI leaves (`~/.claude/projects/**/<id>.jsonl`,
`~/.codex/sessions/**/rollout-*.jsonl`) and draws the conversation into the chat screen as it goes (`src/main/transcript-mirror.ts`). When you quit the CLI (/exit) or
click "Back to chat", control returns to the app, and the next message has the SDK resume the same session. Use CLI-only features like /resume, /login, and plan mode
in the terminal stretch, and streaming and the in-app permission cards in the chat stretch. Mirrored turns have no cost information, so the stats line shows only time and tokens.
If the CLI ends before the first message and there's no record file, the session id is discarded and it starts as a new session.

**Permission-waiting hint**: When launching `claude` in terminal mode, it injects hooks (PermissionRequest/Stop) with `--settings` so
the stdin JSON is left in `userData/hooks/<session id>.jsonl` (in addition to the hooks in the user's settings, and making no decisions; the log path is
written directly into the command, and the directory is emptied at startup). The app tails this file, and
when a permission dialog appears, it changes the chat banner to a warning color, "Waiting for permission approval in the terminal: Bash `git push`", and gives a "Show terminal" button.
The hook only says "it appeared", so if Enter / a lone Esc / a number / y / n is typed into the CLI pty, it counts as answered and takes the hint down (ESC sequences like arrow keys are ignored),
and it also takes it down when that tool's tool_result is left in the record or the turn ends (Stop). The log file is deleted when the CLI exits.
For Codex there's no way to inject hooks per run (it needs `~/.codex/hooks.json` + trust), so it judges from the pty output text (`src/main/codex-approval.ts`):
it joins the recent ANSI-stripped output and looks for "$ <command> › 1. Yes, proceed (y)" or "Allow Codex to run `…`" (command execution) before the choices,
"Codex wants to edit …" (file edit), "grant these permissions" (permission request), MCP tool approval text (tool execution), and for anything else the "Yes, proceed (y) … Press enter to confirm"
choice frame (approval request), and turns on the hint; "Approved action:" or the same key inputs as above take it down. It relies on TUI text, so if Codex
changes the text, it may quietly stop working (as of codex-cli 0.153).

## Usage dashboard

It reads `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl` and totals terminal and app usage.
Cost is an **API-equivalent estimate** based on a model price table (USD/MTok) and differs from subscription (OAuth) billing. File changes are detected with `fs.watch` and
scanned incrementally after 2 seconds (using `claude` in a terminal usually shows up within 15 seconds).

## Storage location

`~/Library/Application Support/Sudal/` (if the old `ai-workbench/` folder exists, it's moved automatically on first launch). You can open the folder directly from Settings > General > Storage location.
- `workspaces.json` — workspace and tab metadata (title, provider, policy, provider session id)
- `threads/<tabId>.jsonl` — per-tab event log (replayed on restart, reopening closed tabs) · `threads/<tabId>.queue.json` — instructions queued while working
- `renderer-state.json` — input box drafts, open editor files, split view, terminal layout (written the moment they change) · `schedules.json` — scheduled prompts
- `browser-session-cookies.json` — cookies for keeping in-app browser logins (deleted if you turn it off in settings)
- `cli-overrides.json` — manual CLI executable paths
- `attachments/` — pasted images
- `usage-cache.json` — transcript scan cache (incremental by file mtime/size)
- `inapp-sessions.json` — provider session ids started in the app (to tell in-app from terminal in usage)
- `settings.json` — monthly budget and so on · `pricing.json` (optional) — overrides the model price table. The format is `DEFAULT_PRICING` in `src/shared/usage.ts`
- `logs/main.log` — main console (SDK errors, unhandled renderer exceptions, process crashes). It rotates to `main.1.log` and `main.2.log` every 5MB.
  Open it directly with "Open folder" at the bottom of the settings screen.
- `slash-commands.json` — cache of the Claude slash command list per workspace (cwd)
- `snippets.json` — prompt snippets · `rate-limits.json` — the last observed subscription limits
- `worktrees/<repo>/<slug>/` — worktrees created by older versions (still usable). New worktrees go in the worktree folder (by default `~/sudal/worktrees/`).
- `orchestration/<runId>.jsonl` — the raw events of a Run (restart recovery)
- `control.sock` · `control.json` — the socket the sudal CLI connects to, and its location
- `hooks/<session id>.jsonl` — hook log for the terminal-mode permission-waiting hint (deleted when the CLI exits)
