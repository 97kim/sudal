import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatEvent } from "@shared/chat-events";
import type { ChatEventEnvelope, SessionSnapshotDto } from "@shared/ipc";
import { initialHistoryState, mergeHistoryPage, reduceHistoryEvent, type HistoryState, type SessionHistoryPage } from "@shared/session-history";

type Action = { kind: "event"; event: ChatEvent } | { kind: "page"; page: SessionHistoryPage; older: boolean; events: ChatEvent[] };

function reducer(state: HistoryState, action: Action): HistoryState {
  if (action.kind === "event") return reduceHistoryEvent(state, action.event);
  return mergeHistoryPage(state, action.page, action.older, action.events);
}

/** Page history separately from live events; fence buffered pushes at the snapshot sequence. */
export function useSession(tabId: string) {
  const [history, dispatch] = useReducer(reducer, undefined, initialHistoryState);
  const [config, setConfig] = useState<SessionSnapshotDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const owner = useRef({ generation: 0, alive: false, ready: false, before: null as string | null, loading: false, buffered: [] as ChatEventEnvelope[] });

  const read = useCallback(async (older: boolean) => {
    const o = owner.current;
    if (!o.alive || o.loading || (older && !o.before)) return;
    const generation = o.generation;
    o.loading = true;
    o.buffered = [];
    if (older) setLoadingOlder(true);
    else { o.ready = false; o.buffered = []; setLoaded(false); }
    setHistoryError(null);
    try {
      const page = await window.sudal.chat.history(tabId, older ? o.before! : undefined);
      if (!o.alive || generation !== o.generation) return;
      const events = o.buffered.filter((envelope) => envelope.sequence === undefined || envelope.sequence > (page.sequence ?? -1)).map((envelope) => envelope.event);
      dispatch({ kind: "page", page, older, events });
      o.buffered = [];
      if (!older) {
        o.ready = true;
      }
      o.before = page.before;
      setHasMore(page.hasMore);
    } catch (e) {
      if (o.alive && generation === o.generation) {
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
    o.generation++;
    o.loading = false;
    o.ready = false;
    o.before = null;
    const off = window.sudal.chat.onEvent((envelope) => {
      if (envelope.tabId !== tabId) return;
      if (!o.ready || o.loading) o.buffered.push(envelope);
      if (o.ready) dispatch({ kind: "event", event: envelope.event });
    });
    void read(false);
    let pushed = false;
    const generation = o.generation;
    void window.sudal.chat.snapshot(tabId).then((s) => o.alive && generation === o.generation && !pushed && setConfig(s)).catch(console.error);
    const offSnap = window.sudal.chat.onSnapshotChanged((s) => {
      if (s.tabId === tabId) { pushed = true; setConfig(s); }
    });
    return () => { o.alive = false; o.generation++; o.buffered = []; off(); offSnap(); };
  }, [tabId, read]);

  const reload = useCallback(() => {
    const o = owner.current;
    o.generation++;
    o.loading = false;
    void read(false);
  }, [read]);
  const loadOlder = useCallback(() => read(true), [read]);
  return { state: history.state, config, setConfig, loaded, reload, hasMore, loadingOlder, loadOlder, historyError };
}
