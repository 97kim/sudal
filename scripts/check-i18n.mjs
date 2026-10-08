#!/usr/bin/env node
// 코드에 직접 들어 있는 한국어 문구를 찾는다(주석은 세지 않는다). 번역 사전으로 옮길 대상을 가늠하고,
// 옮긴 영역에 새 하드코딩이 생기지 않았는지 볼 때 쓴다. 실행 중에는 한국어 fallback 이 영어 누락을 가리므로 정적으로 본다.
//
// 세지 않는 것: console.* 와 log(...) 호출의 인자(로그), 그리고 바로 윗줄(또는 같은 줄)에 `// i18n-ignore: <이유>` 가 붙은 노드.
// i18n-ignore 는 모델에게 보내는 글(prompt)처럼 화면 문구가 아닌 것에만, 가장 좁은 범위(상수·속성 하나)에 붙인다.
//
//   node scripts/check-i18n.mjs                 영역별 개수와 파일별 상위 목록
//   node scripts/check-i18n.mjs --list <경로>    그 경로 아래의 문구를 위치와 함께 나열
//   node scripts/check-i18n.mjs --strict <경로>… 그 경로들에 문구가 하나라도 있으면 실패(옮긴 영역 지키기)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const AREAS = ["src/renderer", "src/main", "src/shared", "src/preload", "cli"];
// 번역 대상이 아닌 곳: 사전 자체, 테스트, 모델에게 보내는 프롬프트(4단계에서 응답 언어 정책으로 다룬다)
const SKIP = [/\.test\.tsx?$/, /^src\/shared\/i18n\//, /\.d\.ts$/];
const HANGUL = /[가-힣]/;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|cjs|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function scan(file) {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : /\.(cjs|mjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  // 표시가 있는 줄 번호(0부터). 표시가 혼자 있는 줄이면 다음 줄에서 시작하는 노드를, 코드 뒤에 붙었으면 그 줄의 노드를 건너뛴다.
  const ignored = new Set();
  text.split("\n").forEach((l, i) => {
    const at = l.indexOf("// i18n-ignore:");
    if (at === -1) return;
    ignored.add(l.slice(0, at).trim() === "" ? i + 1 : i);
  });
  const add = (node, value) => {
    // 표시용 로케일을 한국어로 고정한 것도 잡는다(문구는 아니지만 영어 화면에 한국어 날짜가 나온다)
    if (!HANGUL.test(value) && value !== "ko-KR") return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    hits.push({ line: line + 1, text: value.replace(/\s+/g, " ").trim().slice(0, 80) });
  };
  const visit = (node) => {
    if (ignored.size && node !== sf && ignored.has(sf.getLineAndCharacterOfPosition(node.getStart()).line)) return;
    // console.* 와 log(...)·x.log?.(...) 로그는 화면 문구가 아니다
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && (callee.expression.getText(sf) === "console" || callee.name.text === "log")) return;
      if (ts.isIdentifier(callee) && callee.text === "log") return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, node.head.text + node.templateSpans.map((s) => s.literal.text).join("…"));
    else if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isRegularExpressionLiteral(node)) add(node, node.text);
    // 템플릿은 통째로 한 번만 센다
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
    else for (const s of node.templateSpans) ts.forEachChild(s.expression, visit), visit(s.expression);
  };
  visit(sf);
  return hits;
}

const args = process.argv.slice(2);
const mode = args[0] === "--list" ? "list" : args[0] === "--strict" ? "strict" : "summary";
const targets = mode === "summary" ? AREAS : args.slice(1);
if (mode !== "summary" && targets.length === 0) {
  console.error("경로를 주세요.");
  process.exit(2);
}

let total = 0;
const perFile = [];
for (const target of targets) {
  const abs = join(ROOT, target);
  const list = statSync(abs).isDirectory() ? files(abs) : [abs];
  let areaCount = 0;
  for (const f of list) {
    // Windows 에서는 relative() 가 \ 로 잇는다 — SKIP 과 출력이 / 기준이라 맞춘다
    const rel = relative(ROOT, f).replaceAll("\\", "/");
    if (SKIP.some((re) => re.test(rel))) continue;
    const hits = scan(f);
    if (hits.length === 0) continue;
    areaCount += hits.length;
    perFile.push({ rel, hits });
  }
  total += areaCount;
  if (mode === "summary") console.log(`${String(areaCount).padStart(5)}  ${target}`);
}

if (mode === "summary") {
  console.log(`${String(total).padStart(5)}  합계\n\n파일별 상위 15개`);
  for (const f of perFile.sort((a, b) => b.hits.length - a.hits.length).slice(0, 15)) console.log(`${String(f.hits.length).padStart(5)}  ${f.rel}`);
} else {
  for (const f of perFile) for (const h of f.hits) console.log(`${f.rel}:${h.line}  ${h.text}`);
  console.log(`\n${total}개`);
  if (mode === "strict" && total > 0) process.exit(1);
}
