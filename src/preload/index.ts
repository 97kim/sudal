import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { BrowserEventDto, ScheduleListDto } from "@shared/ipc";
import type { SnippetDto } from "@shared/snippets";
import type { BackgroundJobDto } from "@shared/background-jobs";
import type { PermissionAnswer } from "@shared/chat-events";
import type { UsageFilter } from "@shared/usage";
import {
  IPC,
  type ChatEventEnvelope,
  type ChatSendDto,
  type Provider,
  type RendererErrorDto,
  type ShortcutName,
  type ControlOpenDto,
  type UpdateStatusDto,
  type UsageSettingsDto,
  type WorkspaceStateDto,
  type FanoutStartDto,
  type SessionConfigDto,
  type SessionSnapshotDto,
  type TerminalInfoDto,
  type SwitchProviderDto,
  type AppSettingsDto,
  type SudalApi,
} from "@shared/ipc";

const api: SudalApi = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    checkUpdate: () => ipcRenderer.invoke(IPC.appUpdateCheck),
    runUpdate: () => ipcRenderer.invoke(IPC.appUpdateRun),
    updateStatus: () => ipcRenderer.invoke(IPC.appUpdateStatus),
    onUpdateChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, status: UpdateStatusDto) => listener(status);
      ipcRenderer.on(IPC.appUpdateChanged, handler);
      return () => ipcRenderer.removeListener(IPC.appUpdateChanged, handler);
    },
    relaunch: () => ipcRenderer.invoke(IPC.appRelaunch),
    models: (provider: Provider, opts?: { force?: boolean }) => ipcRenderer.invoke(IPC.appModels, provider, opts),
    onShortcut: (listener) => {
      const handler = (_e: IpcRendererEvent, name: ShortcutName) =>
        listener(name);
      ipcRenderer.on(IPC.shortcut, handler);
      return () => ipcRenderer.removeListener(IPC.shortcut, handler);
    },
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs),
    openPath: (which: "data" | "worktrees") => ipcRenderer.invoke(IPC.appOpenPath, which),
    pickWorktreeDir: () => ipcRenderer.invoke(IPC.appPickWorktreeDir),
    reportError: (error: RendererErrorDto) =>
      ipcRenderer.send(IPC.rendererError, error),
    getSettings: () => ipcRenderer.invoke(IPC.appSettingsGet),
    setSettings: (patch) => ipcRenderer.invoke(IPC.appSettingsSet, patch),
    onSettingsChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, settings: AppSettingsDto) => listener(settings);
      ipcRenderer.on(IPC.appSettingsChanged, handler);
      return () => ipcRenderer.removeListener(IPC.appSettingsChanged, handler);
    },
    onControlOpen: (listener) => {
      const handler = (_e: IpcRendererEvent, req: ControlOpenDto) => listener(req);
      ipcRenderer.on(IPC.controlOpen, handler);
      return () => ipcRenderer.removeListener(IPC.controlOpen, handler);
    },
    installCli: () => ipcRenderer.invoke(IPC.controlInstallCli),
    installSkill: (agent) => ipcRenderer.invoke(IPC.controlInstallSkill, agent),
    installStatus: () => ipcRenderer.invoke(IPC.controlInstallStatus),
  },
  state: {
    load: () => ipcRenderer.invoke(IPC.stateLoad),
    // send(한 방향): 종료 직전(beforeunload)에도 큐에 실려 나간다
    set: (key, value) => ipcRenderer.send(IPC.stateSet, key, value),
  },
  workspaces: {
    state: () => ipcRenderer.invoke(IPC.wsState),
    add: (path?: string) => ipcRenderer.invoke(IPC.wsAdd, path),
    create: (name: string) => ipcRenderer.invoke(IPC.wsCreate, name),
    update: (workspaceId: string, patch: { name?: string; path?: string; verifyCommands?: string[] }) =>
      ipcRenderer.invoke(IPC.wsUpdate, workspaceId, patch),
    remove: (workspaceId: string) =>
      ipcRenderer.invoke(IPC.wsRemove, workspaceId),
    createTab: (workspaceId?: string) =>
      ipcRenderer.invoke(IPC.tabCreate, workspaceId),
    closeTab: (tabId: string) => ipcRenderer.invoke(IPC.tabClose, tabId),
    reopenTab: (tabId: string) => ipcRenderer.invoke(IPC.tabReopen, tabId),
    deleteTab: (tabId: string) => ipcRenderer.invoke(IPC.tabDelete, tabId),
    activateTab: (tabId: string) => ipcRenderer.invoke(IPC.tabActivate, tabId),
    setVisibleTabs: (tabIds: string[]) => ipcRenderer.send(IPC.tabSetVisible, tabIds),
    renameTab: (tabId: string, title: string) =>
      ipcRenderer.invoke(IPC.tabRename, tabId, title),
    reorderTabs: (openTabIds: string[]) =>
      ipcRenderer.invoke(IPC.tabReorder, openTabIds),
    reorderWorkspaces: (workspaceIds: string[]) =>
      ipcRenderer.invoke(IPC.workspaceReorder, workspaceIds),
    onChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, state: WorkspaceStateDto) =>
        listener(state);
      ipcRenderer.on(IPC.wsChanged, handler);
      return () => ipcRenderer.removeListener(IPC.wsChanged, handler);
    },
  },
  cli: {
    status: (provider: Provider) => ipcRenderer.invoke(IPC.cliStatus, provider),
    candidates: (provider: Provider) =>
      ipcRenderer.invoke(IPC.cliCandidates, provider),
    setOverride: (provider: Provider, binPath: string | null) =>
      ipcRenderer.invoke(IPC.cliSetOverride, provider, binPath),
    refresh: () => ipcRenderer.invoke(IPC.cliRefresh),
    diagnostics: () => ipcRenderer.invoke(IPC.cliDiagnostics),
  },
  usage: {
    query: (filter: UsageFilter) => ipcRenderer.invoke(IPC.usageQuery, filter),
    status: () => ipcRenderer.invoke(IPC.usageStatus),
    rescan: () => ipcRenderer.invoke(IPC.usageRescan),
    refreshLimits: () => ipcRenderer.invoke(IPC.usageRefreshLimits),
    exportCsv: (filter: UsageFilter) =>
      ipcRenderer.invoke(IPC.usageExport, filter),
    getSettings: () => ipcRenderer.invoke(IPC.usageSettingsGet),
    setSettings: (patch: Partial<UsageSettingsDto>) =>
      ipcRenderer.invoke(IPC.usageSettingsSet, patch),
    onChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.usageChanged, handler);
      return () => ipcRenderer.removeListener(IPC.usageChanged, handler);
    },
  },
  orch: {
    list: () => ipcRenderer.invoke(IPC.orchList),
    reply: (runId: string, questionId: string, body: string) => ipcRenderer.invoke(IPC.orchReply, runId, questionId, body),
    followup: (runId: string, dispatchId: string, body: string) => ipcRenderer.invoke(IPC.orchFollowup, runId, dispatchId, body),
    takeover: (runId: string) => ipcRenderer.invoke(IPC.orchTakeover, runId),
    worker: (runId: string, dispatchId: string, action: "retain" | "release" | "stop" | "abandon" | "cleanup") => ipcRenderer.invoke(IPC.orchWorker, runId, dispatchId, action),
    gate: (runId: string, gateId: string, resolution: string) => ipcRenderer.invoke(IPC.orchGate, runId, gateId, resolution),
    close: (runId: string) => ipcRenderer.invoke(IPC.orchClose, runId),
    onChanged: (listener: (runId: string) => void) => {
      const handler = (_e: IpcRendererEvent, runId: string) => listener(runId);
      ipcRenderer.on(IPC.orchChanged, handler);
      return () => ipcRenderer.removeListener(IPC.orchChanged, handler);
    },
  },
  chat: {
    send: (tabId: string, payload: ChatSendDto) =>
      ipcRenderer.invoke(IPC.chatSend, tabId, payload),
    abort: (tabId: string) => ipcRenderer.invoke(IPC.chatAbort, tabId),
    answerPermission: (
      tabId: string,
      requestId: string,
      answer: PermissionAnswer,
    ) => ipcRenderer.invoke(IPC.chatPermission, tabId, requestId, answer),
    configure: (tabId: string, patch: Partial<SessionConfigDto>) =>
      ipcRenderer.invoke(IPC.chatConfigure, tabId, patch),
    snapshot: (tabId: string) => ipcRenderer.invoke(IPC.chatSnapshot, tabId),
    crossReview: (tabId: string) => ipcRenderer.invoke(IPC.chatCrossReview, tabId),
    verify: (tabId: string, opts?: { commands?: string[] }) => ipcRenderer.invoke(IPC.chatVerify, tabId, opts),
    verifyAbort: (tabId: string) => ipcRenderer.invoke(IPC.chatVerifyAbort, tabId),
    verifySuggest: (tabId: string) => ipcRenderer.invoke(IPC.chatVerifySuggest, tabId),
    fanout: (tabId: string, req: FanoutStartDto) => ipcRenderer.invoke(IPC.chatFanout, tabId, req),
    fanoutCompare: (tabId: string, fanoutId: string) => ipcRenderer.invoke(IPC.chatFanoutCompare, tabId, fanoutId),
    fanoutAdopt: (tabId: string, fanoutId: string, variantTabId: string) => ipcRenderer.invoke(IPC.chatFanoutAdopt, tabId, fanoutId, variantTabId),
    fanoutCleanup: (tabId: string, fanoutId: string) => ipcRenderer.invoke(IPC.chatFanoutCleanup, tabId, fanoutId),
    events: (tabId: string) => ipcRenderer.invoke(IPC.chatEvents, tabId),
    clear: (tabId: string) => ipcRenderer.invoke(IPC.chatClear, tabId),
    compact: (tabId: string, focus?: string) =>
      ipcRenderer.invoke(IPC.chatCompact, tabId, focus),
    handoffPreview: (tabId: string) =>
      ipcRenderer.invoke(IPC.chatHandoffPreview, tabId),
    switchProvider: (tabId: string, opts: SwitchProviderDto) =>
      ipcRenderer.invoke(IPC.chatSwitchProvider, tabId, opts),
    onEvent: (listener) => {
      const handler = (_e: IpcRendererEvent, envelope: ChatEventEnvelope) =>
        listener(envelope);
      ipcRenderer.on(IPC.chatEvent, handler);
      return () => ipcRenderer.removeListener(IPC.chatEvent, handler);
    },
    commands: (tabId: string) => ipcRenderer.invoke(IPC.chatCommands, tabId),
    onCommandsChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, cwd: string) => listener(cwd);
      ipcRenderer.on(IPC.chatCommandsChanged, handler);
      return () => ipcRenderer.removeListener(IPC.chatCommandsChanged, handler);
    },
    search: (query: string) => ipcRenderer.invoke(IPC.chatSearch, query),
    limitRetryNow: (tabId: string) => ipcRenderer.invoke(IPC.chatLimitRetry, tabId),
    limitCancel: (tabId: string) => ipcRenderer.invoke(IPC.chatLimitCancel, tabId),
    queueRemove: (tabId: string, id: string) =>
      ipcRenderer.invoke(IPC.chatQueueRemove, tabId, id),
    queueUpdate: (tabId: string, id: string, text: string) =>
      ipcRenderer.invoke(IPC.chatQueueUpdate, tabId, id, text),
    queueSendNext: (tabId: string) => ipcRenderer.invoke(IPC.chatQueueSendNext, tabId),
    queueSteer: (tabId: string, id: string) => ipcRenderer.invoke(IPC.chatQueueSteer, tabId, id),
    fork: (tabId: string, pointId: string) => ipcRenderer.invoke(IPC.chatFork, tabId, pointId),
    exportMarkdown: (tabId: string) =>
      ipcRenderer.invoke(IPC.chatExport, tabId),
    attachTerminal: (tabId: string) =>
      ipcRenderer.invoke(IPC.chatAttachTerminal, tabId),
    detachTerminal: (tabId: string) =>
      ipcRenderer.invoke(IPC.chatDetachTerminal, tabId),
    onSnapshotChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, snapshot: SessionSnapshotDto) =>
        listener(snapshot);
      ipcRenderer.on(IPC.chatSnapshotChanged, handler);
      return () => ipcRenderer.removeListener(IPC.chatSnapshotChanged, handler);
    },
  },
  lsp: {
    status: () => ipcRenderer.invoke(IPC.lspStatus),
    setPath: (serverId, path) => ipcRenderer.invoke(IPC.lspSetPath, serverId, path),
    start: (cwd, serverId) => ipcRenderer.invoke(IPC.lspStart, cwd, serverId),
    send: (id: string, message: string) => ipcRenderer.send(IPC.lspSend, id, message),
    onMessage: (listener) => {
      const handler = (_e: IpcRendererEvent, id: string, message: string) => listener(id, message);
      ipcRenderer.on(IPC.lspMessage, handler);
      return () => ipcRenderer.removeListener(IPC.lspMessage, handler);
    },
    onExit: (listener) => {
      const handler = (_e: IpcRendererEvent, id: string) => listener(id);
      ipcRenderer.on(IPC.lspExit, handler);
      return () => ipcRenderer.removeListener(IPC.lspExit, handler);
    },
  },
  worktree: {
    create: (workspaceId: string, fromTabId?: string | null) =>
      ipcRenderer.invoke(IPC.wtCreate, workspaceId, fromTabId ?? null),
    status: (tabId: string) => ipcRenderer.invoke(IPC.wtStatus, tabId),
    merge: (tabId: string) => ipcRenderer.invoke(IPC.wtMerge, tabId),
    remove: (tabId: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke(IPC.wtRemove, tabId, opts ?? {}),
    listManaged: () => ipcRenderer.invoke(IPC.wtListManaged),
    removeManaged: (path: string) => ipcRenderer.invoke(IPC.wtRemoveManaged, path),
  },
  snippets: {
    list: () => ipcRenderer.invoke(IPC.snippetsList),
    save: (input) => ipcRenderer.invoke(IPC.snippetsSave, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.snippetsRemove, id),
    onChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, items: SnippetDto[]) => listener(items);
      ipcRenderer.on(IPC.snippetsChanged, handler);
      return () => ipcRenderer.removeListener(IPC.snippetsChanged, handler);
    },
  },
  git: {
    info: (cwd: string) => ipcRenderer.invoke(IPC.gitInfo, cwd),
    changes: (cwd: string) => ipcRenderer.invoke(IPC.gitChanges, cwd),
    commit: (cwd: string, paths: string[], message: string) =>
      ipcRenderer.invoke(IPC.gitCommit, cwd, paths, message),
    draftMessage: (cwd: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.gitDraftMessage, cwd, paths),
    revert: (cwd: string, path: string) =>
      ipcRenderer.invoke(IPC.gitRevert, cwd, path),
  },
  files: {
    read: (cwd: string, path: string) =>
      ipcRenderer.invoke(IPC.fileRead, cwd, path),
    write: (cwd: string, path: string, content: string, opts) =>
      ipcRenderer.invoke(IPC.fileWrite, cwd, path, content, opts),
    create: (cwd: string, path: string, kind: "file" | "dir") =>
      ipcRenderer.invoke(IPC.fileCreate, cwd, path, kind),
    rename: (cwd: string, from: string, to: string) =>
      ipcRenderer.invoke(IPC.fileRename, cwd, from, to),
    remove: (cwd: string, path: string) => ipcRenderer.invoke(IPC.fileDelete, cwd, path),
    list: (dir: string) => ipcRenderer.invoke(IPC.fileList, dir),
    locate: (cwd: string, ref: string) => ipcRenderer.invoke(IPC.fileLocate, cwd, ref),
    // Electron 32 부터 File.path 가 없어졌다. 경로는 preload 의 webUtils 로만 얻는다.
    pathFor: (file: File) => webUtils.getPathForFile(file),
    remoteImage: (url: string) => ipcRenderer.invoke(IPC.fileRemoteImage, url),
  },
  terminal: {
    open: (tabId: string, cwd: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.termOpen, tabId, cwd, cols, rows),
    write: (tabId: string, data: string) =>
      ipcRenderer.send(IPC.termWrite, tabId, data),
    resize: (tabId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.termResize, tabId, cols, rows),
    close: (tabId: string) => ipcRenderer.invoke(IPC.termClose, tabId),
    clear: (tabId: string) => ipcRenderer.send(IPC.termClear, tabId),
    setFocused: (focused: boolean) => ipcRenderer.send(IPC.termFocus, focused),
    onData: (listener) => {
      const handler = (_e: IpcRendererEvent, tabId: string, data: string) =>
        listener(tabId, data);
      ipcRenderer.on(IPC.termData, handler);
      return () => ipcRenderer.removeListener(IPC.termData, handler);
    },
    onExit: (listener) => {
      const handler = (_e: IpcRendererEvent, tabId: string, exitCode: number) =>
        listener(tabId, exitCode);
      ipcRenderer.on(IPC.termExit, handler);
      return () => ipcRenderer.removeListener(IPC.termExit, handler);
    },
    list: (tabId: string) => ipcRenderer.invoke(IPC.termList, tabId),
    onOpened: (listener) => {
      const handler = (_e: IpcRendererEvent, info: TerminalInfoDto) =>
        listener(info);
      ipcRenderer.on(IPC.termOpened, handler);
      return () => ipcRenderer.removeListener(IPC.termOpened, handler);
    },
  },
  mcp: {
    status: (cwd: string) => ipcRenderer.invoke(IPC.mcpStatus, cwd),
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  },
  schedules: {
    list: () => ipcRenderer.invoke(IPC.schedulesList),
    save: (input: unknown) => ipcRenderer.invoke(IPC.schedulesSave, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.schedulesRemove, id),
    runNow: (id: string) => ipcRenderer.invoke(IPC.schedulesRunNow, id),
    onChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, s: ScheduleListDto) => listener(s);
      ipcRenderer.on(IPC.schedulesChanged, handler);
      return () => {
        ipcRenderer.off(IPC.schedulesChanged, handler);
      };
    },
  },
  jobs: {
    list: () => ipcRenderer.invoke(IPC.backgroundJobs),
    onChanged: (listener: (jobs: BackgroundJobDto[]) => void) => {
      const handler = (_e: IpcRendererEvent, jobs: BackgroundJobDto[]) => listener(jobs);
      ipcRenderer.on(IPC.backgroundJobsChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC.backgroundJobsChanged, handler);
      };
    },
  },
  browser: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
    previewUrl: (cwd: string, path: string) => ipcRenderer.invoke(IPC.previewUrl, cwd, path),
    register: (tabId: string, webContentsId: number | null, url: string) =>
      ipcRenderer.send(IPC.browserRegister, tabId, webContentsId, url),
    favicon: (url: string) => ipcRenderer.invoke(IPC.browserFavicon, url),
    netFailures: (webContentsId: number, clear?: boolean) => ipcRenderer.invoke(IPC.browserNetFailures, webContentsId, clear === true),
    onEvent: (cb: (ev: BrowserEventDto) => void) => {
      const handler = (_e: IpcRendererEvent, ev: BrowserEventDto) => cb(ev);
      ipcRenderer.on(IPC.browserEvent, handler);
      return () => ipcRenderer.removeListener(IPC.browserEvent, handler);
    },
    showDownload: (id: string, how: "open" | "reveal") => ipcRenderer.invoke(IPC.browserShowDownload, id, how),
    cancelDownload: (id: string) => ipcRenderer.invoke(IPC.browserCancelDownload, id),
    probe: (url: string) => ipcRenderer.invoke(IPC.browserProbe, url),
  },
};

contextBridge.exposeInMainWorld("sudal", api);
