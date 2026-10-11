// 휴대폰 화면(휴대폰에서 이어 쓰기). Sudal 의 Tailscale 웹 서버가 짝지은 기기에만 준다.
// 앱 창과 달리 window.sudal(preload)이 없다 — 모든 것을 /api 로 받는다.
import { createRoot } from "react-dom/client";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "@shared/i18n";
import { shortcutVars } from "@shared/app-shortcuts";
import { MobileApp } from "./MobileApp";
import "./mobile.css";

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
applyTheme();
dark.addEventListener("change", applyTheme);

void fetch("/app-info")
  .then((r) => (r.ok ? (r.json() as Promise<{ language?: string }>) : {}))
  .catch(() => ({}))
  .then((info: { language?: string }) => {
    const lng = info.language === "en" ? "en" : "ko";
    void i18next.use(initReactI18next).init({
      resources,
      lng,
      fallbackLng: "ko",
      defaultNS: "translation",
      initAsync: false,
      returnEmptyString: false,
      returnNull: false,
      interpolation: { escapeValue: false, defaultVariables: shortcutVars(false) },
    });
    document.documentElement.lang = lng;
    createRoot(document.getElementById("root")!).render(<MobileApp />);
  });
