/** Only complete, local HTML references become preview controls. */
export function findVisualizeRefs(text: string) {
  const refs: { start: number; end: number; path: string; title?: string }[] = [];
  const pattern = /\uE200visualize\uE202([^\uE201]*)\uE201/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const data = JSON.parse(match[1]);
      if (!data || typeof data.path !== "string" || data.path.length > 4096) continue;
      const path = data.path;
      if (!/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(path) || !/\.html?$/i.test(path) || /[\x00-\x1f]/.test(path)) continue;
      refs.push({ start: match.index!, end: match.index! + match[0].length, path,
        title: typeof data.title === "string" ? data.title.trim().slice(0, 160) || undefined : undefined });
    } catch { /* Incomplete or malformed references remain plain text. */ }
  }
  return refs;
}

export interface VisualizeReplacement { token: string; raw: string; path: string; title?: string }
/** Protect host data from Markdown escapes/emphasis; literal code is restored by the rehype stage. */
export function prepareVisualizeMarkdown(text: string): { text: string; replacements: VisualizeReplacement[] } {
  const refs = findVisualizeRefs(text);
  if (!refs.length) return { text, replacements: [] };
  let prefix = "\uE200sudalpreview";
  while (text.includes(prefix)) prefix += "x";
  const replacements = refs.map((ref, index) => ({ token: `${prefix}${index}z\uE201`, raw: text.slice(ref.start, ref.end), path: ref.path, title: ref.title }));
  let output = "", offset = 0;
  refs.forEach((ref, index) => { output += text.slice(offset, ref.start) + replacements[index].token; offset = ref.end; });
  return { text: output + text.slice(offset), replacements };
}
