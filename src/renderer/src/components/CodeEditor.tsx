// CodeMirror 6 에디터. 파일 뷰어의 "파일" 보기가 이걸로 편집·저장한다.
// original(HEAD 내용)이 있으면 unifiedMergeView 로 삭제 줄은 빨강으로 끼워 보이고 추가·변경 줄은 초록으로 칠한다 — 편집하면서도 유지된다.
import { useEffect, useRef } from "react";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import { LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import { lintGutter } from "@codemirror/lint";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { currentTheme, onThemeChange } from "../theme";
import { basenameAny } from "@shared/any-path";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "11.5px", backgroundColor: "var(--color-inset)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "var(--color-inset)", borderRight: "1px solid var(--color-line)", color: "var(--color-muted-2)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-accent) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-deletedChunk": { backgroundColor: "var(--color-err-bg)" },
  ".cm-changedLine": { backgroundColor: "var(--color-ok-bg)" },
  // merge 뷰 기본값은 바뀐 글자 아래에 밑줄 이미지를 그린다 — 줄 배경만으로 충분해 글자 강조는 은은한 틴트만 남긴다.
  ".cm-changedText": { backgroundImage: "none", backgroundColor: "color-mix(in srgb, var(--color-ok) 16%, transparent)", borderRadius: "2px" },
  ".cm-deletedText": { backgroundImage: "none", backgroundColor: "color-mix(in srgb, var(--color-err) 18%, transparent)", borderRadius: "2px" },
});

/**
 * 다크 테마의 구문 색. basicSetup 의 기본 하이라이트(fallback)는 밝은 배경용이라 어두운 배경에선 읽기 어렵다.
 * 밝은 테마에선 이 확장을 빼서 기본 색이 그대로 쓰이게 한다.
 */
const darkHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#c792ea" },
  { tag: [t.propertyName, t.attributeName, t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "#82aaff" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "#ffcb6b" },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: "#f78c6c" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.inserted], color: "#c3e88d" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#6b7482", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket], color: "#89ddff" },
  { tag: [t.variableName, t.name, t.character, t.macroName, t.deleted], color: "#e4e8ee" },
  { tag: t.heading, fontWeight: "bold", color: "#82aaff" },
  { tag: [t.link, t.url], color: "#8a90f4", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#f0808f" },
  { tag: t.meta, color: "#97a1b0" },
]);
function themeExtension(dark: boolean): Extension {
  return dark ? [syntaxHighlighting(darkHighlight), EditorView.darkTheme.of(true)] : [EditorView.darkTheme.of(false)];
}

async function languageFor(path: string): Promise<Extension | null> {
  const name = basenameAny(path);
  const desc = languages.find((l) => l.filename?.test(name) || l.extensions.some((e) => name.toLowerCase().endsWith(`.${e}`)));
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}

export function CodeEditor({
  path,
  doc,
  docVersion = 0,
  original,
  readOnly = false,
  lsp = null,
  reveal = null,
  attachRequest = 0,
  onAttach,
  onChange,
  onSave,
}: {
  path: string;
  /** 처음 문서. 마운트·docVersion 변경 때만 읽는다 — 저장 뒤 doc 값이 바뀌어도 에디터(커서·undo)는 유지된다. */
  doc: string;
  /** 올리면 편집 내용을 버리고 doc 으로 다시 만든다 (디스크 내용으로 다시 읽기). */
  docVersion?: number;
  /** HEAD 내용. null 이면 변경 표시 없이 보통 에디터. */
  original: string | null;
  readOnly?: boolean;
  /** 언어 서버 연결(완성·진단·hover·정의로 이동). null 이면 문법 하이라이트만. */
  lsp?: { client: LSPClient; uri: string; languageId: string } | null;
  /** 이 줄 범위를 선택하고 가운데로 스크롤한다(1부터). nonce 가 바뀔 때마다 다시 한다. */
  reveal?: { line: number; endLine?: number; nonce: number } | null;
  /** 올라갈 때마다 현재 선택(없으면 커서 줄)을 onAttach 로 넘긴다("채팅에 첨부" 버튼). */
  attachRequest?: number;
  onAttach?: (sel: { text: string; line: number; endLine: number }) => void;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave, onAttach });
  cb.current = { onChange, onSave, onAttach };
  /** 선택 영역(없으면 커서 줄 전체)을 줄 번호와 함께 부모에게 */
  const attachSelection = (v: EditorView) => {
    const sel = v.state.selection.main;
    const from = v.state.doc.lineAt(sel.from);
    // 선택 끝이 다음 줄 맨 앞(줄 전체를 개행까지 잡은 경우)이면 그 줄은 포함되지 않는다 — 끝 줄은 sel.to - 1 로 잰다
    const toPos = sel.empty ? sel.from : sel.to > sel.from && v.state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
    const to = v.state.doc.lineAt(toPos);
    const text = sel.empty ? from.text : v.state.sliceDoc(sel.from, sel.to);
    cb.current.onAttach?.({ text, line: from.number, endLine: to.number });
  };
  const appliedAttach = useRef(attachRequest);
  useEffect(() => {
    if (attachRequest === appliedAttach.current) return;
    appliedAttach.current = attachRequest;
    if (view.current) attachSelection(view.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachRequest]);
  const docRef = useRef(doc);
  docRef.current = doc;
  // LSP 연결은 에디터를 다시 만들지 않고 compartment 로 갈아 끼운다 — 서버가 늦게 붙거나 죽어도 커서·undo·포커스·치던 글자가 그대로다.
  const lspRef = useRef(lsp);
  lspRef.current = lsp;
  // 줄 이동: 뷰가 있으면 바로, 아직 만드는 중이면 만든 직후에 적용한다.
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const appliedReveal = useRef<number | null>(null);
  const applyReveal = (v: EditorView) => {
    const r = revealRef.current;
    if (!r || appliedReveal.current === r.nonce) return;
    appliedReveal.current = r.nonce;
    const lines = v.state.doc.lines;
    const from = v.state.doc.line(Math.min(Math.max(1, r.line), lines)).from;
    const to = v.state.doc.line(Math.min(Math.max(r.line, r.endLine ?? r.line), lines)).to;
    v.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(EditorSelection.range(from, to), { y: "center" }),
    });
    v.focus();
  };
  useEffect(() => {
    if (view.current) applyReveal(view.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);
  const lspComp = useRef(new Compartment());
  const lspExtension = (l: typeof lsp): Extension => (l ? [LSPPlugin.create(l.client, l.uri, l.languageId), lintGutter()] : []);
  useEffect(() => {
    view.current?.dispatch({ effects: lspComp.current.reconfigure(lspExtension(lsp)) });
  }, [lsp]);
  // 재생성 이유가 "다시 읽기"(docVersion·path)가 아니면 — HEAD 가 바뀐 경우 — 치던 내용을 이어받는다.
  // 안 그러면 화면은 디스크 내용으로 돌아가는데 부모의 text 는 친 내용을 들고 있어 보이지 않는 것이 저장된다.
  const themeComp = useRef(new Compartment());
  // 테마가 바뀌면 에디터를 다시 만들지 않고 compartment 만 갈아 끼운다(커서·undo 유지).
  useEffect(
    () => onThemeChange((th) => view.current?.dispatch({ effects: themeComp.current.reconfigure(themeExtension(th === "dark")) })),
    [],
  );
  const seed = useRef<{ key: string; text: string | null }>({ key: `${path}\u0000${docVersion}`, text: null });

  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    let v: EditorView | null = null;
    const key = `${path}\u0000${docVersion}`;
    const carried = seed.current.key === key ? seed.current.text : null;
    seed.current = { key, text: null };
    void languageFor(path).then((lang) => {
      if (!alive || !host.current) return;
      const initial = carried ?? docRef.current;
      const extensions: Extension[] = [
        basicSetup,
        themeComp.current.of(themeExtension(currentTheme() === "dark")),
        keymap.of([indentWithTab, { key: "Mod-s", run: () => (cb.current.onSave(), true) }, { key: "Mod-Shift-a", run: (v) => (attachSelection(v), true) }]),
        theme,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
        }),
      ];
      if (lang) extensions.push(lang);
      // 플러그인이 클라이언트 설정의 확장(완성·진단 등)을 함께 가져온다. 진단은 거터에도 표시.
      extensions.push(lspComp.current.of(lspExtension(lspRef.current)));
      if (original !== null && original !== initial)
        extensions.push(unifiedMergeView({ original, mergeControls: false, highlightChanges: true, gutter: true }));
      v = new EditorView({ state: EditorState.create({ doc: initial, extensions }), parent: host.current });
      view.current = v;
      applyReveal(v);
    });
    return () => {
      alive = false;
      // 다음 effect 가 같은 문서(path·docVersion)를 다시 만들면 이어받을 수 있게 현재 내용을 남긴다
      if (v) seed.current = { key, text: v.state.doc.toString() };
      v?.destroy();
      view.current = null;
    };
    // docVersion(다시 읽기)·original(HEAD 변경)·path 가 바뀌면 에디터를 새로 만든다. 타이핑·저장·LSP 연결은 에디터를 유지한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, docVersion, original, readOnly]);

  return <div ref={host} className="h-full min-h-0 [&_.cm-editor]:h-full" data-code-editor />;
}
