import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatEvent } from "@shared/chat-events";
import type { ChatEventEnvelope, SessionSnapshotDto } from "@shared/ipc";
import { collapseCompactedHistory, initialHistoryState, mergeHistoryPage, reduceHistoryEvent, type HistoryState, type SessionHistoryPage } from "@shared/session-history";

type Action = { kind: "event"; event: ChatEvent } | { kind: "page"; page: SessionHistoryPage; older: boolean; events: ChatEvent[] } | { kind: "collapse" };

function reducer(state: HistoryState, action: Action): HistoryState {
  if (action.kind === "event") return reduceHistoryEvent(state, action.event);
  if (action.kind === "collapse") return collapseCompactedHistory(state);
  return mergeHistoryPage(state, action.page, action.older, action.events);
}

/** Page history separately from live events; fence buffered pushes at the snapshot sequence. */
export function useSession(tabId: string) {
  const [history, dispatch] = useReducer(reducer, undefined, initialHistoryState);
  const [config, setConfig] = useState<SessionSnapshotDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [compactedExpanded, setCompactedExpanded] = useState(false);
  const hiddenCount = history.compactBoundary?.hiddenCount ?? 0;
  const archiveLoaded = compactedExpanded && history.prefix.length < hiddenCount;
  const hasMore = history.prefix.length > (archiveLoaded ? 0 : hiddenCount);
  const owner = useRef({ generation: 0, lifetime: 0, alive: false, ready: false, before: null as string | null, loading: false, includeCompacted: false, pendingCompact: false, buffered: [] as ChatEventEnvelope[] });

  const read = useCallback(async (older: boolean, openingArchive = false) => {
    const o = owner.current;
    if (!o.alive || o.loading || o.pendingCompact || (older && !o.before)) return;
    const generation = o.generation;
    o.loading = true;
    o.buffered = [];
    if (older) setLoadingOlder(true);
    else { o.ready = false; o.buffered = []; setLoaded(false); }
    setHistoryError(null);
    try {
      const page = await window.sudal.chat.history(tabId, older ? o.before! : undefined, o.includeCompacted);
      if (!o.alive || generation !== o.generation) return;
      const events = o.buffered.filter((envelope) => envelope.sequence === undefined || envelope.sequence > (page.sequence ?? -1)).map((envelope) => envelope.event);
      dispatch({ kind: "page", page, older, events });
      if (events.some(event => event.type === "compacted")) { o.pendingCompact = true; o.includeCompacted = false; setCompactedExpanded(false); }
      o.buffered = [];
      if (!older) {
        o.ready = true;
      }
      o.before = page.before;
    } catch (e) {
      if (o.alive && generation === o.generation) {
        if (openingArchive) { o.includeCompacted = false; setCompactedExpanded(false); }
        setHistoryError(e instanceof Error ? e.message : String(e));
        if (!older) {
          for (const envelope of o.buffered) dispatch({ kind: "event", event: envelope.event });
          o.buffered = [];
          o.ready = true;
        }
      }
    } finally {
      if (o.alive && generation === o.generation) {
        o.loading = false;
        o.buffered = [];
        setLoadingOlder(false);
        setLoaded(true);
      }
    }
  }, [tabId]);

  useEffect(() => {
    const o = owner.current;
    o.alive = true;
    o.lifetime++;
    o.generation++;
    o.loading = false;
    o.ready = false;
    o.before = null;
    o.includeCompacted = false; o.pendingCompact = false; setCompactedExpanded(false);
    const off = window.sudal.chat.onEvent((envelope) => {
      if (envelope.tabId !== tabId) return;
      if (!o.ready || o.loading) o.buffered.push(envelope);
      if (o.ready) {
        if (envelope.event.type === "compacted") {
          o.generation++; o.loading = false; o.buffered = []; o.includeCompacted = false; o.pendingCompact = true;
          setCompactedExpanded(false); setLoadingOlder(false); setHistoryError(null);
        }
        dispatch({ kind: "event", event: envelope.event });
      }
    });
    void read(false);
    let pushed = false;
    const lifetime = o.lifetime;
    void window.sudal.chat.snapshot(tabId).then((s) => o.alive && lifetime === o.lifetime && !pushed && setConfig(s)).catch(console.error);
    const offSnap = window.sudal.chat.onSnapshotChanged((s) => {
      if (s.tabId === tabId) { pushed = true; setConfig(s); }
    });
    return () => { o.alive = false; o.generation++; o.lifetime++; o.buffered = []; off(); offSnap(); };
  }, [tabId, read]);

  useEffect(() => {
    const o = owner.current;
    if (o.ready) {
      o.before = history.state.blocks[0]?.id ?? history.compactBoundary?.before ?? null;
      o.pendingCompact = false;
    }
  }, [history]);

  const reload = useCallback(() => {
    const o = owner.current;
    o.generation++;
    o.loading = false;
    o.includeCompacted = false; o.pendingCompact = false; setCompactedExpanded(false);
    dispatch({ kind: "collapse" });
    void read(false);
  }, [read]);
  const loadOlder = useCallback(() => read(true), [read]);
  const expandCompacted = useCallback(async () => {
    const o = owner.current;
    if (o.loading || o.pendingCompact || !o.ready) return;
    o.includeCompacted = true; setCompactedExpanded(true);
    await read(true, true);
  }, [read]);
  const collapseCompacted = useCallback(() => {
    const o = owner.current;
    o.generation++; o.loading = false; o.includeCompacted = false; o.buffered = []; o.pendingCompact = true;
    setCompactedExpanded(false); setLoadingOlder(false); setHistoryError(null); dispatch({ kind: "collapse" });
  }, []);
  return { state: history.state, config, setConfig, loaded, reload, hasMore, loadingOlder, loadOlder, historyError,
    compactBoundary: history.compactBoundary, compactedExpanded, expandCompacted, collapseCompacted };
}
