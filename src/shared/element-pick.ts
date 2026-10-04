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

const PICKER_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(PICK_MARK)} + __NONCE__ + ":";
  const CANCEL = ${JSON.stringify(PICK_CANCEL_MARK)};
  const PROPS = ${JSON.stringify(ELEMENT_STYLE_PROPS)};
  const w = window;
  if (w.__sudalPick) { w.__sudalPick.stop(); }
  const box = document.createElement("div");
  box.setAttribute("data-sudal-pick-box", "");
  Object.assign(box.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483647", border: "2px solid #6366f1", background: "rgba(99,102,241,0.12)", borderRadius: "3px", display: "none", boxSizing: "border-box" });
  const tip = document.createElement("div");
  Object.assign(tip.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483647", font: "11px/1.4 -apple-system, system-ui, sans-serif", background: "#18202a", color: "#fff", padding: "2px 6px", borderRadius: "4px", display: "none", maxWidth: "60vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
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
    return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), html, text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200), styles, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, dpr: w.devicePixelRatio || 1 };
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    tip.textContent = selectorOf(el) + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    Object.assign(tip.style, { display: "block", left: Math.max(4, r.left) + "px", top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + "px" });
  };
  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip || el === document.documentElement) return;
    cur = el === document.body ? null : el;
    if (cur) place(cur);
  };
  const stop = () => {
    active = false;
    box.style.display = "none"; tip.style.display = "none";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onClick = (e) => {
    if (!active) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target && e.target.nodeType === 1 && e.target !== box && e.target !== tip ? e.target : cur;
    if (!el) return;
    box.style.display = "none"; tip.style.display = "none";
    console.log(MARK + JSON.stringify(info(el)));
    stop();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(); console.log(CANCEL); } };
  const start = () => {
    if (!box.isConnected) { document.documentElement.appendChild(box); document.documentElement.appendChild(tip); }
    active = true;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  };
  w.__sudalPick = { start, stop };
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
      },
    };
  } catch {
    return null;
  }
}

/** 입력창에 붙일 텍스트: 어디의 무엇인지 + HTML 펜스 + 계산된 스타일 + 크기. 스크린샷은 이미지 첨부로 따로 간다. */
export function formatElementAttachment(t: TFunction, el: PickedElement, url: string): string {
  const fence = el.html.includes("```") ? "````" : "```";
  const lines = [t("promptDoc.attach.element.head", { url }), t("promptDoc.attach.element.selector", { selector: el.selector })];
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
