// Codex 의 `$` 언급: 스킬과 앱(커넥터)을 `$이름` 으로 부른다. Codex CLI 와 같은 규칙으로 목록을 만들고,
// 보낼 때 글 속 `$이름` 을 찾아 app-server 입력의 skill·mention 항목으로 붙인다(글만 보내면 확실히 불리지 않는다).

export interface CodexMention {
  kind: "skill" | "app";
  /** `$` 뒤에 쓰는 이름. 스킬은 이름 그대로, 앱은 이름을 슬러그로 바꾼 것. */
  name: string;
  description: string;
  /** 스킬은 SKILL.md 경로, 앱은 app://<id>. */
  path: string;
}

/** `$` 뒤 이름에 쓸 수 있는 글자. Codex CLI 규칙(영문·숫자·_·-)에 플러그인 스킬의 ":"(plugin:skill)를 더한다. */
const NAME = /[A-Za-z0-9_:-]/;

/** 앱 이름 → `$` 슬러그. 영문·숫자는 소문자로, 나머지는 "-", 앞뒤 "-" 는 뗀다. */
export function codexAppSlug(name: string): string {
  const s = [...name].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : "-")).join("").replace(/^-+|-+$/g, "");
  return s || "app";
}

interface SkillLike {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  interface?: { shortDescription?: unknown } | null;
  path?: unknown;
  enabled?: unknown;
}
interface AppLike {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  isAccessible?: unknown;
  isEnabled?: unknown;
}

/**
 * app-server 의 skills/list·app/list 응답 → `$` 목록. 꺼진 스킬, 쓸 수 없는 앱은 뺀다.
 * 앱 슬러그가 겹치거나 스킬 이름과 같으면 CLI 처럼 앱을 뺀다(어느 것을 부르는지 알 수 없다).
 */
export function codexMentionsFrom(skillsResp: unknown, appsResp: unknown): CodexMention[] {
  const out: CodexMention[] = [];
  const entries = (skillsResp as { data?: { skills?: SkillLike[] }[] } | null)?.data ?? [];
  const seen = new Set<string>();
  for (const e of entries)
    for (const s of e.skills ?? []) {
      if (s.enabled === false || typeof s.name !== "string" || typeof s.path !== "string" || seen.has(s.name)) continue;
      seen.add(s.name);
      const short = s.interface?.shortDescription ?? s.shortDescription ?? s.description;
      out.push({ kind: "skill", name: s.name, description: typeof short === "string" ? short : "", path: s.path });
    }
  const skillNames = new Set(out.map((m) => m.name.toLowerCase()));
  const apps = ((appsResp as { data?: AppLike[] } | null)?.data ?? []).filter(
    (a) => a.isAccessible === true && a.isEnabled !== false && typeof a.id === "string" && typeof a.name === "string",
  );
  const count = new Map<string, number>();
  for (const a of apps) count.set(codexAppSlug(a.name as string), (count.get(codexAppSlug(a.name as string)) ?? 0) + 1);
  for (const a of apps) {
    const slug = codexAppSlug(a.name as string);
    if (count.get(slug) !== 1 || skillNames.has(slug)) continue;
    out.push({ kind: "app", name: slug, description: typeof a.description === "string" ? a.description : (a.name as string), path: `app://${a.id}` });
  }
  return out;
}

/** 글 속 `$이름` 중 목록에 있는 것(처음 나온 순서, 겹치지 않게). */
export function findCodexMentions(text: string, list: readonly CodexMention[]): CodexMention[] {
  const byName = new Map(list.map((m) => [m.name, m]));
  const out: CodexMention[] = [];
  for (const m of text.matchAll(/\$([A-Za-z0-9_:-]+)/g)) {
    // "$pdf: 정리해 줘" 처럼 뒤에 붙인 ":" 는 이름이 아니다
    const hit = byName.get(m[1]) ?? byName.get(m[1].replace(/:+$/, ""));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** 커서 앞 글이 `$검색어` 로 끝나면(앞은 줄 처음이거나 공백) 그 시작 위치와 검색어. 목록을 띄울 때 쓴다. */
export function parseDollarQuery(beforeCaret: string): { start: number; query: string } | null {
  let i = beforeCaret.length;
  while (i > 0 && NAME.test(beforeCaret[i - 1])) i--;
  if (i === 0 || beforeCaret[i - 1] !== "$") return null;
  const start = i - 1;
  if (start > 0 && !/\s/.test(beforeCaret[start - 1])) return null;
  return { start, query: beforeCaret.slice(i) };
}

/** 검색어로 거른다 — 이름 앞부분이 맞는 것 먼저, 그다음 이름에 들어 있는 것. */
export function filterCodexMentions(list: readonly CodexMention[], query: string): CodexMention[] {
  const q = query.toLowerCase();
  const prefix = list.filter((m) => m.name.toLowerCase().startsWith(q));
  const partial = list.filter((m) => !m.name.toLowerCase().startsWith(q) && m.name.toLowerCase().includes(q));
  return [...prefix, ...partial];
}
