import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONL_CHUNK_BYTES, readJsonl } from "./jsonl-reader";

test("JSONL reads span chunks, keep UTF-8 and exact resume offsets, and defer unfinished records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sudal-jsonl-"));
  const file = path.join(dir, "history.jsonl");
  try {
    const lines = ["x".repeat(JSONL_CHUNK_BYTES - 1) + "한글", "여러 줄".repeat(30_000), "last"];
    const text = lines.join("\r\n");
    fs.writeFileSync(file, text);
    const records = [...readJsonl(file)];
    assert.deepEqual(records.map((r) => r.line), lines);
    assert.equal(records[0].end, Buffer.byteLength(lines[0] + "\r\n"));
    assert.equal(records[1].end, Buffer.byteLength(lines.slice(0, 2).join("\r\n") + "\r\n"));
    assert.deepEqual([...readJsonl(file, true, records[0].end)].map(record => record.line), lines.slice(1));
    assert.deepEqual([...readJsonl(file, false)].map((r) => r.line), lines.slice(0, 2));
    const reader = readJsonl(file);
    reader.next();
    reader.return(undefined);
    fs.unlinkSync(file); // generator cleanup must release the descriptor, including on Windows
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
