import { useCallback, useEffect, useReducer, useState } from "react";
import type { ChatEvent } from "@shared/chat-events";
import type { SessionSnapshotDto } from "@shared/ipc";
import {
  initialSessionState,
  reduceSession,
  replaySession,
  type SessionState,
} from "@shared/session-state";

type Action =
  | { kind: "event"; event: ChatEvent }
  | { kind: "replay"; events: ChatEvent[] };

function reducer(state: SessionState, action: Action): SessionState {
  if (action.kind === "replay") return replaySession(action.events);
  return reduceSession(state, action.event);
}

/**
 * 탭 하나의 이벤트 스트림을 구독해 순수 리듀서로 상태를 만든다.
 * 마운트 시 main 의 이벤트 로그를 재생해 (핫 리로드·대화 비우기 후에도) 화면과 main 을 맞춘다.
 */
export function useSession(tabId: string) {
  const [state, dispatch] = useReducer(reducer, undefined, initialSessionState);
  const [config, setConfig] = useState<SessionSnapshotDto | null>(null);
  // 첫 재생 전까지는 빈 상태와 "아직 모른다" 를 구분할 수 없다 — 화면이 "대화가 없다" 고
  // 단정했다가 번복하지 않도록 이 값으로 가른다.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    const off = window.workbench.chat.onEvent(({ tabId: id, event }) => {
      if (id === tabId) dispatch({ kind: "event", event });
    });
    window.workbench.chat
      .events(tabId)
      .then((events) => {
        if (alive) dispatch({ kind: "replay", events });
      })
      .catch(console.error)
      // 조회가 실패해도 계속 불러오는 중으로 두지 않는다 — 영영 도는 표시가 남는다.
      .finally(() => {
        if (alive) setLoaded(true);
      });
    // 마운트 직후의 조회가 푸시보다 늦게 도착하면 더 새 값을 옛 값으로 덮게 된다 — 푸시가 먼저 왔으면 조회 결과는 버린다.
    let pushed = false;
    window.workbench.chat
      .snapshot(tabId)
      .then((s) => alive && !pushed && setConfig(s))
      .catch(console.error);
    // 컨트롤러 전환(터미널 ↔ 앱)·설정 변경처럼 main 이 먼저 바꾼 스냅샷을 받는다.
    const offSnap = window.workbench.chat.onSnapshotChanged((s) => {
      if (s.tabId === tabId) {
        pushed = true;
        setConfig(s);
      }
    });
    return () => {
      alive = false;
      off();
      offSnap();
    };
  }, [tabId]);

  // 대화 비우기처럼 main 쪽 로그가 통째로 바뀌었을 때 다시 재생한다.
  const reload = useCallback(() => {
    void window.workbench.chat
      .events(tabId)
      .then((events) => dispatch({ kind: "replay", events }))
      .catch(console.error);
  }, [tabId]);

  return { state, config, setConfig, loaded, reload };
}
