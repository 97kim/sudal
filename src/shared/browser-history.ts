// 브라우저 주소창 기록과 자동완성. 순수 함수 — 저장은 렌더러가 한다.

export interface HistoryEntry {
  url: string;
  /** 마지막 방문 시각. 같은 점수면 최근 것이 위로. */
  at: number;
  /** 방문 횟수. 자주 가는 곳이 위로 — 개발 중에는 같은 주소를 반복해 연다. */
  visits: number;
}

/** 기록 상한. 이 앱은 몇 개의 로컬 주소를 반복해 쓰는 쪽이라 크게 둘 이유가 없다. */
export const HISTORY_MAX = 200;
/** 자동완성에 보여 줄 개수. */
export const SUGGEST_MAX = 8;

/** 방문을 기록에 반영한다(최신이 앞). 같은 주소는 횟수만 올린다. */
export function recordVisit(history: HistoryEntry[], url: string, at: number): HistoryEntry[] {
  const u = url.trim();
  // about:blank 같은 것과 빈 값은 기록하지 않는다.
  if (!/^https?:\/\//i.test(u)) return history;
  const rest = history.filter((h) => h.url !== u);
  const prev = history.find((h) => h.url === u);
  return [{ url: u, at, visits: (prev?.visits ?? 0) + 1 }, ...rest].slice(0, HISTORY_MAX);
}

/** 검색어와 얼마나 맞나. 높을수록 위. 안 맞으면 0. */
function score(entry: HistoryEntry, q: string): number {
  const url = entry.url.toLowerCase();
  if (!q) return 1;
  const i = url.indexOf(q);
  if (i === -1) return 0;
  // 호스트가 시작되는 자리에서 맞으면 가장 좋다 — "loc" 로 localhost 를 찾는 흔한 경우.
  const afterScheme = url.replace(/^https?:\/\//, "");
  if (afterScheme.startsWith(q)) return 3;
  if (i === 0) return 2;
  return 1;
}

/**
 * 주소창에 보여 줄 제안. 맞는 정도 → 방문 횟수 → 최근 순.
 * 이미 그대로 친 주소는 뺀다(같은 것을 고르게 하는 줄은 의미가 없다).
 */
export function suggest(history: HistoryEntry[], query: string, limit = SUGGEST_MAX): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  return history
    .map((h) => ({ h, s: score(h, q) }))
    .filter(({ h, s }) => s > 0 && h.url.toLowerCase() !== q)
    .sort((a, b) => b.s - a.s || b.h.visits - a.h.visits || b.h.at - a.h.at)
    .slice(0, limit)
    .map(({ h }) => h);
}

/** 저장된 문자열 → 기록. 모양이 틀린 항목은 조용히 버린다(디스크의 값은 믿지 않는다). */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (h): h is HistoryEntry =>
          !!h && typeof h.url === "string" && /^https?:\/\//i.test(h.url) && typeof h.at === "number" && typeof h.visits === "number",
      )
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** 빈 탭에 보여 줄 자주 간 곳. 개발 서버는 경로가 매번 달라 주소별로 세면 흩어지므로 출처(호스트+포트)로 묶는다. */
export interface FrequentSite {
  origin: string;
  /** 그 출처에서 가장 많이 간 주소 — 누르면 여기로 간다. */
  url: string;
  visits: number;
}

export function frequentSites(history: HistoryEntry[], limit = SUGGEST_MAX): FrequentSite[] {
  const by = new Map<string, { site: FrequentSite; best: HistoryEntry; at: number }>();
  for (const h of history) {
    let origin: string;
    try {
      origin = new URL(h.url).origin;
    } catch {
      continue;
    }
    const cur = by.get(origin);
    if (!cur) {
      by.set(origin, { site: { origin, url: h.url, visits: h.visits }, best: h, at: h.at });
      continue;
    }
    cur.site.visits += h.visits;
    cur.at = Math.max(cur.at, h.at);
    if (h.visits > cur.best.visits || (h.visits === cur.best.visits && h.at > cur.best.at)) {
      cur.best = h;
      cur.site.url = h.url;
    }
  }
  return [...by.values()]
    .sort((a, b) => b.site.visits - a.site.visits || b.at - a.at)
    .slice(0, limit)
    .map((v) => v.site);
}
