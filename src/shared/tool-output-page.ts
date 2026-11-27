// Bound the text handed to Chromium even when a command returns one enormous line.
// Page boundaries keep a UTF-16 surrogate pair together.
export const TOOL_OUTPUT_PAGE_CHARS = 32 * 1024;
export function toolOutputPage(output: string, requested: number, size = TOOL_OUTPUT_PAGE_CHARS) {
  const total = Math.max(1, Math.ceil(output.length / size));
  const index = Math.min(total - 1, Math.max(0, requested));
  const boundary = (offset: number) => {
    const before = output.charCodeAt(offset - 1);
    const after = output.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? offset - 1 : offset;
  };
  return { index, total, text: output.slice(boundary(index * size), boundary((index + 1) * size)) };
}
