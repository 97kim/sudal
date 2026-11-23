import fs from "node:fs";
import type { ChatEvent } from "@shared/chat-events";
import { isHistoryPreviewEvent, updateHistoryPreview } from "@shared/session-history";
import type { Block } from "@shared/session-state";
import { readJsonl } from "./jsonl-reader";

export const HISTORY_PREVIEW_BYTES = 1024 * 1024;
export const HISTORY_PREVIEW_MIN_FILE_BYTES = 4 * HISTORY_PREVIEW_BYTES;
const PREVIEW_ID_SCAN_BYTES = 96 * HISTORY_PREVIEW_BYTES;
const PREVIEW_ID_SCAN_MS = 250;

/** Match the literal and Unicode-escaped spellings of an ASCII JSON token. */
function jsonWordPattern(word: string): string {
  const chars = Array.from(word, char => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `(?:${char}|\\\\u${hex})`;
  });
  return `"${chars.join("")}"`;
}
const textEventOnLine = new RegExp(
  `${jsonWordPattern("type")}\\s*:\\s*(?:${jsonWordPattern("assistant_text")}|${jsonWordPattern("text_delta")})`,
  "i",
);

/** A tail update may belong to an older block, including one hidden by a
 * compaction outside the sample. Check candidate IDs without replaying history. */
function withoutEarlierText(file: string, before: number, blocks: Block[]): Block[] {
  const candidates = new Set(blocks.flatMap(b => b.kind === "text" ? [b.id] : []));
  if (!before || !candidates.size) return blocks;
  const userOnly = () => blocks.filter(b => b.kind === "user");
  if (before > PREVIEW_ID_SCAN_BYTES) return userOnly();
  const needles = [...candidates].map(id => JSON.stringify(id).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"));
  const candidateOnLine = new RegExp('"blockId"\\s*:\\s*(?:' + needles.join("|") + ")");
  const deadline = performance.now() + PREVIEW_ID_SCAN_MS;
  for (const { line } of readJsonl(file, false, 0, before)) {
    if (performance.now() >= deadline) return userOnly();
    // Legacy text records may escape an ID or field name. ANSI escapes in
    // tool output alone don't make the record a text event candidate.
    if (!candidateOnLine.test(line) && !(line.includes("\\u") && textEventOnLine.test(line))) continue;
    if (performance.now() >= deadline) return userOnly();
    try {
      const event = JSON.parse(line) as ChatEvent | null;
      if (event?.type === "assistant_text" || event?.type === "text_delta") candidates.delete(event.blockId);
    } catch { /* Ignore invalid records just as the full reader does. */ }
    if (!candidates.size) break;
  }
  if (performance.now() >= deadline) return userOnly();
  return blocks.filter(b => b.kind !== "text" || candidates.has(b.id));
}

export function readHistoryPreview(file: string): Block[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - HISTORY_PREVIEW_BYTES - 1);
    const bytes = Buffer.allocUnsafe(size - offset);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, offset + count);
      if (!n) break;
      count += n;
    }
    const suffix = bytes.subarray(0, count);
    // If the byte window starts mid-record (possibly mid-UTF-8 codepoint),
    // skip through the first newline instead of decoding that fragment.
    const firstNewline = offset ? suffix.indexOf(10) : -1;
    if (offset && firstNewline < 0) return [];
    const records = suffix.subarray(firstNewline + 1).toString("utf8").split("\n");
    let blocks: Block[] = [];
    let fold = 0;
    const firstFoldForText = new Map<string, number>();
    for (const line of records) {
      if (!line) continue;
      let event: ChatEvent;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || !isHistoryPreviewEvent(event)) continue;
      if (event.type === "compacted") fold++;
      if (event.type === "assistant_text" || event.type === "text_delta") {
        const firstFold = firstFoldForText.get(event.blockId);
        if (firstFold !== undefined && firstFold !== fold) continue;
        firstFoldForText.set(event.blockId, fold);
      }
      blocks = updateHistoryPreview(blocks, event);
    }
    return withoutEarlierText(file, offset + firstNewline + 1, blocks);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
