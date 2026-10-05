// 예약(Schedule)과 그 실행 회차(Run)의 자료 모델. 순수 — 저장·타이머는 main 이 맡는다.
//
// 상태를 성공/실패 둘로 두지 않는다. "안 돌았다" 의 이유가 서로 다르고, 그 이유가 곧 사용자가
// 알아야 할 정보다(오르카도 건너뜀을 이유별로 넷으로 나눈다).
//
// 회차는 보내기 "전에" 기록한다. 보낸 뒤에 기록하면 그 사이에 앱이 죽었을 때
// 보냈는지 안 보냈는지 알 길이 없다.

import type { TFunction } from "i18next";
import type { PermissionPolicy } from "./chat-events";
import type { Msg, MsgKey } from "./i18n/msg";
import type { ProviderId, WorktreeMeta } from "./workspace-model";

/**
 * 실행 대상.
 *
 * 예전에는 회차마다 새 탭을 만들었다. 매일 도는 예약이면 그 워크스페이스에 하루 한 개씩 탭이 쌓이고,
 * 그 탭이 예약 출신인지도 알 수 없었다. 지금은 예약마다 제 탭 하나를 잡아 두고 거기에 회차를 쌓는다.
 *
 * "정해 둔 탭에 보내기" 를 한 번 뺐던 이유가 있었다 — 그 탭이 바쁘면 프롬프트가 대기열에 들어가고,
 * 그러면 사용자 턴의 result 로 회차가 완료 처리되고, 예약의 권한이 진행 중인 사용자 작업에 적용되고,
 * 재시작 뒤 대기열에 남은 예약이 혼자 되살아난다. 그때 상정한 것은 "사용자가 쓰는 탭" 이었다.
 * 예약이 제 탭을 소유하면 그 탭에 사용자 턴이 없어 셋 다 성립하지 않는다. 대기열에 들어갈 일도 없다 —
 * 앞 회차가 살아 있으면 엔진이 skipped_overlap 으로 먼저 끊는다.
 *
 * 격리 회차(worktree)는 계속 새 탭이다. 회차마다 worktree가 다른데 탭의 경로는 하나뿐이다.
 */
/**
 * 예약 결과가 모이는 워크스페이스인가. 예약 결과는 언제나 여기로 모인다 — 어디에 둘지 묻지 않는다.
 * main 이 시작할 때 만들어 두고 사이드바가 맨 위로 올린다. 양쪽이 같은 기준을 봐야 해서 여기 둔다.
 * 이름은 만든 때의 언어로 저장되므로 builtin 으로 찾는다. 표식이 생기기 전에 만든 것은 이름이 "예약" 이다.
 */
export function isScheduleWorkspace(w: { name: string; builtin?: string }): boolean {
  // i18n-ignore: 예전 버전이 만든 워크스페이스의 이름(식별용)
  return w.builtin === "schedules" || (w.builtin === undefined && w.name === "예약");
}

export type ScheduleTarget = {
  kind: "fresh";
  /**
   * 실행할 폴더. 예전에는 워크스페이스 기본 경로를 썼는데, 이름만으로 만든 워크스페이스에는
   * 그 값이 없고 화면에서 채울 방법도 없어서 예약을 아예 만들 수 없었다. 예약이 제 경로를 갖는다.
   * 없으면(옛 예약) 워크스페이스 기본 경로로 읽는다.
   */
  cwd?: string;
  worktree: boolean;
};

export interface SchedulePrecheck {
  /** 셸 명령 하나. 종료코드 0 이면 실행하고, 0 이 아니면 그 회차를 건너뛴다. */
  command: string;
  /** 이 시간을 넘기면 죽이고 실패로 본다(조건 불충족과 구분한다). */
  timeoutMs: number;
}

export interface Schedule {
  id: string;
  name: string;
  /** 5칸 cron. 프리셋은 이 문자열을 되읽어 붙이는 이름일 뿐이다. */
  cron: string;
  /** IANA 이름. 맥의 시간대가 바뀌어도 예약은 안 움직인다. */
  timezone: string;
  prompt: string;
  provider: ProviderId;
  model?: string;
  /**
   * 이 예약이 쓸 권한. 탭 설정을 따라가지 않는다 — 낮에 탭을 "전부 자동" 으로 바꿨다고
   * 새벽 예약의 권한까지 올라가면 안 된다. 만들 때 탭 값을 복사해 올 뿐이다.
   */
  policy: PermissionPolicy;
  target: ScheduleTarget;
  precheck?: SchedulePrecheck;
  enabled: boolean;
  /** 예정 시각을 이만큼 넘겨 깨어났으면 그 회차는 건너뛴다. */
  missedRunGraceMinutes: number;
  createdAt: number;
  /** 이 시각 이후의 회차만 센다. 새로 만들거나 다시 켠 시점 — 과거를 만회하지 않는다. */
  activeSince: number;
  /**
   * 이 예약이 쓰는 탭. 첫 회차에 만들어 잡아 두고 다음부터 거기에 쌓는다. 사용자가 닫았으면 다시 만든다.
   * 격리 회차는 쓰지 않는다(회차마다 worktree가 다르다).
   */
  pinnedTabId?: string | null;
}

export type RunStatus =
  /** 실행하기로 정하고 기록만 해 둔 상태(보내기 직전). */
  | "pending"
  /** 세션에 보냈다. 아직 끝나지 않았다. */
  | "running"
  /** 사람의 승인·답을 기다린다. 무인 실행에서는 여기서 멈춘다. */
  | "needs_action"
  | "completed"
  /** 모델이 오류로 끝냈다(턴은 끝났다). */
  | "failed"
  /** precheck 가 "지금은 할 일 없음" 이라고 했다. */
  | "skipped_precheck"
  /** 유예를 넘겨 깨어났다. */
  | "skipped_missed"
  /** 대상이 사라졌거나 지금 실행할 수 없다(탭 없음·경로 없음·예산 초과). */
  | "skipped_unavailable"
  /** 겹친다 — 앞 회차가 아직 안 끝났다. */
  | "skipped_overlap"
  /** 보냈지만 끝을 확인하지 못했다(앱 종료·크래시). 성공으로 바꾸지 않는다. */
  | "interrupted";

/** 더는 변하지 않는 상태. 이력에서 지워도 되는 것은 이것뿐이다. */
export function isFinalRunStatus(s: RunStatus): boolean {
  return (
    s === "completed" ||
    s === "failed" ||
    s === "interrupted" ||
    s === "skipped_precheck" ||
    s === "skipped_missed" ||
    s === "skipped_unavailable" ||
    s === "skipped_overlap"
  );
}

export interface PrecheckResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** 꼬리만. 통째로 두면 이력 파일이 커진다. */
  stdout: string;
  stderr: string;
  /** 명령 자체를 못 돌렸다(없는 명령 등). 조건 불충족과 다르다. */
  error: string | null;
}

export interface Run {
  id: string;
  scheduleId: string;
  /** 예정 시각. 같은 예약의 같은 회차를 두 번 만들지 않는 열쇠다. */
  scheduledFor: number;
  trigger: "scheduled" | "manual";
  status: RunStatus;
  /** 그때의 설정 스냅샷. 예약을 나중에 고쳐도 지난 회차의 기록은 그대로여야 한다. */
  snapshot: { prompt: string; cron: string; timezone: string; policy: PermissionPolicy; provider: ProviderId; target: ScheduleTarget };
  startedAt: number | null;
  endedAt: number | null;
  /** 실제로 돌아간 탭. 이력에서 그 대화를 열 수 있게. */
  tabId: string | null;
  /**
   * 격리 회차가 만든 worktree. 치울 때 어디를 치울지 알아야 해서 회차에 적어 둔다 —
   * 탭에만 두면 사용자가 탭을 닫는 순간 경로를 잃고 폴더만 남는다. 치운 뒤에는 지운다.
   */
  worktree?: WorktreeMeta;
  precheck?: PrecheckResult;
  /** 사람이 읽을 사유. 건너뜀·중단이면 반드시 채운다. 만든 때의 언어로 저장한다. */
  reason: string | null;
  /** reason 의 사전 키와 값. 화면이 지금 언어로 다시 그린다. 예전 기록에는 없다. */
  reasonMsg?: Msg;
}

/** 사유 문장과 그 Msg. 만드는 쪽이 둘을 함께 들고 다닌다. */
export interface RunReason {
  reason: string;
  reasonMsg: Msg;
}

/** 사유를 만든다. t 는 main 이면 `mt`, 테스트면 `createI18n("ko").t`. */
export function runReason(t: TFunction, key: MsgKey, params?: Msg["params"]): RunReason {
  const reason = (t as unknown as (k: string, p?: object) => string)(key, params);
  return { reason, reasonMsg: params ? { key, params } : { key } };
}

/** 아직 끝나지 않은 회차. 하나라도 있으면 다음 회차는 겹침으로 건너뛴다. */
export function isLiveRun(r: Run): boolean {
  return !isFinalRunStatus(r.status);
}

/**
 * 예정 시각을 얼마나 넘겼으면 포기하나. 유예에 "틱 두 개" 를 더한다 —
 * 스케줄러가 조금 늦은 것과 앱이 꺼져 있던 것은 다른 일이다(오르카도 같은 보정을 한다).
 */
export function missedBeyondGrace(input: { schedule: Schedule; scheduledFor: number; now: number; tickMs: number }): boolean {
  const graceMs = Math.max(0, input.schedule.missedRunGraceMinutes) * 60_000;
  return input.now - input.scheduledFor > graceMs + input.tickMs * 2;
}

/**
 * 같은 사유의 건너뜀이 연달아 쌓이는 것을 막는다. 5분마다 도는 예약이 대상을 잃으면
 * 하루 288개의 똑같은 행이 쌓여 진짜 이력을 밀어낸다 — 마지막 회차가 같은 사유면 갱신만 한다.
 */
export function shouldCoalesceSkip(last: Run | null, status: RunStatus, reason: string | null, reasonMsg?: Msg): boolean {
  if (!last) return false;
  if (last.status !== status || !status.startsWith("skipped_")) return false;
  // 언어가 바뀌면 같은 사유도 문장이 달라진다 — 양쪽에 Msg 가 있으면 키와 값으로, 예전 기록이면 문장으로 비교한다.
  if (last.reasonMsg && reasonMsg) {
    return last.reasonMsg.key === reasonMsg.key && JSON.stringify(last.reasonMsg.params ?? {}) === JSON.stringify(reasonMsg.params ?? {});
  }
  return last.reason === reason;
}
