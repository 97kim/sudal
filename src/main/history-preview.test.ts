import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HISTORY_PREVIEW_BYTES, readHistoryPreview } from "./history-preview";
import { Store } from "./persistence";
import type { ChatEvent } from "@shared/chat-events";

test("cold preview reads a bounded tail and never displays folded messages or late cards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-history-preview-"));
  const file = path.join(dir, "log.jsonl");
  try {
    const events: ChatEvent[] = [
      { type: "assistant_text", ts: 1, blockId: "very-old", text: "가".repeat(HISTORY_PREVIEW_BYTES * 2) },
      { type: "text_delta", ts: 2, blockId: "partial", text: "orphan stream" },
      { type: "assistant_text", ts: 2, blockId: "folded-text", text: "older answer inside sample" },
      { type: "user_message", ts: 3, id: "folded", text: "folded message" },
      { type: "compacted", ts: 4, trigger: "manual" },
      { type: "assistant_text", ts: 5, blockId: "ambient", text: "압축 뒤 이어진 답변" },
      { type: "user_message", ts: 6, id: "recent", text: "최근 요청" },
      { type: "text_delta", ts: 7, blockId: "answer", text: "최근 " },
      { type: "text_delta", ts: 8, blockId: "answer", text: "답변" },
      { type: "assistant_text", ts: 9, blockId: "answer", text: "완료 답변" },
      { type: "tool_result", ts: 10, toolUseId: "long-ago-tool", output: "not a message", isError: false },
      { type: "assistant_text", ts: 11, blockId: "very-old", text: "late update from outside the sample" },
      { type: "assistant_text", ts: 12, blockId: "folded-text", text: "late update from before the compaction" },
    ];
    const rows = events.map(e => JSON.stringify(e));
    rows[0] = rows[0].replace('"type":"assistant_text"', '"\\u0074ype":"assistant_\\u0074ext"')
      .replace('"blockId":"very-old"', '"block\\u0049d":"\\u0076ery-old"');
    fs.writeFileSync(file, rows.join("\n") + '\n{"type":');
    assert.deepEqual(readHistoryPreview(file).map(b => b.kind === "text" || b.kind === "user" ? [b.id, b.text] : b.id),
      [["ambient", "압축 뒤 이어진 답변"], ["recent", "최근 요청"], ["answer", "완료 답변"]]);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test("ANSI escapes in earlier tool output do not trigger full record parsing", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-history-preview-"));
  const file = path.join(dir, "log.jsonl");
  try {
    const output = '\x1b[31m{"type":"assistant_text","blockId":"answer"}\x1b[0m' + "x".repeat(192 * 1024);
    const tool = { type: "tool_result", ts: 1, toolUseId: "ansi", output, isError: false };
    const earlierToolRow = JSON.stringify(tool);
    const rows = Array<string>(16).fill(earlierToolRow);
    rows.push(...Array<string>(8).fill(JSON.stringify({ ...tool, ts: 2 })));
    rows.push(JSON.stringify({ type: "assistant_text", ts: 3, blockId: "answer", text: "latest answer" }));
    fs.writeFileSync(file, rows.join("\n") + "\n");

    const parse = JSON.parse;
    let parsedEarlierToolRows = 0;
    t.mock.method(JSON, "parse", (value: string) => {
      if (value === earlierToolRow) parsedEarlierToolRows++;
      return parse(value);
    });
    assert.deepEqual(readHistoryPreview(file).map(block => block.id), ["answer"]);
    assert.equal(parsedEarlierToolRows, 0);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test("small thread records take the ordinary authoritative route", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-history-preview-"));
  const store = new Store(dir);
  try {
    store.appendEvent("tab", { type: "user_message", ts: 1, id: "recent", text: "normal thread" });
    assert.equal(store.historyPreview("tab"), null);
    assert.equal(store.readEvents("tab").length, 1);
  } finally {
    const file = store.threadPath("tab");
    fs.unlinkSync(file);
    fs.rmdirSync(path.dirname(file));
    fs.rmdirSync(dir);
  }
});
