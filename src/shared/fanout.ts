// 팬아웃(지시 하나 → 격리 세션 N개)의 순수 부분 — 세션 이름·제목·요약·비교용 파일 합집합. 실행은 main/index.ts startFanout.
import type { TFunction } from "i18next";
import type { FanoutVariant } from "./chat-events";
import type { GitChangeDto, Provider } from "./ipc";

export const FANOUT_MAX_VARIANTS = 4;
export const FANOUT_MIN_VARIANTS = 2;
/** 카드에 남기는 지시·답변 요약 길이. */
export const FANOUT_PROMPT_EXCERPT = 300;
export const FANOUT_SUMMARY_EXCERPT = 400;

export const PROVIDER_NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

export function variantLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 세션 탭 제목: "팬아웃 A · Codex". 원래 탭에 이름이 있으면 뒤에 붙인다 — originTitle 은 저장된 제목(이름 없는 탭이면 null)이다. */
export function fanoutTabTitle(t: TFunction, label: string, provider: Provider, originTitle?: string | null): string {
  const base = t("main.fanout.tabTitle", { label, provider: PROVIDER_NAME[provider] });
  return originTitle ? `${base} · ${originTitle.slice(0, 24)}` : base;
}

export function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** 세션 진행 요약: "2/3 완료 · 1 응답 필요". */
export function fanoutSummary(t: TFunction, variants: FanoutVariant[]): string {
  const done = variants.filter((v) => v.status === "done").length;
  const waiting = variants.filter((v) => v.status === "waiting").length;
  const failed = variants.filter((v) => v.status === "failed").length;
  const cleaned = variants.filter((v) => v.status === "cleaned").length;
  if (cleaned === variants.length) return t("main.fanout.summary.cleaned");
  const parts = [t("main.fanout.summary.done", { done, total: variants.length })];
  if (waiting) parts.push(t("main.fanout.summary.waiting", { count: waiting }));
  if (failed) parts.push(t("main.fanout.summary.failed", { count: failed }));
  return parts.join(" · ");
}

export function changeStats(changes: GitChangeDto[]): { files: number; added: number; deleted: number } {
  return changes.reduce((n, c) => ({ files: n.files + 1, added: n.added + c.added, deleted: n.deleted + c.deleted }), { files: 0, added: 0, deleted: 0 });
}

/** 비교 화면의 파일 목록: 모든 세션의 변경 경로 합집합(정렬), 경로마다 어느 세션이 건드렸는지. */
export function unionPaths(variants: { label: string; changes: GitChangeDto[] }[]): { path: string; labels: string[] }[] {
  const map = new Map<string, string[]>();
  for (const v of variants) for (const c of v.changes) map.set(c.path, [...(map.get(c.path) ?? []), v.label]);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, labels]) => ({ path, labels }));
}

/** 팬아웃 전체가 끝났는지(모든 세션이 running/waiting 을 벗어남). */
export function allSettled(variants: FanoutVariant[]): boolean {
  return variants.every((v) => v.status !== "running" && v.status !== "waiting");
}

/** 시작 요청 검증 — 렌더러·CLI 입력 공통. */
export function validateFanoutRequest(t: TFunction, o: { prompt: unknown; variants: unknown; policy?: unknown }): { ok: true; prompt: string; variants: { provider: Provider; model?: string }[]; policy: "ask" | "auto_edit" | "full" } | { ok: false; error: string } {
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) return { ok: false, error: t("main.fanout.validate.promptRequired") };
  if (!Array.isArray(o.variants)) return { ok: false, error: t("main.fanout.validate.variantsUnreadable") };
  const variants: { provider: Provider; model?: string }[] = [];
  for (const v of o.variants) {
    const provider = typeof v === "string" ? v : v && typeof v === "object" ? (v as { provider?: unknown }).provider : undefined;
    if (provider !== "claude" && provider !== "codex") return { ok: false, error: t("main.fanout.validate.badProvider", { value: String(provider) }) };
    const model = v && typeof v === "object" && typeof (v as { model?: unknown }).model === "string" ? ((v as { model: string }).model.trim() || undefined) : undefined;
    variants.push(model ? { provider, model } : { provider });
  }
  if (variants.length < FANOUT_MIN_VARIANTS) return { ok: false, error: t("main.fanout.validate.tooFew", { min: FANOUT_MIN_VARIANTS }) };
  if (variants.length > FANOUT_MAX_VARIANTS) return { ok: false, error: t("main.fanout.validate.tooMany", { max: FANOUT_MAX_VARIANTS }) };
  const policy = o.policy === undefined ? "auto_edit" : o.policy;
  if (policy !== "ask" && policy !== "auto_edit" && policy !== "full") return { ok: false, error: t("main.fanout.validate.badPolicy") };
  return { ok: true, prompt, variants, policy };
}
