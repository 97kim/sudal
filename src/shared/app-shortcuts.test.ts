import { test } from "node:test";
import assert from "node:assert/strict";
import { accelerator, shortcutVars } from "./app-shortcuts";
import { createI18n } from "./i18n";
import { ko } from "./i18n/ko";
import { en } from "./i18n/en";

test("메뉴 가속기: macOS 는 예전 그대로, Windows 는 셸 편집키를 피한다", () => {
  assert.equal(accelerator("newTab", true), "CmdOrCtrl+T");
  assert.equal(accelerator("closeTab", true), "CmdOrCtrl+W");
  assert.equal(accelerator("tabN", true, "+3"), "CmdOrCtrl+3");
  assert.equal(accelerator("nextTab", true), "Ctrl+Tab");
  assert.equal(accelerator("newTab", false), "CmdOrCtrl+Shift+T");
  assert.equal(accelerator("closeTab", false), "CmdOrCtrl+Shift+W");
  assert.equal(accelerator("browserReload", false), "F5");
  // Windows 에서 Ctrl+글자 하나(Shift·Alt 없이)를 가로채는 가속기는 없다 — 터미널의 셸 편집키다
  const plainCtrl = /^CmdOrCtrl\+[A-Z]$/;
  for (const name of ["newTab", "reopenTab", "closeTab", "switchWorkspace", "search", "sidebar", "terminal", "browserAddress", "browserReload", "termSplitRow", "termSplitCol"] as const)
    assert.doesNotMatch(accelerator(name, false), plainCtrl, name);
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
  assert.equal(win.t("nav.sidebar.expand"), "사이드바 펼치기 (Ctrl+Shift+B)");
  assert.equal(win.t("panel.changes.commitPlaceholder"), "커밋 메시지 (Ctrl+Enter 커밋)");
  assert.equal(win.t("nav.tabBar.tabTitle", { title: "a", workspace: "w", status: "s", index: 2 }), "a — w · s (Ctrl+2) · 더블클릭으로 이름 변경");
});
