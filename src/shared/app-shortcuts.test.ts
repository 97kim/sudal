import { test } from "node:test";
import assert from "node:assert/strict";
import { accelerator, passesToAppMenu, shortcutVars, yieldsToTerminal } from "./app-shortcuts";
import { createI18n } from "./i18n";
import { ko } from "./i18n/ko";
import { en } from "./i18n/en";

test("메뉴 가속기: Windows 는 macOS 의 ⌘ 자리에 Ctrl 을 쓴다", () => {
  assert.equal(accelerator("newTab", true), "CmdOrCtrl+T");
  assert.equal(accelerator("closeTab", true), "CmdOrCtrl+W");
  assert.equal(accelerator("tabN", true, "+3"), "CmdOrCtrl+3");
  assert.equal(accelerator("nextTab", true), "Ctrl+Tab");
  for (const name of ["newTab", "reopenTab", "closeTab", "switchWorkspace", "search", "sidebar", "terminal", "browserAddress", "browserReload"] as const)
    assert.equal(accelerator(name, false), accelerator(name, true), name);
  // Ctrl+D 는 셸의 EOF 라 터미널 분할만은 Shift 를 더한다
  assert.equal(accelerator("termSplitRow", false), "CmdOrCtrl+Shift+D");
});

test("터미널 포커스 중에는 셸 편집키를 셸에 양보한다", () => {
  const key = (code: string, m: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) =>
    yieldsToTerminal({ control: true, shift: false, alt: false, meta: false, code, ...m });
  for (const c of ["KeyR", "KeyL", "KeyB", "KeyT"]) assert.equal(key(c), true, c);
  // Ctrl+W·K 는 macOS 의 ⌘W·⌘K 처럼 터미널을 닫고 지운다
  assert.equal(key("KeyW"), false);
  assert.equal(key("KeyK"), false);
  // 앱에 두는 것: 찾기·터미널 패널·탭 번호
  for (const c of ["KeyF", "KeyJ", "Digit1"]) assert.equal(key(c), false, c);
  // Shift·Alt 가 붙으면 앱 단축키(새 탭 다시 열기 등)
  assert.equal(key("KeyT", { shift: true }), false);
  assert.equal(key("KeyW", { alt: true }), false);
  assert.equal(key("KeyW", { control: false }), false);
});

test("Windows 터미널은 셸에 양보하지 않는 앱 단축키를 메뉴로 넘긴다", () => {
  const key = (code: string, m: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    passesToAppMenu({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code, ...m });
  // Ctrl+J 를 xterm 이 셸로 보내면 줄바꿈이라 입력하던 명령이 실행된다
  for (const c of ["KeyJ", "KeyF", "KeyW", "KeyK", "Digit1", "Digit9", "Comma", "Tab"]) assert.equal(key(c), true, c);
  assert.equal(key("KeyT", { shiftKey: true }), true, "탭 다시 열기");
  assert.equal(key("ArrowDown", { shiftKey: true }), true, "다음 응답 필요 세션");
  // 셸 편집키·셸 신호는 셸로
  for (const c of ["KeyR", "KeyC", "KeyD", "KeyA", "Digit0"]) assert.equal(key(c), false, c);
  // 터미널 안에서 따로 처리하는 분할·첨부
  assert.equal(key("KeyD", { shiftKey: true }), false);
  assert.equal(key("KeyA", { shiftKey: true }), false);
  assert.equal(key("KeyJ", { ctrlKey: false }), false);
});

/** 사전을 "a.b.c" → 값 으로 편다. */
function flatten(obj: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v as object, key)) out.set(kk, vv);
  }
  return out;
}

test("문구에 쓴 단축키 변수는 모두 채워진다", () => {
  const vars = shortcutVars(true);
  for (const dict of [ko, en])
    for (const [key, value] of flatten(dict))
      for (const m of value.matchAll(/\{\{\s*(k[A-Z]\w*)/g)) assert.ok(m[1] in vars, `${key}: 모르는 변수 ${m[1]}`);
});

test("macOS 표기는 예전 문구 그대로, Windows 는 Ctrl 표기", () => {
  const mac = createI18n("ko");
  mac.options.interpolation!.defaultVariables = shortcutVars(true);
  assert.equal(mac.t("nav.sidebar.expand"), "사이드바 펼치기 (⌘B)");
  assert.equal(mac.t("nav.sidebar.attentionJumpTitle"), "응답이 필요한 세션(권한 대기·확인 안 한 완료)으로 이동 (⌘⇧↓, 이전은 ⌘⇧↑)");
  assert.equal(mac.t("panel.changes.commitPlaceholder"), "커밋 메시지 (⌘⏎ 커밋)");
  assert.equal(mac.t("chat.composer.sendKeys"), "⏎ 전송 · ⇧⏎ 줄바꿈");
  const win = createI18n("ko");
  win.options.interpolation!.defaultVariables = shortcutVars(false);
  assert.equal(win.t("nav.sidebar.expand"), "사이드바 펼치기 (Ctrl+B)");
  assert.equal(win.t("panel.changes.commitPlaceholder"), "커밋 메시지 (Ctrl+Enter 커밋)");
  assert.equal(win.t("nav.tabBar.tabTitle", { title: "a", workspace: "w", status: "s", index: 2 }), "a — w · s (Ctrl+2) · 더블클릭으로 이름 변경");
});
