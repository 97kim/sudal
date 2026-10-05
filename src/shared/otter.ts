// 화면에 떠 있는 수달이 지금 무엇을 보여 줄지. 앱이 이미 아는 상태(탭 상태·응답 필요 표시·한도 대기)만으로 정한다.
import type { SessionStatus } from "./chat-events";
import type { SessionAttention } from "./ipc";

/**
 * 수달 창(otter.html) ↔ main 채널. IPC 가 아니라 여기 두는 까닭: 두 preload 가 같은 모듈을 실행 코드로 가져오면
 * 번들러가 공통 조각(chunks/*.cjs)으로 뽑는데, 샌드박스 preload 는 그 파일을 require 하지 못해 메인 창이 깨진다.
 * 메인 창 preload 는 이 파일을 타입으로만 본다.
 */
export const OTTER_IPC = {
  state: "otter:state",
  ready: "otter:ready",
  interactive: "otter:interactive",
  click: "otter:click",
  drag: "otter:drag",
  dragEnd: "otter:drag-end",
  menu: "otter:menu",
} as const;

export type OtterMood = "idle" | "working" | "waiting" | "done" | "error" | "limit";

/**
 * 수달이 "끝났어요" 를 보여 주는 시간. 그 뒤에는 수달에서만 내린다 — 사이드바 점·Dock 배지의 안 본 표시는 그대로다.
 * 계속 두면 끝난 탭 하나가 다른 탭이 일하는 모습을 가린다.
 */
export const OTTER_DONE_MS = 10 * 60_000;

export interface OtterTab {
  id: string;
  title: string;
  status: SessionStatus;
  attention?: SessionAttention;
  /** 끝남(안 본 응답)이 생긴 시각(ms). 모르면(앱을 다시 켜서 되살아난 것) 이미 지난 것으로 본다. */
  doneAt?: number;
  /** 한도에 걸려 다시 시도할 시각(ms). 모르면 null, 한도 대기가 아니면 undefined. */
  limitUntil?: number | null;
}

export interface OtterState {
  mood: OtterMood;
  /** 그 기분에 해당하는 탭 수(일하는 중이면 도는 탭 수). */
  count: number;
  /** 눌렀을 때 갈 탭. 대표 탭이 없으면 null. */
  tabId: string | null;
  /** 대표 탭의 제목. 말풍선에 쓴다. */
  title: string | null;
  limitUntil?: number | null;
  /** 시간이 지나 저절로 바뀔 시각(끝남 표시가 하나 줄어드는 때). 없으면 다음 상태 변화까지 그대로다. */
  refreshAt?: number;
}

/** 사람이 해야 할 일이 먼저다: 승인·질문 → 오류 → 끝남(안 본 것) → 일하는 중 → 한도 대기 → 쉬는 중. */
export function otterState(tabs: OtterTab[], now = Date.now()): OtterState {
  const pick = (mood: OtterMood, list: OtterTab[], extra: Partial<OtterState> = {}): OtterState => ({
    mood,
    count: list.length,
    tabId: list[0]?.id ?? null,
    title: list[0]?.title ?? null,
    ...extra,
  });
  const waiting = tabs.filter((t) => t.attention === "permission" || t.status === "waiting_permission");
  if (waiting.length) return pick("waiting", waiting);
  const errors = tabs.filter((t) => t.attention === "error");
  if (errors.length) return pick("error", errors);
  const done = tabs.filter((t) => t.attention === "done" && t.doneAt !== undefined && now - t.doneAt < OTTER_DONE_MS);
  if (done.length) return pick("done", done, { refreshAt: Math.min(...done.map((t) => t.doneAt!)) + OTTER_DONE_MS });
  const working = tabs.filter((t) => t.status === "running" || t.status === "queued");
  if (working.length) return pick("working", working);
  const limited = tabs.filter((t) => t.limitUntil !== undefined);
  if (limited.length) return pick("limit", limited, { limitUntil: limited[0].limitUntil });
  return { mood: "idle", count: 0, tabId: null, title: null };
}
