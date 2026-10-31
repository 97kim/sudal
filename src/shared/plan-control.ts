import type { ChatEvent } from "./chat-events";

/** 본문 요청·여러 줄 입력은 대화다. 단순한 모드 명령만 별도 처리한다. */
export function isPlanControl(text: string): boolean {
  return /^\/plan(?:[ \t]+(?:on|off))?$/.test(text.trim());
}

export function isPlanControlOutput(event: ChatEvent): boolean {
  return event.type === "text_delta" || event.type === "assistant_text" || event.type === "thinking_delta"
    || (event.type === "notice" && event.msg?.key === "session.msg.acpConfigChanged")
    || (event.type === "turn_result" && !event.isError);
}

/** 이전 버전이 저장한 ACP 제어 명령도 화면에서 숨긴다. 원본 기록은 수정하지 않는다. */
export function* withoutPlanControlHistory(events: Iterable<ChatEvent>): Generator<ChatEvent> {
  let control = false;
  for (const event of events) {
    if (event.type === "user_message") {
      control = isPlanControl(event.text) && !event.images?.length;
      if (control) continue;
    }
    const hidden = control && isPlanControlOutput(event);
    if (event.type === "turn_result" || (event.type === "status" && (event.status === "idle" || event.status === "error"))) control = false;
    if (!hidden) yield event;
  }
}
