// 에이전트가 인앱 브라우저를 조작하는 명령(sudal browser read/click/fill/scroll/press/wait 등)의 주입 스크립트.
// main 이 webContents.executeJavaScript 로 이걸 실행하고 결과를 JSON 으로 받는다.
//
// 스크립트는 문자열로 페이지에 들어가므로 값은 반드시 JSON.stringify 로 싣는다 — 따옴표·역슬래시·
// 줄바꿈이 든 선택자나 입력값이 코드를 깨뜨리지 않게. 결과는 항상 { ok } 또는 { error } 한 덩어리다.
// 오류 문구는 번역해서 스크립트에 싣는다(t). 페이지 안에서야 알 수 있는 값은 {{이름}} 자리를 두고 스크립트가 채운다.

import type { TFunction } from "i18next";
import { levelName, type ConsoleLine } from "./browser-diagnostics";

/** read 가 돌려줄 페이지 요약. 모델이 화면을 볼 수 없으므로 글과 눌 만한 것을 같이 준다. */
export interface PageRead {
  url: string;
  title: string;
  /** 보이는 본문 텍스트(잘림). */
  text: string;
  /** 잘렸나 — 모델이 더 볼 게 있는지 알 수 있게. */
  truncated: boolean;
  /** 누를 만한 것들: 버튼·링크·입력. 선택자와 함께 준다. */
  controls: { kind: "button" | "link" | "input"; label: string; selector: string }[];
}

export const READ_TEXT_MAX = 20000;
export const READ_CONTROLS_MAX = 60;

/** 페이지 안에서 쓸 공용 조각 — 요소의 짧은 CSS 선택자를 만든다. */
const SELECTOR_FN = `
function sel(el) {
  if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return "#" + el.id;
  const tn = el.tagName.toLowerCase();
  const name = el.getAttribute("name");
  if (name) return tn + '[name="' + name + '"]';
  const test = el.getAttribute("data-testid") || el.getAttribute("data-test");
  if (test) return tn + '[data-testid="' + test + '"]';
  const parent = el.parentElement;
  if (!parent) return tn;
  const same = [...parent.children].filter((c) => c.tagName === el.tagName);
  const idx = same.indexOf(el) + 1;
  const base = same.length > 1 ? tn + ":nth-of-type(" + idx + ")" : tn;
  const pid = parent.id && /^[A-Za-z][\\w-]*$/.test(parent.id) ? "#" + parent.id : null;
  return (pid ? pid + " > " : "") + base;
}
function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
}
function label(el) {
  const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
  return t.replace(/\\s+/g, " ").slice(0, 80);
}`;

/** 페이지를 읽는다. */
export function readScript(): string {
  return `(() => {${SELECTOR_FN}
  const raw = (document.body ? document.body.innerText : "") || "";
  const text = raw.replace(/\\n{3,}/g, "\\n\\n").trim();
  const out = [];
  const seen = new Set();
  const push = (kind, el) => {
    if (out.length >= ${READ_CONTROLS_MAX} || !visible(el)) return;
    const s = sel(el);
    const key = kind + "|" + s;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, label: label(el), selector: s });
  };
  for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) push("button", el);
  for (const el of document.querySelectorAll("a[href]")) push("link", el);
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "submit" || t === "button" || t === "hidden") continue;
    push("input", el);
  }
  return {
    ok: true,
    url: location.href,
    title: document.title || "",
    text: text.slice(0, ${READ_TEXT_MAX}),
    truncated: text.length > ${READ_TEXT_MAX},
    controls: out,
  };
})()`;
}

/**
 * 클릭. 선택자로 찾거나(selector), 보이는 글로 찾는다(text).
 * 글로 찾을 때는 보이는 것 중 글이 가장 짧은 것을 고른다 — 바깥 컨테이너가 아니라 실제 버튼이 잡히게.
 */
export function clickScript(t: TFunction, target: { selector?: string; text?: string }): string {
  const bySel = JSON.stringify(target.selector ?? "");
  const byText = JSON.stringify(target.text ?? "");
  const noElement = JSON.stringify(t("cli.browser.noElement", { selector: target.selector ?? "" }));
  const noText = JSON.stringify(t("cli.browser.noText", { text: target.text ?? "" }));
  const needTarget = JSON.stringify(t("cli.browser.needSelectorOrText"));
  const notVisible = JSON.stringify(t("cli.browser.notVisible", { selector: "{{selector}}" }));
  return `(() => {${SELECTOR_FN}
  const wantSel = ${bySel}, wantText = ${byText};
  let el = null;
  if (wantSel) {
    el = document.querySelector(wantSel);
    if (!el) return { error: ${noElement} };
  } else if (wantText) {
    const needle = wantText.toLowerCase();
    const cands = [...document.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"], label')]
      .filter((e) => visible(e) && label(e).toLowerCase().includes(needle));
    if (cands.length === 0) return { error: ${noText} };
    cands.sort((a, b) => label(a).length - label(b).length);
    el = cands[0];
  } else {
    return { error: ${needTarget} };
  }
  if (!visible(el)) return { error: ${notVisible}.replace("{{selector}}", () => sel(el)) };
  el.scrollIntoView({ block: "center" });
  // 누른 자리 — 화면이 "여기를 눌렀다" 를 잠깐 표시한다.
  const b = el.getBoundingClientRect();
  el.click();
  return { ok: true, clicked: { selector: sel(el), label: label(el), tag: el.tagName.toLowerCase(), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } };
})()`;
}

/** 입력값 채우기. React 처럼 값 변경을 가로채는 프레임워크도 알아채도록 네이티브 setter 로 넣고 이벤트를 쏜다. */
export function fillScript(t: TFunction, selector: string, value: string): string {
  const noElement = JSON.stringify(t("cli.browser.noElement", { selector }));
  const notFillable = JSON.stringify(t("cli.browser.notFillable", { tag: "{{tag}}" }));
  return `(() => {${SELECTOR_FN}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: ${noElement} };
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select" && el.isContentEditable !== true)
    return { error: ${notFillable}.replace("{{tag}}", () => tag) };
  const v = ${JSON.stringify(value)};
  el.focus();
  if (el.isContentEditable) {
    el.textContent = v;
  } else {
    // React intercepts value, so call the prototype setter directly — otherwise only the screen changes and the state stays.
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : tag === "select" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, filled: { selector: sel(el), tag, value: v.slice(0, 200) } };
})()`;
}

/** screenshot --selector 가 자를 영역(보이는 영역 기준 CSS px). */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 다음 그림이 그려질 때까지 — 스크롤 직후 재거나 찍으면 옛 화면이 잡힌다.
 * 패널이 가려져 있으면 requestAnimationFrame 이 돌지 않아 영영 안 끝나므로 setTimeout 으로도 끝낸다.
 */
const NEXT_PAINT = `await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 150); });`;

/** 잘못된 CSS 선택자는 querySelector 가 던진다 — 던지면 "페이지 이동 중" 과 구분이 안 되므로 결과로 바꾼다. */
const QUERY_FN = `
function query(s) {
  try { return { el: document.querySelector(s) }; } catch (e) { return { bad: true }; }
}`;

/**
 * screenshot --selector 용. 요소를 보이게 한 뒤 보이는 영역 안의 사각형(CSS px)을 돌려준다.
 * 보이는 영역 밖은 capturePage 가 찍지 못하므로 잘라서 주고, 잘렸는지 알린다.
 */
export function rectScript(t: TFunction, selector: string): string {
  const noElement = JSON.stringify(t("cli.browser.noElement", { selector }));
  const badSelector = JSON.stringify(t("cli.browser.badSelector", { selector }));
  const notVisible = JSON.stringify(t("cli.browser.notVisible", { selector: "{{selector}}" }));
  return `(async () => {${SELECTOR_FN}${QUERY_FN}
  const q = query(${JSON.stringify(selector)});
  if (q.bad) return { error: ${badSelector} };
  const el = q.el;
  if (!el) return { error: ${noElement} };
  if (!visible(el)) return { error: ${notVisible}.replace("{{selector}}", () => sel(el)) };
  const vw = window.innerWidth, vh = window.innerHeight;
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
    el.scrollIntoView({ block: r.height > vh ? "start" : "center", inline: "nearest", behavior: "instant" });
    ${NEXT_PAINT}
    r = el.getBoundingClientRect();
  }
  const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
  const width = Math.min(vw, Math.ceil(r.right)) - x, height = Math.min(vh, Math.ceil(r.bottom)) - y;
  if (width < 1 || height < 1) return { error: ${notVisible}.replace("{{selector}}", () => sel(el)) };
  return { ok: true, selector: sel(el), rect: { x, y, width, height }, clipped: x > r.left + 1 || y > r.top + 1 || width + 1 < r.width || height + 1 < r.height };
})()`;
}

export type ScrollTarget = { selector: string } | { by: number } | { to: "top" | "bottom" };

/** 스크롤. --by·--to 는 문서 전체(scrollingElement) 기준이다 — 안쪽 스크롤 상자는 --selector 로 그 안의 요소를 보이게 한다. */
export function scrollScript(t: TFunction, target: ScrollTarget): string {
  const selector = "selector" in target ? target.selector : "";
  const noElement = JSON.stringify(t("cli.browser.noElement", { selector }));
  const badSelector = JSON.stringify(t("cli.browser.badSelector", { selector }));
  // behavior: "instant" — 페이지가 scroll-behavior: smooth 면 결과를 잴 때 아직 움직이는 중이다
  const move =
    "selector" in target
      ? `const q = query(${JSON.stringify(selector)});
  if (q.bad) return { error: ${badSelector} };
  if (!q.el) return { error: ${noElement} };
  q.el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });`
      : "by" in target
        ? `se.scrollBy({ top: ${JSON.stringify(target.by)}, behavior: "instant" });`
        : `se.scrollTo({ top: ${target.to === "top" ? "0" : "se.scrollHeight"}, behavior: "instant" });`;
  return `(async () => {${QUERY_FN}
  const se = document.scrollingElement || document.documentElement;
  ${move}
  ${NEXT_PAINT}
  const max = Math.max(0, se.scrollHeight - window.innerHeight);
  return { ok: true, scroll: { y: Math.round(se.scrollTop), max: Math.round(max), atTop: se.scrollTop <= 0, atBottom: se.scrollTop >= max - 1 } };
})()`;
}

/** press --selector 용. 키 이벤트는 포커스된 요소로 가므로 먼저 포커스를 옮긴다. */
export function focusScript(t: TFunction, selector: string): string {
  const noElement = JSON.stringify(t("cli.browser.noElement", { selector }));
  const badSelector = JSON.stringify(t("cli.browser.badSelector", { selector }));
  const notFocusable = JSON.stringify(t("cli.browser.notFocusable", { selector }));
  return `(() => {${SELECTOR_FN}${QUERY_FN}
  const q = query(${JSON.stringify(selector)});
  if (q.bad) return { error: ${badSelector} };
  const el = q.el;
  if (!el) return { error: ${noElement} };
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  el.focus();
  if (document.activeElement !== el) return { error: ${notFocusable} };
  return { ok: true, focused: { selector: sel(el), tag: el.tagName.toLowerCase() } };
})()`;
}

/**
 * wait 의 한 번 들여다보기. 반복은 main 이 한다 — 페이지가 바뀌면 스크립트째 사라지므로 페이지 안에서 돌 수 없다.
 * 못 찾은 것은 오류가 아니라 found:false 다. 선택자가 틀렸으면 기다려도 소용없으니 bad 로 알린다.
 */
export function waitProbeScript(target: { selector?: string; text?: string }): string {
  return `(() => {${SELECTOR_FN}${QUERY_FN}
  const wantSel = ${JSON.stringify(target.selector ?? "")}, wantText = ${JSON.stringify(target.text ?? "")};
  if (wantSel) {
    const q = query(wantSel);
    if (q.bad) return { ok: true, found: false, bad: true };
    if (!q.el || !visible(q.el)) return { ok: true, found: false };
    return { ok: true, found: true, selector: sel(q.el), label: label(q.el) };
  }
  const body = document.body ? document.body.innerText || "" : "";
  return { ok: true, found: wantText !== "" && body.toLowerCase().includes(wantText.toLowerCase()) };
})()`;
}

/** sendInputEvent 에 넣을 키 이벤트 하나. electron 타입을 끌어오지 않으려고 모양만 맞춘다. */
export interface KeyInput {
  type: "keyDown" | "char" | "keyUp";
  keyCode: string;
  modifiers?: ("shift" | "control" | "alt" | "meta")[];
}

/** DOM 의 key 이름(에이전트가 아는 쪽) → Electron 가속기 키 이름. */
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", backspace: "Backspace", delete: "Delete",
  space: "Space", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};
const MODIFIERS: Record<string, "shift" | "control" | "alt" | "meta"> = {
  shift: "shift", control: "control", ctrl: "control", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta",
};
/** char 도 보내야 기본 동작(폼 제출·공백 입력)이 일어나는 키. Tab·화살표·Escape 는 keyDown 에서 처리된다. */
const CHAR_OF: Record<string, string> = { Enter: "\r", Space: " " };
/** Shift 를 누른 채 친 글자. char 이벤트는 받은 글자를 그대로 넣으므로 윗글자를 직접 줘야 한다(미국 자판 기준). */
const SHIFTED: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<", ".": ">", "/": "?", "`": "~",
};

/**
 * "Enter", "ArrowDown", "Shift+Tab", "Control+a", "a" → keyDown·(char)·keyUp. 모르는 키면 null.
 * Shift 외 수정키가 있으면 char 를 보내지 않는다 — Control+a 에서 "a" 가 입력되면 안 된다.
 */
export function keyInputEvents(key: string): KeyInput[] | null {
  const parts = key === "+" ? ["+"] : key.split("+");
  if (parts.some((p) => p === "")) return null;
  const last = parts[parts.length - 1];
  const modifiers: ("shift" | "control" | "alt" | "meta")[] = [];
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m || modifiers.includes(m)) return null;
    modifiers.push(m);
  }
  const named = NAMED_KEYS[last.toLowerCase()] ?? (/^F([1-9]|1[0-2])$/i.test(last) ? last.toUpperCase() : undefined);
  const single = [...last].length === 1 ? last : undefined;
  const keyCode = named ?? single;
  if (!keyCode) return null;
  const mods = modifiers.length ? { modifiers } : {};
  const shift = modifiers.includes("shift");
  const ch = named ? CHAR_OF[named] : single && shift ? (SHIFTED[single] ?? single.toUpperCase()) : single;
  const sendChar = ch !== undefined && modifiers.every((m) => m === "shift");
  return [
    { type: "keyDown", keyCode, ...mods },
    ...(sendChar ? [{ type: "char" as const, keyCode: ch, ...mods }] : []),
    { type: "keyUp", keyCode, ...mods },
  ];
}

/** console 명령의 한 줄. 등급은 진단 첨부와 같은 이름으로. */
export interface ConsoleOut {
  ts: number;
  level: string;
  text: string;
  source?: string;
  line?: number;
}

/** 모아 둔 콘솔에서 등급(warn = 경고 이상, error = 오류만)으로 거르고 최근 limit 줄만. */
export function pickConsole(lines: ConsoleLine[], opts: { level?: "warn" | "error"; limit?: number } = {}): ConsoleOut[] {
  const min = opts.level === "error" ? 3 : opts.level === "warn" ? 2 : 0;
  const kept = lines.filter((l) => l.level >= min);
  const tail = opts.limit !== undefined ? kept.slice(Math.max(0, kept.length - opts.limit)) : kept;
  return tail.map((l) => ({
    ts: l.ts,
    level: levelName(l.level),
    text: l.text,
    ...(l.source ? { source: l.source } : {}),
    ...(l.line ? { line: l.line } : {}),
  }));
}
