// "예약 회차가 끝났나" 를 판정한다. 순수 상태 기계 — 신호를 받아 판정만 내린다.
//
// 이 규칙은 추측이 아니라 실측에서 나왔다(SUDAL_DEBUG_SDK 로 잡은 순서):
//
//   정상(백그라운드 후속 턴 있음) — CLI 2.1.291 까지
//     tasks=1 → result(첫 턴) → tasks=0(sdk) → task_notification → 새 턴 → result → 끝
//   정상(백그라운드 후속 턴 있음) — CLI 2.1.292 부터(끝나는 작업은 알림 뒤에 목록에서 빠진다)
//     tasks=1 → result(첫 턴) → task_notification → 새 턴 → … tasks=0 이 후속 턴 result 보다 늦을 수도 있다
//   그래서 "작업 하나가 끝났다" 는 두 신호(목록에서 빠짐·끝났다는 알림)를 짝지어, 먼저 온 쪽에서만 후속 턴을 기다린다.
//   정상(단순)
//     result → 끝 (프로세스는 살아 있다. 스트림은 안 끝난다)
//   크래시
//     result → 스트림이 예외로 끝남("terminated by signal SIGKILL") → tasks=0(cleanup)
//
// 두 가지를 섞지 않는 것이 핵심이다.
//   1) 빈 작업 목록의 출처. 프로세스가 죽어 우리가 비운 목록(cleanup)은 "일이 끝났다" 가 아니라
//      "더는 모른다" 는 뜻이다. 이걸 근거로 쓰면 크래시가 성공이 된다.
//   2) 첫 result 는 끝이 아니다. 백그라운드가 남아 있으면 CLI 가 스스로 이어서 또 턴을 돈다.
//
// 오르카도 같은 태도다 — 관찰을 잃으면 절대 완료라고 하지 않고 사유를 남긴다.

import type { Msg } from "./i18n/msg";

/** 판정에 쓰는 신호. 어댑터가 보는 것을 그대로 옮긴 것만 둔다. */
export type RunSignal =
  /** 턴 하나가 끝났다(SDK result). 회차의 끝이라는 뜻은 아니다. */
  | { kind: "result"; isError: boolean }
  /** 살아 있는 백그라운드 작업 전체 집합이 바뀌었다. source 가 판정을 가른다. */
  | { kind: "tasks"; count: number; source: "sdk" | "cleanup"; /** 목록의 작업 id. 있으면 끝났다는 알림과 id 로 짝짓는다. */ ids?: string[] }
  /** 백그라운드 작업 하나가 끝났다는 알림(task_notification). 목록에서 빠지는 것과 순서가 CLI 판마다 다르다. */
  | { kind: "task_finished"; id?: string }
  /** 새 턴이 시작됐다(우리가 보낸 것이든, CLI 가 스스로 이어간 것이든). */
  | { kind: "turn_started" }
  /** 사용자 응답을 기다리는 요청 수(권한·질문). */
  | { kind: "awaiting"; count: number }
  /** 스트림이 끝났다. expected = 우리가 의도적으로 닫았다(탭 닫기·유휴 종료 등). */
  | { kind: "stream_ended"; reason: string; expected: boolean; /** reason 이 앱이 만든 문구면 그 키(그릴 때 번역한다). */ reasonMsg?: Msg };

export interface RunState {
  sawResult: boolean;
  /**
   * 백그라운드 작업이 방금 끝났다 = 곧 그 결과를 처리하는 후속 턴이 온다.
   * 이게 없으면 tasks=0 이 도착한 순간(후속 턴 전에) 회차를 완료로 확정해 버린다 —
   * 실측 순서가 tasks=0 → task_notification → 새 턴 이라서 그 틈이 실재한다.
   */
  followUpExpected: boolean;
  resultIsError: boolean;
  /**
   * SDK 가 알려 준 살아 있는 작업 수. null = 한 번도 안 왔다 = 작업이 없다.
   * SDK 는 집합이 바뀔 때만 보내므로 "온 적 없음" 은 "없음" 이다(실측: 단순 턴에는 아예 안 온다).
   * cleanup 출처는 이 값을 건드리지 않는다.
   */
  liveTasks: number | null;
  awaiting: number;
  ended: { reason: string; expected: boolean; reasonMsg?: Msg } | null;
  /** 끝났다는 알림은 왔는데 목록에서 아직 안 빠진 작업 수(새 순서). 나중에 빠질 때 후속 턴을 다시 기다리지 않는다. */
  finishedUnlisted: number;
  /** 목록에서는 빠졌는데 끝났다는 알림이 아직 안 온 작업 수(예전 순서). 알림이 와도 후속 턴을 두 번 세지 않는다. */
  unlistedUnfinished: number;
  /**
   * id 를 알 때는 개수 대신 id 로 짝짓는다. 개수로만 맞추면 포그라운드로 옮겨 가 알림 없이 빠진 작업의 몫을
   * 다른 작업의 알림이 가져가, 회차가 끝나지 않고 남는다.
   */
  liveIds: string[] | null;
  finishedIds: string[];
  unlistedIds: string[];
}

/** 목록에서 빠졌는데 알림이 끝내 오지 않는 id(포그라운드로 옮겨 간 작업 등)는 이만큼만 둔다. */
const PAIR_MAX = 50;

export type RunVerdict =
  | { state: "running" }
  /** 사람이 답해야 진행된다. 무인 실행에서는 그대로 두면 영영 멈춘다. */
  | { state: "needs_action" }
  | { state: "completed"; isError: boolean }
  /** 끝났는지 알 수 없게 됐다. 성공으로 바꾸지 않는다. */
  | { state: "interrupted"; reason: string; reasonMsg?: Msg };

export function newRunState(): RunState {
  return {
    sawResult: false,
    followUpExpected: false,
    resultIsError: false,
    liveTasks: null,
    awaiting: 0,
    ended: null,
    finishedUnlisted: 0,
    unlistedUnfinished: 0,
    liveIds: null,
    finishedIds: [],
    unlistedIds: [],
  };
}

export function applyRunSignal(s: RunState, sig: RunSignal): RunState {
  switch (sig.kind) {
    case "result":
      // 후속 턴의 result 가 왔다 = 기다리던 그 턴이 끝났다.
      return { ...s, sawResult: true, resultIsError: sig.isError, followUpExpected: false };
    case "tasks": {
      // cleanup 이 만든 목록은 판정 근거가 아니다 — 프로세스가 죽었다는 뜻일 뿐이다.
      if (sig.source === "cleanup") return s;
      if (sig.ids) {
        // 빠진 작업마다: 알림이 먼저 왔던 것이면(새 순서) 짝만 맞추고, 아니면(예전 순서) 이제부터 후속 턴을 기다린다
        const now = new Set(sig.ids);
        const before = new Set(s.liveIds ?? []);
        let followUpExpected = s.followUpExpected;
        const finishedIds = [...s.finishedIds];
        // 목록에 다시 들어온 작업(포그라운드였다가 다시 백그라운드로)은 앞서 빠질 때 남긴 기록을 버린다 — 그 기록이 이번 알림과 짝지어지면 안 된다
        let unlistedIds = s.unlistedIds.filter((id) => !(now.has(id) && !before.has(id)));
        for (const id of before) {
          if (now.has(id)) continue;
          const k = finishedIds.indexOf(id);
          if (k >= 0) finishedIds.splice(k, 1);
          else {
            unlistedIds = [...unlistedIds, id];
            followUpExpected = true;
          }
        }
        // 알림이 먼저 온 기록은 목록에 있는 작업 것만 남는다(목록 크기만큼만 쌓인다) — 개수로 자르지 않는다
        return {
          ...s,
          liveTasks: sig.count,
          liveIds: sig.ids,
          followUpExpected,
          finishedIds: finishedIds.filter((id) => now.has(id)),
          unlistedIds: unlistedIds.slice(-PAIR_MAX),
        };
      }
      const had = s.liveTasks ?? 0;
      // 작업이 줄었다 = 끝난 작업이 있다 = 그 결과를 처리하는 턴이 뒤따른다.
      // 단, 끝났다는 알림이 먼저 와서 이미 기다리고 있던 작업이면(새 순서) 다시 기다리지 않는다 — 후속 턴이 이미 끝났을 수 있다.
      let gone = Math.max(0, had - sig.count);
      const matched = Math.min(gone, s.finishedUnlisted);
      gone -= matched;
      return {
        ...s,
        liveTasks: sig.count,
        followUpExpected: s.followUpExpected || gone > 0,
        finishedUnlisted: s.finishedUnlisted - matched,
        unlistedUnfinished: s.unlistedUnfinished + gone,
      };
    }
    case "task_finished":
      if (sig.id !== undefined) {
        // 목록에서 먼저 빠진 그 작업이면(예전 순서) 짝만 맞춘다. 아니면 이제부터 후속 턴을 기다리고, 목록에 있는 작업이면 빠질 때를 위해 기억한다.
        const k = s.unlistedIds.indexOf(sig.id);
        if (k >= 0) return { ...s, unlistedIds: s.unlistedIds.filter((_, i) => i !== k) };
        const listed = (s.liveIds ?? []).includes(sig.id);
        return { ...s, followUpExpected: true, finishedIds: listed && !s.finishedIds.includes(sig.id) ? [...s.finishedIds, sig.id] : s.finishedIds };
      }
      // 목록에서 먼저 빠져 이미 기다리는 중이면(예전 순서) 짝만 맞춘다. 아니면 이제부터 후속 턴을 기다린다.
      if (s.unlistedUnfinished > 0) return { ...s, unlistedUnfinished: s.unlistedUnfinished - 1 };
      return { ...s, followUpExpected: true, finishedUnlisted: s.finishedUnlisted + 1 };
    case "turn_started":
      // 후속 턴이 시작됐다. 앞 턴의 result 는 더 이상 "끝" 의 후보가 아니다.
      return { ...s, sawResult: false, resultIsError: false };
    case "awaiting":
      return { ...s, awaiting: Math.max(0, sig.count) };
    case "stream_ended":
      return { ...s, ended: { reason: sig.reason, expected: sig.expected, ...(sig.reasonMsg ? { reasonMsg: sig.reasonMsg } : {}) } };
  }
}

/** 끝났다고 말할 수 있는 조건. 하나라도 어긋나면 아직이다. */
function finished(s: RunState): boolean {
  return s.sawResult && !s.followUpExpected && (s.liveTasks ?? 0) === 0 && s.awaiting === 0;
}

export function runVerdict(s: RunState): RunVerdict {
  // 스트림이 끝났으면 기본은 "모른다" 다. 끝까지 간 것이 확인될 때만 완료로 본다 —
  // 후속 턴을 기다리던 중에 죽은 것을 성공으로 만들면 안 된다.
  if (s.ended) return finished(s) ? { state: "completed", isError: s.resultIsError } : { state: "interrupted", reason: s.ended.reason, ...(s.ended.reasonMsg ? { reasonMsg: s.ended.reasonMsg } : {}) };
  if (s.awaiting > 0) return { state: "needs_action" };
  return finished(s) ? { state: "completed", isError: s.resultIsError } : { state: "running" };
}

/** 신호를 순서대로 먹여 판정한다(시험·재생용). */
export function judgeRun(signals: RunSignal[]): RunVerdict {
  return runVerdict(signals.reduce(applyRunSignal, newRunState()));
}
