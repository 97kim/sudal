import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createI18n } from "./i18n";
import { clickScript, fillScript, focusScript, keyInputEvents, pickConsole, readScript, rectScript, scrollScript, waitProbeScript } from "./browser-control";

const { t } = createI18n("ko");

// 주입 스크립트는 문자열로 페이지에 들어간다 — 문법이 깨지면 조용히 실패한다.
// 여기서는 "파싱은 되는가" 와 "값이 코드로 새지 않는가" 를 본다.
const parses = (code: string) => {
  new vm.Script(code); // 문법 오류면 던진다
  return true;
};

test("세 스크립트 모두 문법이 맞다", () => {
  assert.ok(parses(readScript()));
  assert.ok(parses(clickScript(t, { selector: "#go" })));
  assert.ok(parses(clickScript(t, { text: "저장" })));
  assert.ok(parses(fillScript(t, "#name", "홍길동")));
});

test("따옴표·역슬래시·줄바꿈이 든 값이 코드를 깨뜨리지 않는다", () => {
  const nasty = `"); alert('xss'); //`;
  assert.ok(parses(clickScript(t, { selector: nasty })));
  assert.ok(parses(clickScript(t, { text: nasty })));
  assert.ok(parses(fillScript(t, nasty, nasty)));
  assert.ok(parses(fillScript(t, "#a", "줄1\n줄2\\끝\t")));
  // 값은 JSON 문자열로만 실려야 한다 — 코드 자리에 그대로 박히면 안 된다.
  assert.ok(fillScript(t, "#a", nasty).includes(JSON.stringify(nasty)));
  assert.ok(!fillScript(t, "#a", nasty).includes(`alert('xss'); //\n`));
});

test("</script> 가 든 값도 문자열로만 실린다", () => {
  const s = fillScript(t, "#a", "</script><img onerror=1>");
  assert.ok(parses(s));
  assert.ok(s.includes(JSON.stringify("</script><img onerror=1>")));
});

test("click 은 선택자도 글도 없으면 스스로 거절한다", () => {
  const code = clickScript(t, {});
  assert.ok(parses(code));
  // 페이지에서 실행되기 전에 문자열로도 확인할 수 있게 메시지를 담고 있다.
  assert.match(code, /--selector 나 --text/);
});

test("read 는 상한을 코드에 담는다", () => {
  const code = readScript();
  assert.match(code, /slice\(0, 20000\)/);
  assert.match(code, /out\.length >= 60/);
});

test("fill 은 네이티브 setter 를 쓴다 — React 상태가 갱신되게", () => {
  const code = fillScript(t, "#a", "v");
  assert.match(code, /getOwnPropertyDescriptor/);
  assert.match(code, /dispatchEvent\(new Event\("input"/);
  assert.match(code, /dispatchEvent\(new Event\("change"/);
});

test("screenshot·scroll·press·wait 스크립트도 문법이 맞고 값은 JSON 으로만 실린다", () => {
  const nasty = `"); alert('xss'); //`;
  for (const code of [
    rectScript(t, "#card"),
    rectScript(t, nasty),
    scrollScript(t, { selector: nasty }),
    scrollScript(t, { by: -300 }),
    scrollScript(t, { to: "top" }),
    scrollScript(t, { to: "bottom" }),
    focusScript(t, nasty),
    waitProbeScript({ selector: nasty }),
    waitProbeScript({ text: nasty }),
  ])
    assert.ok(parses(code));
  assert.ok(rectScript(t, nasty).includes(JSON.stringify(nasty)));
  assert.ok(waitProbeScript({ text: nasty }).includes(JSON.stringify(nasty)));
});

test("스크롤은 instant 로 — 페이지의 smooth 스크롤에 결과가 밀리지 않게", () => {
  assert.match(scrollScript(t, { by: 200 }), /scrollBy\(\{ top: 200, behavior: "instant" \}\)/);
  assert.match(scrollScript(t, { to: "bottom" }), /top: se\.scrollHeight/);
});

/** 들여다보기 스크립트를 가짜 페이지에서 돌린다. */
function probe(code: string, page: { text?: string; query?: (s: string) => unknown }) {
  const ctx = {
    document: { body: { innerText: page.text ?? "" }, querySelector: page.query ?? (() => null) },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  return vm.runInNewContext(code, ctx) as { ok: boolean; found: boolean; bad?: boolean };
}

test("wait 들여다보기: 글은 대소문자 없이 찾고, 틀린 선택자는 bad 로 알린다", () => {
  assert.equal(probe(waitProbeScript({ text: "saved" }), { text: "All Saved!" }).found, true);
  assert.equal(probe(waitProbeScript({ text: "저장됨" }), { text: "불러오는 중" }).found, false);
  assert.equal(probe(waitProbeScript({ selector: ".r" }), {}).found, false);
  const bad = probe(waitProbeScript({ selector: "##" }), {
    query: () => {
      throw new Error("SyntaxError");
    },
  });
  assert.equal(bad.found, false);
  assert.equal(bad.bad, true);
});

test("키 이름 → keyDown·char·keyUp", () => {
  assert.deepEqual(keyInputEvents("Enter"), [
    { type: "keyDown", keyCode: "Enter" },
    { type: "char", keyCode: "\r" },
    { type: "keyUp", keyCode: "Enter" },
  ]);
  // 화살표·Escape·Tab 은 char 없이 — 글자가 들어가면 안 된다
  assert.deepEqual(keyInputEvents("ArrowDown"), [{ type: "keyDown", keyCode: "Down" }, { type: "keyUp", keyCode: "Down" }]);
  assert.deepEqual(keyInputEvents("escape")?.map((e) => e.type), ["keyDown", "keyUp"]);
  assert.deepEqual(keyInputEvents("Shift+Tab"), [
    { type: "keyDown", keyCode: "Tab", modifiers: ["shift"] },
    { type: "keyUp", keyCode: "Tab", modifiers: ["shift"] },
  ]);
  assert.deepEqual(keyInputEvents("a")?.map((e) => e.type), ["keyDown", "char", "keyUp"]);
  assert.deepEqual(keyInputEvents("Control+a")?.map((e) => e.type), ["keyDown", "keyUp"]);
  assert.deepEqual(keyInputEvents("Shift+A")?.map((e) => e.type), ["keyDown", "char", "keyUp"]);
  assert.equal(keyInputEvents("f5")?.[0].keyCode, "F5");
  assert.equal(keyInputEvents("+")?.[0].keyCode, "+");
  for (const bad of ["", "Enterr", "Hyper+a", "Shift+", "Shift+Shift+a", "Enter "]) assert.equal(keyInputEvents(bad), null, bad);
});

test("콘솔 고르기: 등급·개수·이름", () => {
  const lines = [
    { ts: 1, level: 1, text: "info" },
    { ts: 2, level: 2, text: "warn", source: "a.js", line: 3 },
    { ts: 3, level: 3, text: "err1" },
    { ts: 4, level: 3, text: "err2" },
  ];
  assert.equal(pickConsole(lines).length, 4);
  assert.deepEqual(pickConsole(lines, { level: "warn" }).map((l) => l.level), ["warn", "error", "error"]);
  assert.deepEqual(pickConsole(lines, { level: "error", limit: 1 }), [{ ts: 4, level: "error", text: "err2" }]);
  assert.deepEqual(pickConsole(lines, { level: "warn" })[0], { ts: 2, level: "warn", text: "warn", source: "a.js", line: 3 });
});
