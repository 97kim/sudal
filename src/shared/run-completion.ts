// "예약 회차가 끝났나" 를 판정한다. 순수 상태 기계 — 신호를 받아 판정만 내린다.
//
// 이 규칙은 추측이 아니라 실측에서 나왔다(WORKBENCH_DEBUG_SDK 로 잡은 순서):
//
//   정상(백그라운드 후속 턴 있음)
//     tasks=1 → result(첫 턴) → tasks=0(sdk) → task_notification → 새 턴 → result → 끝
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
  | { kind: "tasks"; count: number; source: "sdk" | "cleanup" }
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
}

export type RunVerdict =
  | { state: "running" }
  /** 사람이 답해야 진행된다. 무인 실행에서는 그대로 두면 영영 멈춘다. */
  | { state: "needs_action" }
  | { state: "completed"; isError: boolean }
  /** 끝났는지 알 수 없게 됐다. 성공으로 바꾸지 않는다. */
  | { state: "interrupted"; reason: string; reasonMsg?: Msg };

export function newRunState(): RunState {
  return { sawResult: false, followUpExpected: false, resultIsError: false, liveTasks: null, awaiting: 0, ended: null };
}

export function applyRunSignal(s: RunState, sig: RunSignal): RunState {
  switch (sig.kind) {
    case "result":
      // 후속 턴의 result 가 왔다 = 기다리던 그 턴이 끝났다.
      return { ...s, sawResult: true, resultIsError: sig.isError, followUpExpected: false };
    case "tasks": {
      // cleanup 이 만든 목록은 판정 근거가 아니다 — 프로세스가 죽었다는 뜻일 뿐이다.
      if (sig.source === "cleanup") return s;
      const had = s.liveTasks ?? 0;
      // 작업이 줄었다 = 끝난 작업이 있다 = 그 결과를 처리하는 턴이 뒤따른다.
      const followUpExpected = s.followUpExpected || sig.count < had;
      return { ...s, liveTasks: sig.count, followUpExpected };
    }
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
