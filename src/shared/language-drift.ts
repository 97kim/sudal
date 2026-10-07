// 한 턴 안에서 진행 설명이 앱 언어를 벗어났는지. 도구를 여러 번 부르면 영어 도구 출력이 쌓여 모델이 영어로 넘어간다.
// 넘어간 것이 보이면 다음 도구 결과 뒤에 언어 리마인더를 다시 넣는다(claude-adapter).

import type { Locale } from "./i18n";

/** 코드·경로·URL 은 언어와 상관없이 영어라 뺀다. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)[~.]?\/\S+/g, " ");
}

/**
 * 글이 앱 언어에서 벗어났나. 한글 한 글자는 영어 2~3글자 몫이라 3배로 쳐서 비교한다.
 * 짧은 글(라틴 30자·한글 10자 미만)은 판정하지 않는다 — "OK", 고유명사 하나로 오탐하지 않게.
 */
export function isOffLanguage(text: string, locale: Locale): boolean {
  const p = prose(text);
  const hangul = (p.match(/[가-힣]/g) ?? []).length;
  const latin = (p.match(/[A-Za-z]/g) ?? []).length;
  if (locale === "ko") return latin >= 30 && hangul * 3 < latin;
  return hangul >= 10 && hangul * 3 > latin;
}
