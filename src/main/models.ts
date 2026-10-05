// provider 별 모델 목록 — CLI 에 직접 묻는다(Claude: SDK supportedModels, Codex: app-server model/list). 정적 목록은 못 물었을 때의 폴백.
// 결과는 잠깐 캐시한다(모델 피커·팬아웃 창을 열 때마다 프로세스를 띄우지 않게).
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOptionDto, Provider } from "@shared/ipc";
import { STATIC_MODELS } from "@shared/models";
import type { ClaudeRuntime } from "./claude-adapter";
import type { CodexRuntime } from "./codex-adapter";
import { CodexAppServer } from "./codex-app-server";
import { mt } from "./i18n";

const CACHE_MS = 10 * 60_000;
const cache = new Map<Provider, { at: number; models: ModelOptionDto[] }>();
const inflight = new Map<Provider, Promise<ModelOptionDto[]>>();

export interface ModelSources {
  claude(): Promise<ClaudeRuntime>;
  codex(): Promise<CodexRuntime>;
  log?(line: string): void;
}

/** 목록을 돌려준다. 실패하면 정적 폴백(source: "static"). */
export async function listModels(provider: Provider, src: ModelSources, opts: { force?: boolean } = {}): Promise<{ models: ModelOptionDto[]; source: "cli" | "static" }> {
  const hit = cache.get(provider);
  if (hit && !opts.force && Date.now() - hit.at < CACHE_MS) return { models: hit.models, source: "cli" };
  let p = inflight.get(provider);
  if (!p) {
    p = (provider === "claude" ? claudeModels(src) : codexModels(src)).finally(() => inflight.delete(provider));
    inflight.set(provider, p);
  }
  try {
    const models = await p;
    cache.set(provider, { at: Date.now(), models });
    return { models, source: "cli" };
  } catch (e) {
    src.log?.(`[models] ${provider} 목록 조회 실패, 정적 목록 사용: ${e instanceof Error ? e.message : String(e)}`);
    return { models: STATIC_MODELS[provider], source: "static" };
  }
}

export function invalidateModels(provider?: Provider) {
  if (provider) cache.delete(provider);
  else cache.clear();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(mt("session.error.modelTimeout", { what, sec: ms / 1000 }))), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Claude: 프롬프트를 주지 않는 query 를 잠깐 열어 supportedModels 만 묻고 닫는다. */
async function claudeModels(src: ModelSources): Promise<ModelOptionDto[]> {
  const rt = await src.claude();
  async function* never(): AsyncGenerator<never> {
    await new Promise<void>(() => {});
  }
  const q = query({ prompt: never() as never, options: { cwd: process.cwd(), env: rt.env, pathToClaudeCodeExecutable: rt.pathToClaudeCodeExecutable, permissionMode: "default" } });
  try {
    const list = await withTimeout(q.supportedModels(), 20_000, "claude supportedModels");
    // "default" 행은 SDK 의 기본(사용자 CLI 설정과 다를 수 있다) — 우리 "" 항목이 그 역할을 하므로 뺀다
    return list
      .filter((m) => m.value !== "default")
      .map((m) => ({ id: m.value, label: m.displayName, description: m.description || undefined, ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}) }));
  } finally {
    try {
      (q as { close?: () => void }).close?.();
    } catch {
      /* 무시 */
    }
  }
}

/** Codex: app-server 를 띄워 model/list 만 묻고 내린다. hidden 모델은 뺀다. */
async function codexModels(src: ModelSources): Promise<ModelOptionDto[]> {
  const rt = await src.codex();
  const server = new CodexAppServer({ onNotification: () => {}, onServerRequest: () => Promise.reject(new Error("unsupported")), onExit: () => {} });
  try {
    await withTimeout(server.start(rt.codexPath, rt.env, process.cwd()), 20_000, mt("session.error.label.appServerStart"));
    const r = await server.request<{ data?: Record<string, unknown>[] }>("model/list", {}, 20_000);
    const rows = Array.isArray(r?.data) ? r.data : [];
    return rows
      .filter((m) => m.hidden !== true && typeof m.id === "string")
      .map((m) => ({ id: String(m.id), label: typeof m.displayName === "string" && m.displayName ? m.displayName : String(m.id), description: typeof m.description === "string" ? m.description : undefined, ...(m.isDefault === true ? { isDefault: true } : {}) }));
  } finally {
    server.close();
  }
}
