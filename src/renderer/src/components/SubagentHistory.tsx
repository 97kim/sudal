import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceStateDto } from '@shared/ipc';
import type { ChatEvent } from '@shared/chat-events';
import { tabCwd, type TabMeta } from '@shared/workspace-model';
import type { SubagentTabRef } from '@shared/subagent-tabs';
import type { SubagentHistoryCursor, SubagentHistoryPage } from '@shared/subagent-history';
import { replaySession } from '@shared/session-state';
import { userErrorMessage } from '@shared/error-message';
import { MessageList } from './MessageList';
import { TabBar } from './TabBar';
import { ProviderLogo } from './ProviderLogo';
import { Icon } from './Icon';
import { LocateFileContext, OpenFileContext, type LocateFile, type OpenFile } from './FileViewer';
import { openEditorFile } from '../editor-tabs';

export function SubagentHistory({ tab, reference, source, ws, showTabStrip, onActivateTab, onCloseTab, onNewTab, onParent, onSplitParent, onUnsplit }: {
  tab: TabMeta; reference: SubagentTabRef; source: WorkspaceStateDto; ws: WorkspaceStateDto; showTabStrip: boolean;
  onActivateTab: (id: string) => void; onCloseTab: (id: string) => void; onNewTab: () => void;
  onParent: (id: string) => void; onSplitParent: (id: string) => void; onUnsplit?: () => void;
}) {
  const { t } = useTranslation();
  const { parentTabId, agentId } = reference;
  const agent = source.agents?.[parentTabId]?.find(row => row.id === agentId);
  const parent = source.model.tabs.find(tab => tab.id === parentTabId);
  const cwd = parent ? tabCwd(source.model, parent) : null;
  const openFile = useCallback<OpenFile>((path, at) => { openEditorFile(parentTabId, path, at); onParent(parentTabId); }, [parentTabId,onParent]);
  const locateFile = useMemo<LocateFile>(() => ({cwd,locate:ref=>cwd ? window.sudal.files.locate(cwd,ref) : Promise.resolve([])}),[cwd]);
  const [page, setPage] = useState<SubagentHistoryPage | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const owner = useRef({epoch:0,busy:false,hasHistory:false,cursor:undefined as SubagentHistoryCursor | undefined});
  const translate = useRef(t); translate.current = t;
  const load = useCallback(async (before?: number, background = false): Promise<boolean> => {
    const o = owner.current;
    if (o.busy) return false;
    const epoch = o.epoch; o.busy = true;
    const reportError = (message: string | null) => before === undefined ? setError(message) : setOlderError(message);
    if (!background) setBusy(true);
    if (before !== undefined) setLoadingOlder(true);
    try {
      const next = await window.sudal.chat.subagentHistory(parentTabId, agentId, before, before === undefined ? o.cursor : undefined);
      if (epoch !== o.epoch) return false;
      if (next.unavailable) {
        if (o.hasHistory) reportError(translate.current('nav.subagentHistory.unavailable'));
        else setPage(next);
        return false;
      }
      reportError(null); o.hasHistory = true;
      if (before === undefined) o.cursor = next.cursor;
      setPage(old => {
        if (before !== undefined) return {...next,cursor:old?.cursor,limited:next.limited || !!old?.limited};
        if (!next.append || !old || old.unavailable) return next;
        return next.limited && !old.limited ? {...old,limited:true} : old;
      });
      setEvents(old => before !== undefined ? [...next.events,...old] : next.append ? next.events.length ? [...old,...next.events] : old : next.events);
      return !!next.hasNewer;
    } catch (error) { if (epoch === o.epoch) reportError(userErrorMessage(error)); return false; }
    finally { if (epoch === o.epoch) { o.busy = false; if (!background) setBusy(false); setLoadingOlder(false); } }
  }, [parentTabId, agentId]);
  const available = !!agent;
  useEffect(() => {
    const o = owner.current; o.epoch++; o.busy = false; o.cursor = undefined; o.hasHistory = false;
    if (available) void load();
    return () => { o.epoch++; o.busy = false; };
  }, [load, available]);
  const terminal = agent?.status === 'done' || agent?.status === 'failed';
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finishAfter = Date.now() + 5000;
    const poll = async () => {
      if (cancelled) return;
      if (document.hidden) { timer = setTimeout(poll,1000); return; }
      const backlog = await load(undefined,true);
      if (!cancelled && (!terminal || Date.now()<finishAfter || backlog)) timer = setTimeout(poll,backlog ? 50 : 1000);
    };
    timer = setTimeout(poll,750);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [available,terminal,load]);
  const blocks = useMemo(() => replaySession(events).blocks, [events]);
  return <section className="@container/subagent flex min-h-0 min-w-0 flex-1 flex-col bg-bg" data-subagent-history data-subagent-view-tab={tab.id}>
    <header className="drag flex min-w-0 items-center gap-2 border-b border-line px-3 py-3 mac:pt-10">
      <ProviderLogo provider={tab.provider} size={24}/>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{tab.title}</h2><p className="mt-0.5 hidden min-w-0 items-center gap-1 text-xs text-muted @min-[300px]/subagent:flex"><Icon name="lock" size={10}/><span className="truncate">{t('nav.subagentHistory.readOnly')}</span>{!terminal && <span className="ml-1 shrink-0 text-accent" data-subagent-live>{t('nav.subagentHistory.live')}</span>}</p></div>
      <button type="button" onClick={() => onParent(parentTabId)} aria-label={t('nav.subagentHistory.parent')} title={t('nav.subagentHistory.parent')} className="no-drag flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-fg" data-subagent-parent><Icon name="chevronLeft" size={12}/><span className="hidden @min-[360px]/subagent:inline">{t('nav.subagentHistory.parent')}</span></button>
      <button type="button" disabled={!source.model.openTabIds.includes(parentTabId)} onClick={() => onSplitParent(parentTabId)} title={t('nav.subagentHistory.compare')} aria-label={t('nav.subagentHistory.compare')} className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40" data-subagent-compare><Icon name="splitRow" size={15}/></button>
      {onUnsplit && <button type="button" onClick={onUnsplit} aria-label={t('chat.header.unsplit')} title={t('chat.header.unsplit')} className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"><Icon name="minimize" size={15}/></button>}
      <button type="button" disabled={busy || !agent} onClick={() => void load()} title={t('nav.subagentHistory.refresh')} aria-label={t('nav.subagentHistory.refresh')} className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"><Icon name="refresh" size={15}/></button>
    </header>
    {showTabStrip && <TabBar ws={ws} onActivate={onActivateTab} onClose={onCloseTab} onNew={onNewTab}/>}
    {page?.limited && <p className="border-b border-line px-5 py-2 text-xs text-muted">{t('nav.subagentHistory.limited')}</p>}
    {error && <div role="alert" className="flex items-center gap-3 px-5 py-3 text-sm text-err"><span className="min-w-0 flex-1">{error}</span><button type="button" disabled={busy} onClick={() => void load()} className="shrink-0 underline">{t('nav.subagentHistory.retry')}</button></div>}
    {!agent || page?.unavailable ? <p className="p-6 text-sm text-muted">{t('nav.subagentHistory.unavailable')}</p> : <div className="min-h-0 flex-1">
      <OpenFileContext.Provider value={openFile}><LocateFileContext.Provider value={locateFile}>
        <MessageList tabId={tab.id} provider={agent.provider} blocks={blocks} status="idle" readOnly loading={busy && !page} hasMore={page?.before != null} loadingOlder={loadingOlder} historyError={olderError} onReload={() => void load(page?.before ?? undefined)} onLoadOlder={async () => { if (!busy && page?.before != null) await load(page.before); }}/>
      </LocateFileContext.Provider></OpenFileContext.Provider>
    </div>}
  </section>;
}
