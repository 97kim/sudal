// 인앱 브라우저의 "요소 선택": 페이지에 주입하는 스크립트(마우스를 올리면 테두리, 클릭하면 요소 정보를 console 로 보고)와
// 그 보고를 입력창에 붙일 텍스트로 만드는 순수 함수. 페이지는 preload 없는 샌드박스 webview 라 console-message 로만 돌아온다.
import type { TFunction } from "i18next";
import type { ChatImageDto } from "./ipc";

export const PICK_MARK = "__SUDAL_PICK__";
export const PICK_CANCEL_MARK = "__SUDAL_PICK_CANCEL__";

/** 프롬프트에 실을 계산된 스타일 — 레이아웃·글자·색 위주. 기본값(none/auto/normal/0px/투명)은 뺀다. */
export const ELEMENT_STYLE_PROPS = [
  "display", "position", "width", "height", "margin", "padding", "gap",
  "flex-direction", "justify-content", "align-items", "grid-template-columns",
  "font-family", "font-size", "font-weight", "line-height", "color",
  "background-color", "border", "border-radius", "box-shadow", "opacity", "overflow",
];

export interface PickedElement {
  selector: string;
  tag: string;
  html: string;
  text: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  /** 화면 배율(스크린샷 자르기용). */
  dpr: number;
  /** 개발 서버에서 찾은 이 요소의 소스 위치. 배포본·남의 사이트에는 없다. */
  source?: ElementSource;
}

/**
 * 요소를 만든 코드 위치. file 은 페이지가 아는 그대로(절대 경로·/src/… URL 경로 등)라 렌더러가 저장소 파일로 다시 찾는다.
 * line 은 믿을 수 있을 때만 — React 19 처럼 번들 기준 줄만 알 수 있으면 비워 둔다.
 */
export interface ElementSource {
  file: string;
  line?: number;
  column?: number;
  /** 그 JSX 를 쓴 컴포넌트(React 의 owner, Vue 컴포넌트 이름). */
  component?: string;
  via: "attr" | "react" | "react-stack" | "svelte" | "vue";
}

/** 선택 결과의 상한 — 페이지가 보내는 값이므로 크기를 자른다. */
export const PICK_LIMITS = { html: 4000, text: 200, selector: 300, coord: 20000 };

/**
 * 페이지에 주입하는 스크립트. 한 번 주입되면 window.__sudalPick 로 켜고 끈다.
 * nonce: 이번 선택 세션의 표식. 보고 메시지에 함께 실려 와야 받아들인다 — 페이지 스크립트가 표식만 보고 위조하기 어렵게(클로저 안에만 있다).
 */
export function pickerScript(nonce: string): string {
  return PICKER_SCRIPT.replace("__NONCE__", JSON.stringify(nonce));
}

/**
 * 개발 모드 프레임워크가 요소에 달아 두는 디버그 정보로 소스 위치를 찾는 페이지 코드(sourceOf). 못 찾으면 null — 배포본은 원래 없다.
 * 주입 스크립트 안에 들어가고, 테스트는 이것만 떼어 가짜 요소로 돌린다.
 */
export const SOURCE_FN = `
const cleanFile = (f) => {
  f = String(f || "").replace(/^webpack-internal:\\/\\/\\/(\\([^)]*\\)\\/)?/, "").replace(/^webpack:\\/\\/[^/]*\\//, "").replace(/^https?:\\/\\/[^/]+/, "").replace(/[?#].*$/, "").replace(/^\\/@fs\\//, "/");
  try { f = decodeURIComponent(f); } catch {}
  return f.slice(0, 500);
};
const ups = (el, fn) => { for (let n = el, i = 0; n && n.nodeType === 1 && i < 8; n = n.parentElement, i++) { const r = fn(n); if (r) return r; } return null; };
const sourceOf = (el) => {
  const attr = ups(el, (n) => {
    const a = n.getAttribute("data-insp-path") || n.getAttribute("data-v-inspector");
    const m = a && /^(.*?):(\\d+)(?::(\\d+))?(?::.*)?$/.exec(a);
    return m ? { file: cleanFile(m[1]), line: +m[2], column: m[3] ? +m[3] : undefined, via: "attr" } : null;
  });
  if (attr) return attr;
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  if (key) {
    const nameOf = (f) => { const t = f && f.type; return t && typeof t !== "string" ? (t.displayName || t.name || undefined) : undefined; };
    for (let f = el[key], i = 0; f && i < 40; f = f.return, i++) {
      const s = f._debugSource;
      if (s && s.fileName) return { file: cleanFile(s.fileName), line: s.lineNumber, column: s.columnNumber, component: nameOf(f._debugOwner), via: "react" };
      // React 19: _debugSource 가 없어지고 JSX 를 부른 자리의 호출 스택만 남는다. 줄은 번들 기준이라 파일만 쓴다.
      // Next.js 경로엔 괄호가 들어간다(webpack-internal:///(app-pages-browser)/./src/…) — 공백만 아니면 받고 끝의 :줄:칸으로 자른다.
      const st = f._debugStack && f._debugStack.stack;
      if (st) for (const line of String(st).split("\\n").slice(1)) {
        const m = /((?:https?|webpack-internal|file):\\/\\/\\S+?):\\d+:\\d+\\)?\\s*$/.exec(line);
        if (!m) continue;
        const file = cleanFile(m[1]);
        if (/node_modules|\\/\\.vite\\/deps\\/|react-dom|jsx-dev-runtime|jsx-runtime|\\/_next\\/static\\/chunks\\//.test(file)) continue;
        return { file, component: nameOf(f._debugOwner), via: "react-stack" };
      }
    }
  }
  // Svelte 의 줄·칸은 0부터 센다.
  const sv = ups(el, (n) => { const loc = n.__svelte_meta && n.__svelte_meta.loc; return loc && loc.file ? { file: cleanFile(loc.file), line: (loc.line | 0) + 1, column: (loc.column | 0) + 1, via: "svelte" } : null; });
  if (sv) return sv;
  return ups(el, (n) => {
    const c = n.__vueParentComponent;
    const f = (c && c.type && c.type.__file) || (n.__vue__ && n.__vue__.$options && n.__vue__.$options.__file);
    return f ? { file: cleanFile(f), component: (c && c.type && (c.type.name || c.type.__name)) || undefined, via: "vue" } : null;
  });
};
`;

const PICKER_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(PICK_MARK)} + __NONCE__ + ":";
  const CANCEL = ${JSON.stringify(PICK_CANCEL_MARK)};
  const PROPS = ${JSON.stringify(ELEMENT_STYLE_PROPS)};
  const w = window;
  if (w.__sudalPick) { w.__sudalPick.stop(); if (w.__sudalPick.dispose) w.__sudalPick.dispose(); }
  const box = document.createElement("div");
  box.setAttribute("data-sudal-pick-box", "");
  Object.assign(box.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483647", border: "2px solid #6366f1", background: "rgba(99,102,241,0.12)", borderRadius: "3px", display: "none", boxSizing: "border-box" });
  const tip = document.createElement("div");
  Object.assign(tip.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483647", font: "11px/1.4 -apple-system, system-ui, sans-serif", background: "#18202a", color: "#fff", padding: "2px 6px", borderRadius: "4px", display: "none", maxWidth: "60vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
  // 선택 중엔 페이지 전체를 투명한 막으로 덮어 마우스를 막이 받는다. 브라우저는 비활성(disabled) 버튼에
  // mousedown·click 을 보내지 않아 요소에 직접 리스너를 걸면 그런 버튼을 못 고른다 — 막 아래 요소는 elementsFromPoint 로 찾는다.
  // 클릭도 막에 떨어지므로 링크가 열리거나 폼이 제출되지 않는다. 휠은 막을 지나 페이지가 스크롤된다.
  const shield = document.createElement("div");
  shield.setAttribute("data-sudal-pick-shield", "");
  Object.assign(shield.style, { position: "fixed", inset: "0", zIndex: "2147483646", background: "transparent", cursor: "crosshair", display: "none" });
  let active = false;
  let cur = null;
  const selectorOf = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      const cls = [...n.classList].filter((c) => /^[a-zA-Z_][\\w-]*$/.test(c) && c.length < 40).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter((c) => c.tagName === n.tagName); if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(n) + 1) + ")"; }
      parts.unshift(s);
      n = p;
    }
    return parts.join(" > ");
  };
  const isDefault = (k, v) => !v || v === "none" || v === "auto" || v === "normal" || v === "0px" || v === "rgba(0, 0, 0, 0)" || v === "transparent" || v === "visible" || v === "static" || (k === "opacity" && v === "1") || (k === "border" && /^0px/.test(v)) || (k === "flex-direction" && v === "row") || (k === "font-weight" && v === "400") || (k === "justify-content" && v === "normal") || (k === "align-items" && v === "normal");
  const tidy = (v) => v.replace(/(\\d+\\.\\d{2,})px/g, (m, n) => Math.round(Number(n) * 10) / 10 + "px");
  const info = (el) => {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of PROPS) { const v = cs.getPropertyValue(k); if (!isDefault(k, v)) styles[k] = tidy(v); }
    const r = el.getBoundingClientRect();
    let html = el.outerHTML || "";
    if (html.length > 2000) html = html.slice(0, 2000) + "…";
    let source = null;
    try { source = sourceOf(el); } catch {}
    return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), html, text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200), styles, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, dpr: w.devicePixelRatio || 1, source };
  };
${SOURCE_FN}
  const place = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    tip.textContent = selectorOf(el) + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    Object.assign(tip.style, { display: "block", left: Math.max(4, r.left) + "px", top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + "px" });
  };
  const under = (x, y) => document.elementsFromPoint(x, y).find((n) => n !== shield && n !== box && n !== tip) || null;
  const onMove = (e) => {
    const el = under(e.clientX, e.clientY);
    if (!el || el === document.documentElement) return;
    cur = el === document.body ? null : el;
    if (cur) place(cur);
  };
  // 골라 낸 뒤 이어서 오는 클릭 한 번은 페이지에 넘기지 않는다 — 링크가 열리거나 폼이 제출되면 안 된다.
  let swallowUntil = 0;
  const stop = () => {
    active = false;
    box.style.display = "none"; tip.style.display = "none"; shield.style.display = "none";
    document.removeEventListener("keydown", onKey, true);
  };
  const pick = (el) => {
    box.style.display = "none"; tip.style.display = "none";
    console.log(MARK + JSON.stringify(info(el)));
    swallowUntil = Date.now() + 1000;
    stop();
  };
  const targetOf = (e) => (e.target && e.target.nodeType === 1 && e.target !== box && e.target !== tip && e.target !== shield ? e.target : cur);
  // 고르는 건 막의 mousedown 에서 — 그 자리 밑의 요소를 고른다.
  const onDown = (e) => {
    if (!active || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = under(e.clientX, e.clientY) || cur;
    if (el && el !== document.documentElement && el !== document.body) pick(el);
  };
  shield.addEventListener("mousemove", onMove);
  shield.addEventListener("mousedown", onDown);
  // 프로그램으로 일으킨 click(마우스 없이 el.click())도 받고, 고른 직후의 진짜 click 은 삼킨다.
  const onClick = (e) => {
    if (active) {
      e.preventDefault(); e.stopPropagation();
      const el = targetOf(e);
      if (el) pick(el);
    } else if (Date.now() < swallowUntil) {
      e.preventDefault(); e.stopPropagation();
      swallowUntil = 0;
    }
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(); console.log(CANCEL); } };
  const start = () => {
    if (!box.isConnected) { document.documentElement.appendChild(shield); document.documentElement.appendChild(box); document.documentElement.appendChild(tip); }
    active = true;
    shield.style.display = "block";
    document.addEventListener("keydown", onKey, true);
  };
  // click 리스너는 꺼진 뒤에도 남는다 — 고른 직후의 클릭을 삼켜야 해서(swallowUntil 이 지나면 아무것도 안 한다).
  document.addEventListener("click", onClick, true);
  w.__sudalPick = { start, stop, dispose: () => { document.removeEventListener("click", onClick, true); shield.remove(); box.remove(); tip.remove(); } };
  start();
  return "started";
})()`;

/** 페이지 취소 스크립트(요소 선택 끄기). */
export const PICKER_STOP_SCRIPT = `(() => { if (window.__sudalPick) window.__sudalPick.stop(); return "stopped"; })()`;

/** console-message 한 줄 → 선택 결과 / 취소 / 무관. nonce 가 다르면 무관으로 본다(페이지의 위조·옛 세션). 값은 상한으로 자른다. */
export function parsePickMessage(message: string, nonce: string): { kind: "picked"; element: PickedElement } | { kind: "cancel" } | null {
  if (message === PICK_CANCEL_MARK) return { kind: "cancel" };
  const prefix = PICK_MARK + nonce + ":";
  if (!message.startsWith(prefix)) return null;
  try {
    const raw = JSON.parse(message.slice(prefix.length)) as Partial<PickedElement>;
    if (!raw || typeof raw.selector !== "string" || typeof raw.html !== "string" || !raw.rect || typeof raw.rect !== "object") return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(PICK_LIMITS.coord, Math.max(-PICK_LIMITS.coord, v)) : 0);
    const styles: Record<string, string> = {};
    if (raw.styles && typeof raw.styles === "object")
      for (const [k, v] of Object.entries(raw.styles).slice(0, 40)) if (typeof v === "string" && /^[a-z-]{1,40}$/.test(k)) styles[k] = v.slice(0, 200);
    return {
      kind: "picked",
      element: {
        selector: raw.selector.slice(0, PICK_LIMITS.selector),
        tag: typeof raw.tag === "string" ? raw.tag.slice(0, 40) : "",
        html: raw.html.length > PICK_LIMITS.html ? raw.html.slice(0, PICK_LIMITS.html) + "…" : raw.html,
        text: typeof raw.text === "string" ? raw.text.slice(0, PICK_LIMITS.text) : "",
        styles,
        rect: { x: num(raw.rect.x), y: num(raw.rect.y), width: Math.max(0, num(raw.rect.width)), height: Math.max(0, num(raw.rect.height)) },
        dpr: typeof raw.dpr === "number" && Number.isFinite(raw.dpr) && raw.dpr > 0 ? raw.dpr : 1,
        ...(parseSource(raw.source) ? { source: parseSource(raw.source) } : {}),
      },
    };
  } catch {
    return null;
  }
}

const SOURCE_VIA = new Set(["attr", "react", "react-stack", "svelte", "vue"]);
/** 페이지가 보낸 소스 위치를 믿을 만한 모양만 남긴다. */
function parseSource(v: unknown): ElementSource | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.file !== "string" || !o.file.trim() || o.file.includes("\0") || typeof o.via !== "string" || !SOURCE_VIA.has(o.via)) return undefined;
  const pos = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1_000_000 ? n : undefined);
  const line = pos(o.line);
  return {
    file: o.file.slice(0, 500),
    ...(line ? { line } : {}),
    ...(line && pos(o.column) ? { column: pos(o.column) } : {}),
    ...(typeof o.component === "string" && /^[\w$.]{1,80}$/.test(o.component) ? { component: o.component } : {}),
    via: o.via as ElementSource["via"],
  };
}

/** "src/a.tsx:42 (<Button>)" — 첨부와 알림에 쓰는 소스 위치 한 줄. file 은 저장소에서 다시 찾은 경로로 바꿔 넣을 수 있다. */
export function formatSource(src: ElementSource, file = src.file): string {
  return `${file}${src.line ? `:${src.line}` : ""}${src.component ? ` (<${src.component}>)` : ""}`;
}

/** 입력창에 붙일 텍스트: 어디의 무엇인지 + HTML 펜스 + 계산된 스타일 + 크기. 스크린샷은 이미지 첨부로 따로 간다. */
export function formatElementAttachment(t: TFunction, el: PickedElement, url: string, sourceFile?: string): string {
  const fence = el.html.includes("```") ? "````" : "```";
  const lines = [t("promptDoc.attach.element.head", { url })];
  // 소스 위치가 있으면 맨 앞 — 모델이 코드를 찾는 단계를 건너뛸 수 있다.
  if (el.source) lines.push(t("promptDoc.attach.element.source", { source: formatSource(el.source, sourceFile) }));
  lines.push(t("promptDoc.attach.element.selector", { selector: el.selector }));
  if (el.text) lines.push(t("promptDoc.attach.element.text", { text: el.text }));
  lines.push(`${fence}html`, el.html.trim(), fence);
  const styles = Object.entries(el.styles);
  if (styles.length) lines.push(t("promptDoc.attach.element.styles", { styles: styles.map(([k, v]) => `${k}: ${v}`).join("; ") }));
  lines.push(t("promptDoc.attach.element.size", { w: Math.round(el.rect.width), h: Math.round(el.rect.height), x: Math.round(el.rect.x), y: Math.round(el.rect.y) }));
  return lines.join("\n");
}

/** 스크린샷 조각 → 입력창 이미지. dataUrl 이 비어 있으면(캡처 실패) null. */
export function elementImage(dataUrl: string, el: PickedElement): ChatImageDto | null {
  return dataUrlImage(dataUrl, `element-${el.tag || "el"}.png`);
}

/** capturePage 의 data: URL 을 첨부 형식으로. 이미지가 아니면 null. */
export function dataUrlImage(dataUrl: string, name: string): ChatImageDto | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { name, mime: m[1] as ChatImageDto["mime"], base64: m[2] };
}
