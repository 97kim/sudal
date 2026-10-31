import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

function functionSource(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(fn, name);
  return fn.getText(source).replace(/^export\s+/, "");
}

// 실제 승인 창의 effect와 키 리스너를 실행한다. DOM 렌더링·도구 실행 없이 배경 승인의 차단 여부를 검증한다.
function harness(modalInitiallyOpen: boolean, paneFocused = true) {
  let modal = modalInitiallyOpen, focused = 0;
  const answers: string[] = [], effects: (() => void)[] = [];
  let onKey!: (event: { key: string; target: { tagName: string }; preventDefault(): void }) => void;
  const ctx = createContext({
    React: { createElement: () => null },
    useTranslation: () => ({ t: (key: string) => key, i18n: {} }),
    usePaneFocusRef: () => ({ current: paneFocused }),
    useRef: () => ({ current: { focus: () => { focused++; } } }),
    useEffect: (fn: () => void) => { effects.push(fn); },
    document: { querySelector: () => modal ? {} : null },
    window: { addEventListener: (_key: string, fn: typeof onKey) => { onKey = fn; }, removeEventListener() {} },
    Preview: () => null, QuestionPrompt: () => null,
  });
  const code = `${functionSource("./components/Modal.tsx", "hasModalDialog")}\n${functionSource("./components/PermissionPrompt.tsx", "PermissionPrompt")}`;
  runInContext(ts.transpileModule(code, { fileName: "modal.tsx", compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, ctx);
  ctx.PermissionPrompt({ request: { tool: "Bash", input: { command: "sensitive-action" }, canAlwaysAllow: false }, onAnswer: (answer: { behavior: string }) => answers.push(answer.behavior) });
  for (const effect of effects) effect();
  return {
    answers, focused: () => focused,
    setModal: (value: boolean) => { modal = value; },
    key: (key: string, tagName = "BUTTON") => onKey({ key, target: { tagName }, preventDefault() {} }),
  };
}

test("리뷰 등 모달이 열려 있으면 배경 승인 창의 Enter·Escape가 도구를 승인·거절하지 않는다", () => {
  const h = harness(false);
  assert.equal(h.focused(), 1);
  h.setModal(true);
  h.key("Enter"); h.key("Escape"); h.key("Enter", "SELECT");
  assert.deepEqual(h.answers, []);
  h.setModal(false);
  h.key("Enter"); h.key("Escape");
  assert.deepEqual(h.answers, ["allow", "deny"], "모달이 닫히면 기존 승인 단축키가 돌아온다");
});

test("모달이 열린 뒤 도착한 승인 요청은 배경 허용 버튼으로 포커스를 빼앗지 않는다", () => {
  const h = harness(true);
  assert.equal(h.focused(), 0);
  h.key("Enter");
  assert.deepEqual(h.answers, []);
});

test("포커스되지 않은 분할 칸의 승인 창은 기존처럼 키 입력을 받지 않는다", () => {
  const h = harness(false, false);
  assert.equal(h.focused(), 0);
  h.key("Enter"); h.key("Escape");
  assert.deepEqual(h.answers, []);
});
