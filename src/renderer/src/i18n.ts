// renderer 의 번역 인스턴스. 첫 렌더 전에 main 이 해석한 언어로 만든다(main.tsx).
// 컴포넌트는 react-i18next 의 useTranslation() 을 쓴다 — 언어를 바꾸면 다시 그려진다.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, type Locale } from "@shared/i18n";
import { shortcutVars } from "@shared/app-shortcuts";
import { IS_MAC } from "./platform";

export function initI18n(locale: Locale): void {
  void i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: "ko",
    supportedLngs: ["ko", "en"],
    defaultNS: "translation",
    initAsync: false,
    returnEmptyString: false,
    returnNull: false,
    // 문구 속 단축키({{kNewTab}} 등)는 운영체제에 맞는 표기로 채운다
    interpolation: { escapeValue: false, defaultVariables: shortcutVars(IS_MAC) },
  });
  document.documentElement.lang = locale;
}

/** 설정에서 언어를 바꿨을 때. */
export function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
}
