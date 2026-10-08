// 답변 본문 속 파일 참조("ProductByPoController.kt:63", "src/main/index.ts", "application.yml:3") 찾기.
// 여기서는 모양만 본다 — 실제로 있는 파일인지는 main 의 file:locate 가 판단하고, 렌더러는 찾은 것만 링크로 바꾼다.

export interface FileRef {
  /** 쓰인 그대로의 경로(절대·상대·파일명만). 정리는 안 한다. */
  path: string;
  line?: number;
  endLine?: number;
}

export interface FileRefMatch extends FileRef {
  start: number;
  end: number;
  /** 매치된 원문("foo.ts:12-20"). 링크 글자로 그대로 쓴다. */
  text: string;
}

/** 파일로 볼 확장자. 모양만으로 걸러야 "e.g." "v1.2" "Node.js" 같은 것이 덜 걸린다(그래도 걸린 것은 존재 확인으로 한 번 더 거른다). */
const EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs mts cts json json5 jsonc yml yaml toml ini cfg conf env properties gradle " +
    "kt kts java scala groovy py pyi rb go rs c h cc cpp hpp cs swift m mm php sh bash zsh fish ps1 bat cmd " +
    "md mdx txt rst adoc css scss sass less styl html htm xml svg vue svelte astro sql prisma graphql gql proto " +
    "tf tfvars hcl lock csv tsv plist dart lua r jl ex exs erl hs elm clj cljs edn zig sol ipynb tex bib log " +
    "cjsx coffee pug ejs hbs mustache njk liquid wxs xsl xslt dockerfile makefile cmake editorconfig gitignore"
  ).split(" "),
);

// 경로: (./ ../ / C:\)? 디렉토리들/ 이름.확장자  — 앞뒤가 경로 글자면 안 됨(URL 의 host/path 조각, 이메일 등을 피한다).
// 구분자는 / 와 \ 둘 다(Windows). 줄: ":12", ":12-20", ":12–20", ":12:5"(열은 무시), "#L12", "#L12-L20".
const REF_RE =
  /(?<![\w./\\@~-])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w@-]+(?:\.[\w-]+)*\.([A-Za-z]\w{0,11}))(?::(\d+)(?:(-|–|:)(\d+))?|#L(\d+)(?:-L?(\d+))?)?(?![\w/\\])/g;

function fromMatch(m: RegExpExecArray): FileRef | null {
  const [, path, ext, l1, sep, l2, hl1, hl2] = m;
  if (!EXTENSIONS.has(ext.toLowerCase())) return null;
  // 파일명만 있고 확장자가 흔한 단어면("index.md" 는 괜찮지만 "e.g" 류) 위 whitelist 가 거른다. 여기선 줄 번호만 정리.
  const ref: FileRef = { path };
  const line = l1 ?? hl1;
  if (line !== undefined) {
    const n = Number(line);
    if (n > 0) ref.line = n;
    const end = hl1 !== undefined ? hl2 : sep === ":" ? undefined : l2;
    if (end !== undefined && ref.line !== undefined) {
      const e = Number(end);
      if (e >= ref.line) ref.endLine = e;
    }
  }
  return ref;
}

/** 문자열 전체가 파일 참조 하나이면 그것을, 아니면 null. 인라인 코드(`foo.ts:12`)에 쓴다. */
export function parseFileRef(token: string): FileRef | null {
  const t = token.trim();
  REF_RE.lastIndex = 0;
  const m = REF_RE.exec(t);
  if (!m || m.index !== 0 || m[0].length !== t.length) return null;
  return fromMatch(m);
}

/** 텍스트 안의 파일 참조를 모두 찾는다(겹치지 않게, 앞에서부터). */
export function findFileRefs(text: string): FileRefMatch[] {
  const out: FileRefMatch[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text))) {
    const ref = fromMatch(m);
    if (ref) out.push({ ...ref, start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/**
 * 마크다운 링크의 href 가 로컬 파일을 가리키면 참조로 푼다: "file:///Users/a/b.md", "/abs/x.ts", "~/x.ts", "./x.ts", "../x.ts",
 * 또는 "src/a.ts:12" 처럼 모양이 파일 참조인 것. "#L12"·":12" 줄 표기를 받는다. 웹·mailto·페이지 안 앵커면 null.
 */
export function localFileHref(href: string): FileRef | null {
  let h = href.trim();
  if (!h || /^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(h)) return null;
  if (/^file:/i.test(h)) {
    try {
      const u = new URL(h);
      // file:///C:/x 의 pathname 은 "/C:/x" — 앞 슬래시를 뗀다
      h = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:[\\/])/, "$1") + u.hash;
    } catch {
      return null;
    }
  }
  const drive = /^[A-Za-z]:[\\/]/.test(h); // "C:\x" 는 스킴이 아니라 Windows 절대 경로
  if (!drive && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(h)) return null; // 다른 스킴(vscode: 등). "AGENTS.md:3" 의 :숫자 는 줄 번호
  const m = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:[-–](\d+))?)?$/.exec(h);
  if (!m) return null;
  const path = m[1];
  if (!path) return null;
  const explicit = drive || /^(\/|~[\\/]|\.\.?[\\/]|\\\\)/.test(path);
  if (!explicit) {
    const ref = parseFileRef(h);
    return ref;
  }
  const ref: FileRef = { path };
  const line = Number(m[2] ?? m[4]);
  if (line > 0) {
    ref.line = line;
    const end = Number(m[3] ?? m[5]);
    if (end >= line) ref.endLine = end;
  }
  return ref;
}
