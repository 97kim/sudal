import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const JSONL_CHUNK_BYTES = 64 * 1024;

/** A record may span chunks; decode only complete lines so UTF-8 is never split. */
export function* readJsonl(file: string, includeTrailing = true, from = 0, until = Infinity): Generator<{ line: string; end: number }> {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
  const size = Math.min(fs.fstatSync(fd).size, Math.max(0, Math.floor(until)));
  let decoder: StringDecoder | undefined;
  let parts: string[] = [];
  let offset = Math.max(0, Math.min(size, Math.floor(from)));
  try {
    for (;;) {
      if (offset >= size) break;
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) break;
      const chunk = buffer.subarray(0, count);
      let start = 0;
      for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
        const bytes = chunk.subarray(start, i);
        let text: string;
        if (decoder) {
          parts.push(decoder.end(bytes));
          text = parts.join("");
          parts = [];
          decoder = undefined;
        } else {
          text = bytes.toString("utf8");
        }
        yield { line: text.replace(/\r$/, ""), end: offset + i + 1 };
        start = i + 1;
      }
      // Decode each piece before reusing the read buffer. StringDecoder
      // preserves split UTF-8 sequences without keeping raw chunks and then
      // allocating a second full-size binary buffer for a very large line.
      if (start < count) {
        decoder ??= new StringDecoder("utf8");
        parts.push(decoder.write(chunk.subarray(start)));
      }
      offset += count;
    }
    if (includeTrailing && decoder) {
      parts.push(decoder.end());
      yield { line: parts.join(""), end: offset };
    }
  } finally {
    fs.closeSync(fd);
  }
}
