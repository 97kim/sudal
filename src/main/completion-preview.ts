import type { ChatEvent } from "@shared/chat-events";

const SAMPLE_CHARS = 512;
export const COMPLETION_PREVIEW_CHARS = 140;

/** Keep a small sample of the current reply for the completion notification. */
export class CompletionPreview {
  private latest = "";
  private streamId: string | undefined;
  private stream = "";

  reset() {
    this.latest = "";
    this.streamId = undefined;
    this.stream = "";
  }

  observe(event: ChatEvent): string | undefined {
    switch (event.type) {
      case "user_message":
      case "session_reset":
        this.reset();
        break;
      case "status":
        if (event.status === "idle" || event.status === "error") this.reset();
        break;
      case "assistant_text": {
        const sample = event.text.slice(0, SAMPLE_CHARS).trim();
        if (sample) this.latest = sample;
        this.streamId = undefined;
        this.stream = "";
        break;
      }
      case "text_delta":
        if (event.blockId !== this.streamId) {
          this.streamId = event.blockId;
          this.stream = "";
        }
        this.stream += event.text.slice(0, SAMPLE_CHARS - this.stream.length);
        break;
      case "turn_result": {
        const preview = event.isError ? undefined : (this.stream.trim() || this.latest)
          .replace(/\s+/g, " ").slice(0, COMPLETION_PREVIEW_CHARS);
        this.reset();
        return preview;
      }
    }
  }
}
