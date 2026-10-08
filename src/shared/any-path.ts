// 운영체제와 상관없이 문자열로 경로를 다룬다. 렌더러에는 node:path 가 없고, main 이 넘기는 경로는
// macOS 면 "/a/b", Windows 면 "C:\a\b" — git 이 주는 것은 Windows 에서도 "C:/a/b" 라 두 표기가 섞인다.
// 그래서 구분자는 / 와 \ 를 모두 받고, 비교할 때는 / 로 맞춘다.

/** "/a", "C:\a", "C:/a", "\\server\share" */
export function isAbsoluteAny(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Windows 표기인가(드라이브 문자·UNC). 이런 경로는 대소문자를 가리지 않고 비교한다. */
function isWinStyle(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.startsWith("\\\\");
}

/**
 * \ 를 구분자로 보나. macOS·Linux 에서는 \ 가 파일 이름에 들어갈 수 있는 글자라("a\b.ts") Windows 표기일 때만 —
 * 드라이브 문자·UNC 이거나, / 없이 \ 만 쓴 상대 경로("src\a.ts").
 */
function winSeps(p: string): boolean {
  return isWinStyle(p) || (p.includes("\\") && !p.includes("/"));
}

function lastSep(p: string): number {
  return winSeps(p) ? Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) : p.lastIndexOf("/");
}

export function toPosix(p: string): string {
  return winSeps(p) ? p.replace(/\\/g, "/") : p;
}

/** 끝의 구분자를 뗀다. 루트("/", "C:\")는 그대로. */
export function trimSep(p: string): string {
  const t = p.replace(winSeps(p) ? /[\\/]+$/ : /\/+$/, "");
  if (t === "") return p.slice(0, 1) || p;
  if (/^[A-Za-z]:$/.test(t)) return p.slice(0, 3);
  return t;
}

export function basenameAny(p: string): string {
  const t = trimSep(p);
  const i = lastSep(t);
  return (i >= 0 ? t.slice(i + 1) : t) || t;
}

/** 부모 폴더. 루트의 부모는 루트 자신. */
export function dirnameAny(p: string): string {
  const t = trimSep(p);
  const i = lastSep(t);
  if (i < 0) return ".";
  // "/a" → "/", "C:\a" → "C:\"
  if (i === 0) return t.slice(0, 1);
  if (i === 2 && /^[A-Za-z]:/.test(t)) return t.slice(0, 3);
  return t.slice(0, i);
}

/** dir 이 쓰는 구분자로 이어 붙인다(Windows 표기면 \). name 은 / 로 나뉜 상대 경로여도 된다. */
export function joinAny(dir: string, name: string): string {
  const win = winSeps(dir);
  const s = win && (dir.includes("\\") || !dir.includes("/")) ? "\\" : "/";
  const rest = win ? name.replace(/[\\/]+/g, s).replace(/^[\\/]+/, "") : name.replace(/^\/+/, "");
  return trimSep(dir).replace(win ? /[\\/]$/ : /\/$/, "") + s + rest;
}

/** 비교용 열쇠: / 로 맞추고 끝 구분자를 떼고, Windows 표기면 소문자로. */
export function pathKey(p: string): string {
  const k = toPosix(trimSep(p));
  return isWinStyle(p) ? k.toLowerCase() : k;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** child 가 parent 자신이거나 그 안에 있는지. */
export function isUnderAny(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/** parent 기준 상대 경로(/ 구분). 안에 없으면 null. */
export function relativeAny(child: string, parent: string): string | null {
  if (!isUnderAny(child, parent)) return null;
  const c = toPosix(trimSep(child));
  const p = toPosix(trimSep(parent));
  return c.length === p.length ? "" : c.slice(p.endsWith("/") ? p.length : p.length + 1);
}
