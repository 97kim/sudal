// 승인 요청을 사람 대신 AI 가 판단한 결과(권한 "AI 판단으로 승인"). 거절·시간 초과·중단은 채팅에 한 줄로 남기고,
// 허용·검토 중은 해당 도구 카드에 작은 표시만 붙인다(허용마다 줄을 넣으면 화면이 시끄럽다).
// Codex 는 item/autoApprovalReview/* 알림, Claude 는 system/permission_denied(분류기가 정한 것만)에서 온다.

import type { ChatEvent } from "@shared/chat-events";
import { appMsg } from "./i18n";

export type AiReviewOutcome = "denied" | "timedOut" | "aborted";

/** 모델·도구가 만든 글이라 ANSI·줄바꿈을 걷어 내고 한 줄로 줄인다. */
export function clipLine(s: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 거절·시간 초과·중단 한 줄. key 로 같은 검토의 알림이 여러 번 와도 한 줄만 남는다. */
export function aiReviewNotice(o: { key: string; ts: number; outcome: AiReviewOutcome; action: string; reason?: string | null }): ChatEvent {
  const action = clipLine(o.action, 120) || "?";
  const reason = o.reason ? clipLine(o.reason, 240) : "";
  const m =
    o.outcome === "denied"
      ? reason
        ? appMsg("session.msg.aiReview.deniedReason", { action, reason })
        : appMsg("session.msg.aiReview.denied", { action })
      : appMsg(o.outcome === "timedOut" ? "session.msg.aiReview.timedOut" : "session.msg.aiReview.aborted", { action });
  return { type: "notice", ts: o.ts, level: "warning", key: `ai-review-${o.key}`, ...m };
}
