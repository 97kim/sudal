// 사용량 집계 — 순수 함수. 데이터 소스(트랜스크립트 스캔)는 main 이, 화면은 renderer 가 맡는다.
// 비용은 가격표(USD / MTok) 기반 "API 환산 추정" 이다. 구독(OAuth) 사용자는 실제 청구와 다르다.

import type { Provider } from "./ipc";
import { baseName } from "./path-display";

export interface UsageRecord {
  ts: number;
  provider: Provider;
  model: string;
  cwd: string;
  sessionId: string;
  /** 비캐시 입력 토큰. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 합쳐진 API 호출 수. */
  requests: number;
}

// ===== 가격표 =====

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingEntry extends ModelPrice {
  /** 모델 id 에 이 문자열이 포함되면 매치. 위에서부터 첫 매치. */
  match: string;
  label: string;
  /** 공식 가격표를 확인하지 못한 추정치면 true. */
  estimated?: boolean;
}

/** 앱 기본 가격표. userData/pricing.json 으로 덮어쓸 수 있다. 순서가 우선순위다. */
export const DEFAULT_PRICING: PricingEntry[] = [
  // 공식 가격표(platform.claude.com/docs/en/about-claude/pricing, 2026-09-28 확인). 캐시 쓰기는 5분 캐시 기준.
  { match: "fable-5-1", label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: "fable-5", label: "Claude Fable 5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // opus-5-5 는 opus-5 보다 먼저 — 포함 검사라 뒤에 두면 Opus 5 로 잡힌다
  { match: "opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { match: "opus-5", label: "Claude Opus 5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "sonnet-5", label: "Claude Sonnet 5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: "haiku-4-5", label: "Claude Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Opus 4.5 부터 값이 내렸다. 4.x 한 줄로 묶으면 4.5~4.8 이 세 배로 셈해진다.
  { match: "opus-4-8", label: "Claude Opus 4.8", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "opus-4-7", label: "Claude Opus 4.7", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "opus-4-6", label: "Claude Opus 4.6", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "opus-4-5", label: "Claude Opus 4.5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "opus-4", label: "Claude Opus 4 / 4.1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: "sonnet-4", label: "Claude Sonnet 4.x", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: "haiku-3-5", label: "Claude Haiku 3.5", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // 공식 가격표(developers.openai.com/api/docs/pricing, 2026-09-30 확인). Standard, 272K 미만 컨텍스트 기준.
  // 캐시 쓰기 요금은 없다. 포함 검사라 긴 이름(-mini·-nano·-pro)을 먼저 둔다.
  { match: "gpt-6.1-sol", label: "GPT-6.1 Sol", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  { match: "gpt-6-sol", label: "GPT-6 Sol", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
  { match: "gpt-6-astra", label: "GPT-6 Astra", input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
  { match: "gpt-6-luna", label: "GPT-6 Luna", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
  { match: "gpt-5.5-pro", label: "GPT-5.5 Pro", input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  { match: "gpt-5.5", label: "GPT-5.5", input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  { match: "gpt-5.4-pro", label: "GPT-5.4 Pro", input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  { match: "gpt-5.4-mini", label: "GPT-5.4 mini", input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  { match: "gpt-5.4-nano", label: "GPT-5.4 nano", input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  { match: "gpt-5.4", label: "GPT-5.4", input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  { match: "codex", label: "GPT-5 Codex", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, estimated: true },
  { match: "gpt-5", label: "GPT-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, estimated: true },
  { match: "o4-mini", label: "o4-mini", input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0, estimated: true },
];

export function resolvePrice(model: string, pricing: PricingEntry[] = DEFAULT_PRICING): PricingEntry | null {
  const m = model.toLowerCase();
  return pricing.find((p) => m.includes(p.match.toLowerCase())) ?? null;
}

export function costOf(
  r: { input: number; output: number; cacheRead: number; cacheWrite: number },
  price: ModelPrice,
): number {
  return (
    (r.input * price.input + r.output * price.output + r.cacheRead * price.cacheRead + r.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

// ===== 시간 =====

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type Period = "today" | "7d" | "30d" | "month";

export function periodRange(period: Period, now: number): { from: number; to: number } {
  const today = startOfDay(now);
  switch (period) {
    case "today":
      return { from: today, to: now };
    case "7d":
      return { from: today - 6 * 86_400_000, to: now };
    case "30d":
      return { from: today - 29 * 86_400_000, to: now };
    case "month": {
      const d = new Date(now);
      return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
    }
  }
}

// ===== 집계 =====

export interface UsageFilter {
  from: number;
  to: number;
  provider?: Provider | "all";
  /** 특정 워크스페이스(cwd) 만. null/undefined 면 전체. */
  cwd?: string | null;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Totals extends Tokens {
  requests: number;
  costUsd: number;
  /** 가격표에 없는 모델 (비용 미산정). */
  unpricedModels: string[];
}

export interface DailyPoint extends Tokens {
  day: string;
  costUsd: number;
  requests: number;
}

export interface ModelRow extends Tokens {
  model: string;
  provider: Provider;
  requests: number;
  costUsd: number;
  priced: boolean;
  estimated: boolean;
  label: string;
}

export interface WorkspaceRow extends Tokens {
  cwd: string;
  name: string;
  requests: number;
  costUsd: number;
  /** 비용 점유율 0~1. */
  share: number;
  sessions: number;
}

export interface SessionRow extends Tokens {
  sessionId: string;
  provider: Provider;
  model: string;
  cwd: string;
  costUsd: number;
  requests: number;
  firstTs: number;
  lastTs: number;
  inApp: boolean;
}

export interface UsageSummary {
  filter: UsageFilter;
  totals: Totals;
  /** 직전 같은 길이 기간 (증감 표시용). */
  previous: Totals;
  daily: DailyPoint[];
  byModel: ModelRow[];
  byWorkspace: WorkspaceRow[];
  topSessions: SessionRow[];
  last5h: Totals;
  sources: { inApp: Totals; terminal: Totals };
}

const ZERO = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, costUsd: 0, unpricedModels: [] });

function add(t: Totals, r: UsageRecord, cost: number | null) {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.requests += r.requests;
  if (cost === null) {
    if (!t.unpricedModels.includes(r.model)) t.unpricedModels.push(r.model);
  } else t.costUsd += cost;
}

export function tokensTotal(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}


function matches(r: UsageRecord, f: UsageFilter): boolean {
  if (r.ts < f.from || r.ts > f.to) return false;
  if (f.provider && f.provider !== "all" && r.provider !== f.provider) return false;
  if (f.cwd && r.cwd !== f.cwd) return false;
  return true;
}

export function summarizeUsage(
  records: UsageRecord[],
  filter: UsageFilter,
  opts: { pricing?: PricingEntry[]; inAppSessionIds?: Set<string>; now?: number } = {},
): UsageSummary {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const inApp = opts.inAppSessionIds ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const priceCache = new Map<string, PricingEntry | null>();
  const priceFor = (model: string) => {
    if (!priceCache.has(model)) priceCache.set(model, resolvePrice(model, pricing));
    return priceCache.get(model) ?? null;
  };
  const costFor = (r: UsageRecord) => {
    const p = priceFor(r.model);
    return p ? costOf(r, p) : null;
  };

  const totals = ZERO();
  const previous = ZERO();
  const last5h = ZERO();
  const sources = { inApp: ZERO(), terminal: ZERO() };
  const dailyMap = new Map<string, DailyPoint>();
  const models = new Map<string, ModelRow>();
  const workspaces = new Map<string, WorkspaceRow & { sessionSet: Set<string> }>();
  const sessions = new Map<string, SessionRow>();

  const span = filter.to - filter.from;
  const prevFilter: UsageFilter = { ...filter, from: filter.from - span - 1, to: filter.from - 1 };

  for (const r of records) {
    const cost = costFor(r);
    if (matches(r, prevFilter)) add(previous, r, cost);
    if (r.ts >= now - 5 * 3_600_000 && r.ts <= now && (!filter.provider || filter.provider === "all" || r.provider === filter.provider)) {
      add(last5h, r, cost);
    }
    if (!matches(r, filter)) continue;

    add(totals, r, cost);
    add(inApp.has(r.sessionId) ? sources.inApp : sources.terminal, r, cost);

    const day = dayKey(r.ts);
    const dp = dailyMap.get(day) ?? { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0 };
    dp.input += r.input;
    dp.output += r.output;
    dp.cacheRead += r.cacheRead;
    dp.cacheWrite += r.cacheWrite;
    dp.requests += r.requests;
    dp.costUsd += cost ?? 0;
    dailyMap.set(day, dp);

    const price = priceFor(r.model);
    const mr =
      models.get(r.model) ??
      ({
        model: r.model,
        provider: r.provider,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        requests: 0,
        costUsd: 0,
        priced: !!price,
        estimated: !!price?.estimated,
        label: price?.label ?? r.model,
      } satisfies ModelRow);
    mr.input += r.input;
    mr.output += r.output;
    mr.cacheRead += r.cacheRead;
    mr.cacheWrite += r.cacheWrite;
    mr.requests += r.requests;
    mr.costUsd += cost ?? 0;
    models.set(r.model, mr);

    const wr =
      workspaces.get(r.cwd) ??
      ({
        cwd: r.cwd,
        name: baseName(r.cwd),
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        requests: 0,
        costUsd: 0,
        share: 0,
        sessions: 0,
        sessionSet: new Set<string>(),
      });
    wr.input += r.input;
    wr.output += r.output;
    wr.cacheRead += r.cacheRead;
    wr.cacheWrite += r.cacheWrite;
    wr.requests += r.requests;
    wr.costUsd += cost ?? 0;
    wr.sessionSet.add(r.sessionId);
    workspaces.set(r.cwd, wr);

    const sr =
      sessions.get(r.sessionId) ??
      ({
        sessionId: r.sessionId,
        provider: r.provider,
        model: r.model,
        cwd: r.cwd,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        requests: 0,
        firstTs: r.ts,
        lastTs: r.ts,
        inApp: inApp.has(r.sessionId),
      } satisfies SessionRow);
    sr.input += r.input;
    sr.output += r.output;
    sr.cacheRead += r.cacheRead;
    sr.cacheWrite += r.cacheWrite;
    sr.requests += r.requests;
    sr.costUsd += cost ?? 0;
    sr.firstTs = Math.min(sr.firstTs, r.ts);
    sr.lastTs = Math.max(sr.lastTs, r.ts);
    sessions.set(r.sessionId, sr);
  }

  // 기간의 모든 날을 채운다 (빈 날도 0 으로) — 막대가 빠지면 날짜 축이 틀어진다.
  const daily: DailyPoint[] = [];
  for (let t = startOfDay(filter.from); t <= filter.to; t += 86_400_000) {
    const day = dayKey(t);
    daily.push(dailyMap.get(day) ?? { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0 });
  }

  const byWorkspace = [...workspaces.values()]
    .map(({ sessionSet, ...w }) => ({ ...w, sessions: sessionSet.size, share: totals.costUsd > 0 ? w.costUsd / totals.costUsd : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || tokensTotal(b) - tokensTotal(a));

  return {
    filter,
    totals,
    previous,
    daily,
    byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || tokensTotal(b) - tokensTotal(a)),
    byWorkspace,
    topSessions: [...sessions.values()].sort((a, b) => b.costUsd - a.costUsd || tokensTotal(b) - tokensTotal(a)).slice(0, 10),
    last5h,
    sources,
  };
}

/** 증감률(%). 이전 값이 0 이면 null. */
export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

// ===== CSV =====

export function usageCsv(records: UsageRecord[], filter: UsageFilter, pricing: PricingEntry[] = DEFAULT_PRICING): string {
  const header = ["timestamp", "provider", "model", "workspace", "session_id", "input", "output", "cache_read", "cache_write", "requests", "cost_usd_estimate"];
  const rows = records
    .filter((r) => matches(r, filter))
    .sort((a, b) => a.ts - b.ts)
    .map((r) => {
      const p = resolvePrice(r.model, pricing);
      return [
        new Date(r.ts).toISOString(),
        r.provider,
        r.model,
        csvEscape(r.cwd),
        r.sessionId,
        r.input,
        r.output,
        r.cacheRead,
        r.cacheWrite,
        r.requests,
        p ? costOf(r, p).toFixed(6) : "",
      ].join(",");
    });
  return [header.join(","), ...rows].join("\n");
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
