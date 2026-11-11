import type { ChatEvent } from './chat-events';

export interface SubagentHistoryCursor {
  offset: number;
  identity: string;
  size: number;
  mtimeMs: number;
  discardPartial?: boolean;
}

export interface SubagentHistoryPage {
  events: ChatEvent[];
  before: number | null;
  /** Some provider content is encrypted or too large to display. */
  limited: boolean;
  unavailable?: boolean;
  cursor?: SubagentHistoryCursor;
  append?: boolean;
  hasNewer?: boolean;
}
