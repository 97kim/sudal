// 렌더러에서 문서 속 상대 경로를 풀고 LSP 용 file URI 를 만드는 순수 로직. node:path 가 없어 문자열로 한다.
// Windows 경로("C:\a\b")는 드라이브 문자와 구분자를 지켜야 main 이 같은 파일로 알아본다.

/** dir 기준으로 rel 을 풀어 절대 경로로. ".." 는 위로 올라가되 루트("/", "C:\")는 넘지 않는다. */
export function resolveUnder(dir: string, rel: string): string {
  const drive = /^[A-Za-z]:/.test(dir) ? dir.slice(0, 2) : "";
  const unc = !drive && dir.startsWith("\\\\");
  const sep = dir.includes("\\") || (drive && !dir.includes("/")) ? "\\" : "/";
  const parts: string[] = [];
  for (const seg of `${dir.slice(drive.length)}/${rel}`.split(/[\\/]/)) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return (unc ? "\\\\" : drive + sep) + parts.join(sep);
}

/** 절대 경로 → file URI. Windows 는 "file:///C:/a/b.ts", UNC 는 "file://server/share/x". */
export function fileUri(path: string): string {
  let p = path;
  if (/^[A-Za-z]:/.test(p)) p = "/" + p.replace(/\\/g, "/");
  else if (p.startsWith("\\\\")) p = p.replace(/\\/g, "/").slice(2);
  return `file://${encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}
