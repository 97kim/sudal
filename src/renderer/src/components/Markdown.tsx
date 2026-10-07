import { Children, createContext, isValidElement, memo, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Options } from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { Element, ElementContent, Root, Text } from "hast";
import { findFileRefs, localFileHref, parseFileRef, type FileRef as FileRefInfo } from "@shared/file-refs";
import { useLocateFile, useOpenFile } from "./FileViewer";
import { Icon } from "./Icon";
import { LinkChooser } from "./LinkChooser";
import { linkTargetFor, setLinkOpenMode } from "../link-open";
import { RunInTerminalContext, isShellLanguage, normalizeCommand } from "../terminal-run";

// ===== 답변 속 파일 참조("ProductByPoController.kt:63") → 에디터로 열기 =====
// rehype 단계에서 모양이 파일 참조인 텍스트·인라인 코드에 data-file-* 를 달아 두고, FileRef 가 렌더될 때 main 의 file:locate 로
// 실제로 있는 파일인지 확인해 있는 것만 링크로 바꾼다("Node.js" 같은 오탐은 그대로 글자로 남는다).

function markProps(ref: FileRefInfo): Record<string, string> {
  const p: Record<string, string> = { dataFilePath: ref.path };
  if (ref.line) p.dataFileLine = String(ref.line);
  if (ref.endLine) p.dataFileEnd = String(ref.endLine);
  return p;
}

/** hast 를 걸으며 파일 참조를 표시한다. pre·a 아래는 건드리지 않는다(코드 블록은 그대로, 링크는 이미 링크). */
function rehypeFileRefs() {
  const visit = (node: Root | Element, inCode: boolean) => {
    const kids = node.children as ElementContent[];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type === "element") {
        if (c.tagName === "pre" || c.tagName === "a") continue;
        if (c.tagName === "code") {
          // 인라인 코드 전체가 참조 하나면 code 자체를 링크로
          const text = c.children.map((k) => (k.type === "text" ? k.value : "")).join("");
          const ref = c.children.every((k) => k.type === "text") ? parseFileRef(text) : null;
          if (ref) c.properties = { ...c.properties, ...markProps(ref) };
          else visit(c, true);
          continue;
        }
        visit(c, inCode);
      } else if (c.type === "text" && !inCode) {
        const refs = findFileRefs(c.value);
        if (refs.length === 0) continue;
        const out: ElementContent[] = [];
        let pos = 0;
        for (const r of refs) {
          if (r.start > pos) out.push({ type: "text", value: c.value.slice(pos, r.start) } as Text);
          out.push({
            type: "element",
            tagName: "span",
            properties: markProps(r),
            children: [{ type: "text", value: r.text } as Text],
          } as Element);
          pos = r.end;
        }
        if (pos < c.value.length) out.push({ type: "text", value: c.value.slice(pos) } as Text);
        kids.splice(i, 1, ...out);
        i += out.length - 1;
      }
    }
  };
  return (tree: Root) => visit(tree, false);
}

/** 존재 확인 결과 캐시(cwd + 참조 → 경로들). 스트리밍 중 마크다운이 계속 다시 렌더돼도 다시 묻지 않는다. */
const located = new Map<string, string[] | Promise<string[]>>();
const LOCATED_MAX = 2000;

interface FileRefProps {
  path: string;
  line?: number;
  endLine?: number;
  /** span(본문 글자), code(인라인 코드), a(마크다운 링크 — 못 찾으면 링크 모양을 벗기고 이유를 title 로) */
  as: "span" | "code" | "a";
  className?: string;
  children?: ReactNode;
}

function FileRef({ path, line, endLine, as, className, children }: FileRefProps) {
  const { t } = useTranslation();
  const { cwd, locate } = useLocateFile();
  const openFile = useOpenFile();
  const key = `${cwd ?? ""}\0${path}`;
  const [found, setFound] = useState<string[] | null>(() => {
    const v = located.get(key);
    return Array.isArray(v) ? v : null;
  });
  const [chooser, setChooser] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    let v = located.get(key);
    if (!v) {
      if (located.size >= LOCATED_MAX) located.clear();
      v = locate(path).then(
        (r) => {
          located.set(key, r);
          return r;
        },
        () => {
          located.set(key, []);
          return [] as string[];
        },
      );
      located.set(key, v);
    }
    Promise.resolve(v).then((r) => alive && setFound(r));
    return () => {
      alive = false;
    };
  }, [cwd, key, locate, path]);

  useEffect(() => {
    if (!chooser) return;
    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      setChooser(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [chooser]);

  const Tag = as;
  if (!found || found.length === 0) {
    // 링크로 쓰였는데 파일이 없으면 링크처럼 보이지 않게(눌러도 아무 일 없으니). 확인 중(found=null)일 때도 잠깐 이 모양.
    if (as === "a") return <span className={className} title={found ? t("chat.markdown.notFound", { path }) : undefined}>{children}</span>;
    return <Tag className={className}>{children}</Tag>;
  }

  const at = line ? { line, endLine } : null;
  const open = (p: string) => {
    setChooser(null);
    openFile(p, at);
  };
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (found.length === 1) return open(found[0]);
    setChooser({ x: e.clientX, y: e.clientY + 6 });
  };
  const range = line ? `${line}${endLine ? `–${endLine}` : ""}` : null;
  const openLabel = found.length === 1 ? (range ? t("chat.markdown.openInEditorLines", { range }) : t("chat.markdown.openInEditor")) : range ? t("chat.markdown.openInEditorLinesChoose", { range, count: found.length }) : t("chat.markdown.openInEditorChoose", { count: found.length });
  const title = found.length === 1 ? `${openLabel}\n${found[0]}` : openLabel;
  const style = chooser ? { left: Math.min(chooser.x, window.innerWidth - 420), top: Math.min(chooser.y, window.innerHeight - 40 * Math.min(found.length, 8) - 24) } : undefined;
  return (
    <>
      <Tag role="link" tabIndex={0} className={`file-ref ${className ?? ""}`} title={title} onClick={onClick} data-file-ref={path}>
        {children}
      </Tag>
      {chooser && (
        <span role="menu" className="fixed z-50 flex w-[400px] flex-col rounded-lg border border-line bg-panel p-1.5 shadow-xl" style={style} onMouseDown={(e) => e.stopPropagation()} data-file-ref-chooser>
          <span className="px-2 pb-1 pt-0.5 text-[10px] text-muted">{t("chat.markdown.ambiguous")}</span>
          {found.slice(0, 8).map((p) => (
            <button key={p} role="menuitem" onClick={() => open(p)} className="mono truncate rounded-md px-2 py-1.5 text-left text-[11.5px] hover:bg-panel-2" title={p}>
              {cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p}
            </button>
          ))}
        </span>
      )}
    </>
  );
}

type RefAttrs = { "data-file-path"?: string; "data-file-line"?: string; "data-file-end"?: string };
function refOf(props: RefAttrs): Omit<FileRefProps, "as"> | null {
  const path = props["data-file-path"];
  if (!path) return null;
  const line = props["data-file-line"] ? Number(props["data-file-line"]) : undefined;
  const endLine = props["data-file-end"] ? Number(props["data-file-end"]) : undefined;
  return { path, line, endLine };
}
function stripRef<T extends RefAttrs & { node?: unknown }>(props: T) {
  const { node: _n, "data-file-path": _p, "data-file-line": _l, "data-file-end": _e, ...rest } = props;
  return rest;
}

function MdSpan(props: React.HTMLAttributes<HTMLSpanElement> & RefAttrs & { node?: unknown }) {
  const ref = refOf(props);
  const rest = stripRef(props);
  if (!ref) return <span {...rest} />;
  return <FileRef {...ref} as="span" className={rest.className}>{rest.children}</FileRef>;
}

function MdCode(props: React.HTMLAttributes<HTMLElement> & RefAttrs & { node?: unknown }) {
  const ref = refOf(props);
  const rest = stripRef(props);
  if (!ref) return <code {...rest} />;
  return <FileRef {...ref} as="code" className={rest.className}>{rest.children}</FileRef>;
}

/**
 * 링크: 클릭하면 "인앱 브라우저 / 기본 브라우저" 선택 팝업(기억 가능). ⌘/Ctrl·가운데 클릭은 바로 기본 브라우저,
 * ⌥클릭은 바로 인앱 브라우저, ⇧클릭은 기억을 무시하고 다시 묻는다. 메인 창이 이동하는 일은 없다(preventDefault + main 의 will-navigate).
 * http(s) 가 아닌 링크(mailto 등)는 외부로만 보낸다.
 */
function MdLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const { node: _node, ...anchorProps } = props;
  // 로컬 파일을 가리키는 링크("[AGENTS.md 열기](/Users/me/dev/AGENTS.md)", file://, ~/, ./ …)는 브라우저가 아니라 에디터로.
  const local = props.href ? localFileHref(props.href) : null;
  if (local)
    return (
      <FileRef as="a" path={local.path} line={local.line} endLine={local.endLine} className={props.className}>
        {props.children}
      </FileRef>
    );
  return <MdWebLink {...anchorProps} />;
}

function MdWebLink({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { t } = useTranslation();
  const openFile = useOpenFile();
  const [chooser, setChooser] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLAnchorElement>(null);

  const openIn = (where: "app" | "external") => {
    if (!href) return;
    if (where === "app") openFile(href);
    else void window.sudal.browser.openExternal(href);
  };
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    const where = linkTargetFor(href, e);
    if (where !== "ask") return openIn(where);
    const r = anchor.current?.getBoundingClientRect();
    setChooser({ x: e.clientX || r?.left || 0, y: (r?.bottom ?? e.clientY) + 4 });
  };

  return (
    <>
      <a
        ref={anchor}
        href={href}
        onClick={onClick}
        onAuxClick={(e) => e.button === 1 && onClick(e)}
        title={href ? `${href}\n${t("chat.markdown.linkHint")}` : undefined}
        {...rest}
      >
        {children}
      </a>
      {chooser && href && (
        <LinkChooser
          href={href}
          x={chooser.x}
          y={chooser.y}
          onDecide={(where, remember) => {
            if (remember) setLinkOpenMode(where);
            setChooser(null);
            openIn(where);
          }}
          onClose={() => setChooser(null)}
        />
      )}
    </>
  );
}

/**
 * 코드 블록. 셸 명령(bash·sh·zsh·shell)이면 "터미널에서 실행" 을 띄운다 — 지금은 복사해서 붙여야 한다.
 * 넣기만 하고 Enter 는 사용자가 친다(⌥클릭이면 바로 실행). 터미널을 열 수 없는 탭(작업 경로 없음)에서는 버튼이 없다.
 */
function MdPre(props: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const { t } = useTranslation();
  const { node: _node, children, ...rest } = props;
  const run = useContext(RunInTerminalContext);
  const ref = useRef<HTMLPreElement>(null);
  const lang = Children.toArray(children)
    .map((c) => (isValidElement<{ className?: string }>(c) ? c.props.className : undefined))
    .find(Boolean);
  if (!run || !isShellLanguage(lang)) return <pre {...rest}>{children}</pre>;
  const send = (e: MouseEvent<HTMLButtonElement>) => {
    const cmd = normalizeCommand(ref.current?.querySelector("code")?.textContent ?? "");
    if (cmd) run(cmd, e.altKey);
  };
  return (
    <div className="group relative" data-shell-block>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
      <button
        onClick={send}
        className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[10.5px] text-muted opacity-0 shadow-sm hover:text-fg group-hover:opacity-100 focus:opacity-100"
        title={t("chat.markdown.runInTerminalHint")}
        data-run-in-terminal
      >
        <Icon name="terminal" size={11} />
        {t("chat.markdown.runInTerminal")}
      </button>
    </div>
  );
}

/** 문서 미리보기가 보여 주는 파일. 그림의 상대 경로를 이 파일 기준으로 푼다. */
interface DocBase {
  cwd: string;
  /** 마크다운 파일의 절대 경로. */
  file: string;
}
const DocBaseContext = createContext<DocBase | null>(null);

/** 그림 주소 → data URL. CSP 가 img-src 'self' data: 라 원격·로컬 그림 모두 main 이 받아 넘긴다. */
async function loadDocImage(src: string, base: DocBase): Promise<string | null> {
  if (/^https?:/i.test(src)) return window.sudal.files.remoteImage(src);
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  const clean = decodeURIComponent(src.replace(/[?#].*$/, ""));
  // GitHub 처럼 "/" 로 시작하면 저장소(cwd) 기준, 아니면 문서가 있는 폴더 기준
  const dir = clean.startsWith("/") ? base.cwd : base.file.slice(0, base.file.lastIndexOf("/"));
  const parts: string[] = [];
  for (const seg of `${dir}/${clean}`.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const view = await window.sudal.files.read(base.cwd, "/" + parts.join("/"));
  return view.image?.dataUrl ?? null;
}

function MdImg(props: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const { node: _node, src, ...rest } = props;
  const base = useContext(DocBaseContext);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!base || typeof src !== "string" || !src) return;
    let alive = true;
    loadDocImage(src, base).then(
      (u) => alive && setUrl(u),
      () => alive && setUrl(null),
    );
    return () => {
      alive = false;
    };
  }, [base, src]);
  // 못 받았거나 받는 중이면 대체 글만 — 깨진 그림 아이콘을 띄우지 않는다.
  if (!url) return rest.alt ? <span className="text-muted">{rest.alt}</span> : null;
  return <img src={url} {...rest} />;
}

const REMARK_PLUGINS: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }]];
const CHAT_REHYPE: Options["rehypePlugins"] = [rehypeHighlight, rehypeFileRefs];
// 문서(README 등)는 HTML 도 그린다 — <p align>·<img width>·배지. 정리(sanitize)는 하이라이트 전에 둬야 hljs 클래스가 남는다.
const DOC_REHYPE: Options["rehypePlugins"] = [rehypeRaw, rehypeSanitize, rehypeHighlight, rehypeFileRefs];
const CHAT_COMPONENTS: Options["components"] = { a: MdLink, span: MdSpan, code: MdCode, pre: MdPre };
const DOC_COMPONENTS: Options["components"] = { ...CHAT_COMPONENTS, img: MdImg };

/** variant "doc": 파일 미리보기처럼 문서 한 편을 읽는 화면. 채팅보다 큰 제목·넉넉한 간격·읽기 좋은 폭(styles.css .md-doc). */
export const Markdown = memo(function Markdown({ text, variant, base }: { text: string; variant?: "doc"; base?: DocBase }) {
  const doc = variant === "doc";
  return (
    <DocBaseContext.Provider value={base ?? null}>
    <div className={doc ? "md md-doc" : "md"}>
      <ReactMarkdown
        // 물결표 하나는 취소선으로 보지 않는다 — "80~180px · 200~320px" 처럼 범위를 두 번 쓰면 그 사이가 줄 그어졌다. ~~두 개~~ 는 그대로 취소선.
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={doc ? DOC_REHYPE : CHAT_REHYPE}
        components={doc ? DOC_COMPONENTS : CHAT_COMPONENTS}
        // 기본 정리는 file: 을 지운다. 로컬 파일 링크는 MdLink 가 에디터로만 보내고 이동은 하지 않으므로 그 스킴만 남긴다.
        urlTransform={(url) => (/^file:/i.test(url) ? url : defaultUrlTransform(url))}
      >
        {text}
      </ReactMarkdown>
    </div>
    </DocBaseContext.Provider>
  );
});
