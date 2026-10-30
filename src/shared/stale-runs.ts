// 앱이 도중에 꺼져 "진행 중" 으로 남은 기록(verify running · fanout running · review requested)을 다시 읽을 때 정리한다.
// 새 프로세스엔 그 실행이 없으므로 카드가 영원히 돌지 않게 실패/중단으로 닫는 이벤트를 만들어 준다.
import type { TFunction } from "i18next";
import type { ChatEvent, FanoutEvent, ReviewEvent, SessionStatus, VerifyEvent } from "./chat-events";
import { ko } from "./i18n/ko";
import type { Msg, MsgKey } from "./i18n/msg";

/** 예전 기록과 견주는 원본(한국어) 문장 — 새 기록은 outputMsg 의 키로 알아본다. */
export const STALE_NOTE = ko.session.msg.stale;
export const STALE_NOTE_KEY = "session.msg.stale";

export function staleRunEvents(t: TFunction, events: Iterable<ChatEvent>, now = Date.now()): ChatEvent[] {
  const note = (key: MsgKey): { text: string; msg: Msg } => ({ text: t(key), msg: { key } });
  const fanoutNote = note("session.msg.staleFanout");
  const reviewNote = note("session.msg.staleReview");
  const verify = new Map<string, VerifyEvent>();
  const fanout = new Map<string, FanoutEvent>();
  const review = new Map<string, ReviewEvent>();
  // 결과가 오지 않은 도구와, 마지막으로 남은 상태. 둘 다 그 프로세스의 것이라 이 프로세스엔 없다.
  const openTools = new Set<string>();
  let lastStatus: SessionStatus | null = null;
  for (const e of events) {
    if (e.type === "verify" && !e.partial) {
      if (e.status === "running") verify.set(e.runId, e);
      else verify.delete(e.runId);
    } else if (e.type === "fanout") {
      if (e.status === "running") fanout.set(e.fanoutId, e);
      else fanout.delete(e.fanoutId);
    } else if (e.type === "review") {
      if (e.status === "requested") review.set(e.reviewTabId, e);
      else review.delete(e.reviewTabId);
    }
    else if (e.type === "tool_use") openTools.add(e.toolUseId);
    else if (e.type === "tool_result") openTools.delete(e.toolUseId);
    else if (e.type === "status") lastStatus = e.status;
  }
  const out: ChatEvent[] = [];
  // 화면은 기록을 재생해 만들어진다 — 닫히지 않은 도구 카드는 앱을 다시 켜도 계속 "실행 중" 으로 시간을 센다.
  for (const toolUseId of openTools) out.push({ type: "tool_result", ts: now, toolUseId, output: t(STALE_NOTE_KEY), outputMsg: { key: STALE_NOTE_KEY }, isError: true });
  for (const v of verify.values())
    if (v.status === "running")
      out.push({
        ...v,
        ts: now,
        status: "aborted",
        commands: v.commands.map((c) => (c.status === "running" ? { ...c, status: "aborted", note: t(STALE_NOTE_KEY), noteMsg: { key: STALE_NOTE_KEY } } : c.status === "pending" ? { ...c, status: "skipped" } : c)),
      });
  for (const f of fanout.values())
    if (f.status === "running")
      out.push({
        ...f,
        ts: now,
        status: "done",
        variants: f.variants.map((x) => (x.status === "running" || x.status === "waiting" ? { ...x, status: "failed", error: fanoutNote.text, errorMsg: fanoutNote.msg } : x)),
      });
  for (const r of review.values()) if (r.status === "requested") out.push({ ...r, ts: now, status: "failed", text: reviewNote.text, textMsg: reviewNote.msg });
  // 마지막이 "도는 중" 이면 화면은 영영 돈다. main 은 새 프로세스라 idle 인데 화면만 어긋나고,
  // 그 상태로는 중단도 듣지 않는다 — main 입장에선 이미 끝난 탭이라 끊을 것이 없다.
  // 조용히 idle 로 바꾸면 하던 일이 끝난 것처럼 보인다 — 끊겼다는 것을 글로 남기고 상태를 내린다.
  if (lastStatus && lastStatus !== "idle" && lastStatus !== "error") {
    out.push({ type: "error", ts: now, message: t("session.msg.staleInterrupted"), msg: { key: "session.msg.staleInterrupted" }, fatal: false });
    out.push({ type: "status", ts: now, status: "idle" });
  }
  return out;
}
