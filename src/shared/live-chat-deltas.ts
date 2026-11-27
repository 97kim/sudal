import type { ChatEvent } from "./chat-events";

export type LiveTextDelta = Extract<ChatEvent, { type: "text_delta" }>;
export type LiveTextBatch = { event: LiveTextDelta; count: number };

export const LIVE_TEXT_WINDOW_MS = 32;
const MAX_BATCH_EVENTS = 64;
const MAX_BATCH_CHARS = 64 * 1024;

/** Combine only adjacent deltas of a single block. Non-text events must flush first. */
export class LiveTextDeltas {
  private batch: LiveTextBatch | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly publish: (batch: LiveTextBatch) => void) {}

  push(event: LiveTextDelta): void {
    const prev = this.batch;
    if (prev && (prev.event.blockId !== event.blockId || prev.count >= MAX_BATCH_EVENTS ||
      prev.event.text.length + event.text.length > MAX_BATCH_CHARS)) this.flush();
    if (event.text.length > MAX_BATCH_CHARS) {
      this.publish({ event, count: 1 });
      return;
    }
    this.batch = this.batch
      ? { event: { ...this.batch.event, text: this.batch.event.text + event.text }, count: this.batch.count + 1 }
      : { event, count: 1 };
    this.timer ??= setTimeout(() => this.flush(), LIVE_TEXT_WINDOW_MS);
  }

  flush(): void {
    const batch = this.batch;
    this.clear();
    if (batch) this.publish(batch);
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.batch = undefined;
  }
}
