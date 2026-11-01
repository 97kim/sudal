import fs from "node:fs";

export const JSONL_CHUNK_BYTES = 64 * 1024;

/** A record may span chunks; decode only complete lines so UTF-8 is never split. */
export function* readJsonl(file: string, includeTrailing = true, from = 0): Generator<{ line: string; end: number }> {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
  const size = fs.fstatSync(fd).size;
  let parts: Buffer[] = [];
  let offset = Math.max(0, Math.min(size, Math.floor(from)));
  try {
    for (;;) {
      if (offset >= size) break;
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) break;
      let start = 0;
      for (let i = 0; i < count; i++) {
        if (buffer[i] !== 10) continue;
        parts.push(buffer.subarray(start, i));
        const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8").replace(/\r$/, "");
        parts = [];
        yield { line, end: offset + i + 1 };
        start = i + 1;
      }
      // The shared read buffer is overwritten on the next iteration.
      if (start < count) parts.push(Buffer.from(buffer.subarray(start, count)));
      offset += count;
    }
    if (includeTrailing && parts.length) yield { line: Buffer.concat(parts).toString("utf8"), end: offset };
  } finally {
    fs.closeSync(fd);
  }
}
