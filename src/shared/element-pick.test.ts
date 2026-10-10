import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "./i18n";
import { PICKER_STOP_SCRIPT, PICK_CANCEL_MARK, PICK_MARK, SOURCE_FN, elementImage, formatElementAttachment, formatSource, parsePickMessage, pickerScript } from "./element-pick";
const PICKER_SCRIPT = pickerScript("n1");

test("PICKER_SCRIPT 는 문법상 올바른 JS 다", () => {
  assert.doesNotThrow(() => new Function(PICKER_SCRIPT));
  assert.doesNotThrow(() => new Function(PICKER_STOP_SCRIPT));
  assert.ok(PICKER_SCRIPT.includes(PICK_MARK));
  assert.ok(PICKER_SCRIPT.includes('"n1"'));
  assert.ok(!PICKER_SCRIPT.includes("__NONCE__"));
});

test("parsePickMessage: 마커·취소·무관", () => {
  const el = { selector: "main > h1", tag: "h1", html: "<h1>v2</h1>", text: "v2", styles: { "font-size": "32px" }, rect: { x: 8, y: 21.4, width: 100, height: 37 }, dpr: 2 };
  assert.deepEqual(parsePickMessage(PICK_MARK + "n1:" + JSON.stringify(el), "n1"), { kind: "picked", element: el });
  assert.equal(parsePickMessage(PICK_MARK + "other:" + JSON.stringify(el), "n1"), null, "nonce 가 다르면 무관");
  assert.equal(parsePickMessage(PICK_MARK + JSON.stringify(el), "n1"), null, "nonce 없는 옛 형식도 무관");
  assert.deepEqual(parsePickMessage(PICK_CANCEL_MARK, "n1"), { kind: "cancel" });
  assert.equal(parsePickMessage("hello", "n1"), null);
  assert.equal(parsePickMessage(PICK_MARK + "n1:{broken", "n1"), null);
  assert.equal(parsePickMessage(PICK_MARK + "n1:" + JSON.stringify({ selector: "x" }), "n1"), null);
  // 상한: 긴 html 은 잘리고, 무한대 좌표는 상한으로, 이상한 스타일 키는 버린다
  const big = parsePickMessage(PICK_MARK + "n1:" + JSON.stringify({ ...el, html: "x".repeat(10_000), rect: { x: Infinity, y: -1e9, width: 1e9, height: NaN }, styles: { "font-size": "1px", "<bad>": "y", ok: 5 } }), "n1");
  assert.equal(big?.kind, "picked");
  if (big?.kind !== "picked") return;
  assert.equal(big.element.html.length, 4001);
  assert.deepEqual(big.element.rect, { x: 0, y: -20000, width: 20000, height: 0 });
  assert.deepEqual(big.element.styles, { "font-size": "1px" });
});

test("formatElementAttachment / elementImage", () => {
  const el = { selector: "main > h1", tag: "h1", html: "<h1>v2</h1>", text: "v2", styles: { "font-size": "32px", color: "rgb(0, 0, 0)" }, rect: { x: 8, y: 21.4, width: 100.2, height: 37 }, dpr: 2 };
  assert.equal(
    formatElementAttachment(createI18n("ko").t, el, "http://127.0.0.1:5000/p/x/index.html"),
    "브라우저 요소 · http://127.0.0.1:5000/p/x/index.html\n선택자: main > h1\n텍스트: v2\n```html\n<h1>v2</h1>\n```\n계산된 스타일: font-size: 32px; color: rgb(0, 0, 0)\n크기: 100×37 @ (8, 21)",
  );
  assert.deepEqual(elementImage("data:image/png;base64,AAAA", el), { name: "element-h1.png", mime: "image/png", base64: "AAAA" });
  assert.equal(elementImage("", el), null);
});

test("주입 스크립트의 tidy: 소수 둘째 자리 이상 px 는 한 자리로 반올림", () => {
  const start = PICKER_SCRIPT.indexOf("const tidy");
  const stmt = PICKER_SCRIPT.slice(start, PICKER_SCRIPT.indexOf(";", start) + 1);
  const fn = new Function(stmt + " return tidy('63.9141px 8px 1.5px');") as () => string;
  assert.equal(fn(), "63.9px 8px 1.5px");
});

// 페이지 코드 sourceOf 를 떼어 가짜 요소로 돌린다. 요소는 nodeType·getAttribute·parentElement 만 흉내 낸다.
const sourceOf = new Function(`${SOURCE_FN}; return sourceOf;`)() as (el: unknown) => unknown;
const fakeEl = (extra: Record<string, unknown> = {}, attrs: Record<string, string> = {}, parent: unknown = null) => ({
  nodeType: 1,
  parentElement: parent,
  getAttribute: (k: string) => attrs[k] ?? null,
  ...extra,
});

test("sourceOf: React 18 은 _debugSource 의 파일·줄과 JSX 를 쓴 컴포넌트", () => {
  function DetailButton() {}
  const fiber = { type: "button", _debugSource: { fileName: "/repo/src/pages/Dashboard.tsx", lineNumber: 42, columnNumber: 7 }, _debugOwner: { type: DetailButton } };
  assert.deepEqual(sourceOf(fakeEl({ "__reactFiber$abc": fiber })), { file: "/repo/src/pages/Dashboard.tsx", line: 42, column: 7, component: "DetailButton", via: "react" });
});

test("sourceOf: React 19 는 호출 스택에서 런타임을 건너뛴 첫 앱 파일만(줄은 믿지 않는다)", () => {
  const stack = ["Error: react-stack-top-frame", "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)", "    at Dashboard (http://localhost:5173/src/pages/Dashboard.tsx?t=171:58:9)"].join("\n");
  const fiber = { type: "div", _debugStack: { stack }, _debugOwner: { type: { displayName: "Dashboard" } } };
  assert.deepEqual(sourceOf(fakeEl({ "__reactFiber$x": fiber })), { file: "/src/pages/Dashboard.tsx", component: "Dashboard", via: "react-stack" });
});

test("sourceOf: 빌드 플러그인 속성은 조상에서도 찾는다", () => {
  const parent = fakeEl({}, { "data-insp-path": "src/App.vue:12:5:div" });
  assert.deepEqual(sourceOf(fakeEl({}, {}, parent)), { file: "src/App.vue", line: 12, column: 5, via: "attr" });
});

test("sourceOf: Svelte 는 0부터 센 줄을 1부터로, Vue 는 파일만", () => {
  assert.deepEqual(sourceOf(fakeEl({ __svelte_meta: { loc: { file: "src/routes/+page.svelte", line: 9, column: 2 } } })), { file: "src/routes/+page.svelte", line: 10, column: 3, via: "svelte" });
  assert.deepEqual(sourceOf(fakeEl({ __vueParentComponent: { type: { __file: "/repo/src/components/Card.vue", __name: "Card" } } })), { file: "/repo/src/components/Card.vue", component: "Card", via: "vue" });
});

test("sourceOf: 디버그 정보가 없으면 null", () => {
  assert.equal(sourceOf(fakeEl()), null);
});

test("parsePickMessage: 소스 위치는 모양이 맞는 것만 남긴다", () => {
  const base = { selector: "a", tag: "a", html: "<a>", text: "", styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, dpr: 1 };
  const parse = (source: unknown) => {
    const r = parsePickMessage(`${PICK_MARK}n:${JSON.stringify({ ...base, source })}`, "n");
    return r && r.kind === "picked" ? r.element.source : "bad";
  };
  assert.deepEqual(parse({ file: "src/a.tsx", line: 3, column: 2, component: "Btn", via: "react" }), { file: "src/a.tsx", line: 3, column: 2, component: "Btn", via: "react" });
  assert.equal(parse({ file: "src/a.tsx", via: "evil" }), undefined);
  assert.deepEqual(parse({ file: "src/a.tsx", line: -1, component: "<img onerror>", via: "vue" }), { file: "src/a.tsx", via: "vue" });
  assert.equal(parse(null), undefined);
});

test("formatSource / formatElementAttachment: 소스 위치를 맨 앞에", () => {
  const src = { file: "/repo/src/a.tsx", line: 42, component: "Btn", via: "react" as const };
  assert.equal(formatSource(src, "src/a.tsx"), "src/a.tsx:42 (<Btn>)");
  const el = { selector: "a", tag: "a", html: "<a>x</a>", text: "x", styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, dpr: 1, source: src };
  const t = ((k: string, o?: Record<string, unknown>) => `${k}|${JSON.stringify(o ?? {})}`) as unknown as Parameters<typeof formatElementAttachment>[0];
  const lines = formatElementAttachment(t, el, "http://localhost:3000/", "src/a.tsx").split("\n");
  assert.match(lines[1], /^promptDoc\.attach\.element\.source\|.*src\/a\.tsx:42 \(<Btn>\)/);
});

test("sourceOf: Next.js 는 경로 안 괄호(webpack-internal:///(app-pages-browser)/…)를 지나 파일을 찾는다", () => {
  const stack = ["Error: react-stack-top-frame", "    at jsxDEV (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js:345:12)", "    at Page (webpack-internal:///(app-pages-browser)/./src/app/page.tsx:12:4)"].join("\n");
  const fiber = { type: "main", _debugStack: { stack }, _debugOwner: { type: { name: "Page" } } };
  assert.deepEqual(sourceOf(fakeEl({ "__reactFiber$n": fiber })), { file: "./src/app/page.tsx", component: "Page", via: "react-stack" });
});
