// provider 별 모델 목록의 정적 폴백. 실제 목록은 main/models.ts 가 CLI 에 물어 온다(app.models). 빈 id 는 "CLI 기본 설정".
import type { TFunction } from "i18next";
import type { ModelOptionDto, Provider } from "./ipc";
import { resolvePrice } from "./usage";

export const STATIC_MODELS: Record<Provider, ModelOptionDto[]> = {
  claude: [
    { id: "opus[1m]", label: "Opus (1M context)" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-astra", label: "GPT-6-Astra" },
    { id: "gpt-5.4", label: "gpt-5.4" },
  ],
  agy: [
    { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", isDefault: true },
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  ],
};

/** 피커 옵션: 맨 앞에 "기본(CLI 설정)" 을 붙이고, 현재 값이 목록에 없으면 그대로 한 줄 더 둔다(사용자가 직접 넣은 모델명). */
export function modelOptions(t: TFunction, models: ModelOptionDto[], current: string | undefined, defaultModel: string | null | undefined): ModelOptionDto[] {
  // CLI 설정 파일에 모델이 없으면 CLI 가 기본으로 고르는 모델(isDefault, Codex)을 "기본" 줄에 적는다
  const fallbackDefault = models.find((m) => m.isDefault)?.label;
  const shown = defaultModel || fallbackDefault;
  const head: ModelOptionDto = { id: "", label: shown ? t("session.model.defaultWith", { model: shown }) : t("session.model.default") };
  const rest = models.filter((m) => m.id !== "");
  const cur = current ?? "";
  const known = cur === "" || rest.some((m) => m.id === cur);
  return [head, ...rest, ...(known ? [] : [{ id: cur, label: t("session.model.custom", { model: cur }) }])];
}

/**
 * 헤더에 보일 모델 이름. 고른 값이 별칭(opus·sonnet·haiku·fable, [1m] 같은 꼬리 포함)이면 버전이 안 보이므로,
 * CLI 가 알려 준 실제 모델 id(resolved)가 같은 계열일 때 "Opus 5.5" 처럼 버전을 붙인다. 모델을 막 바꿔 아직 응답이
 * 없으면 resolved 는 옛 모델이라 계열이 달라 — 그때는 고른 값만 보여 준다(옛 버전을 잘못 붙이지 않게).
 */
export function headerModelLabel(chosen: string | null | undefined, resolved: string | null | undefined): string {
  const pretty = (id: string) => resolvePrice(id)?.label.replace(/^Claude /, "") ?? id;
  const pick = (chosen ?? "").trim();
  const real = (resolved ?? "").trim();
  if (!pick) return real ? pretty(real) : "";
  if (!real) return pick;
  const base = pick.replace(/\[[^\]]*\]$/, "").toLowerCase();
  const tail = /\[1m\]$/i.test(pick) ? " (1M)" : "";
  const same = real.toLowerCase() === base || real.toLowerCase().includes(base);
  return same ? `${pretty(real)}${tail}` : pick;
}
