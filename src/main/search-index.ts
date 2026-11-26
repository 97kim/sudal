// 대화 검색 인덱스. 탭마다 스레드 파일의 (mtime, size) 를 키로 텍스트 블록을 캐시한다 — 검색할 때 파일은 stat 만 하고,
// 바뀐 파일만 다시 읽어 파싱한다. 진행 중인 세션 하나만 매번 다시 읽히고 나머지는 메모리에서 바로 맞춘다.
import type { ChatEvent } from "@shared/chat-events";
import { indexBlocks, searchBlocks, type IndexedBlock, type SearchHit } from "@shared/transcript-search";

export interface SearchIndexSource {
  threadStat(tabId: string): { mtimeMs: number; size: number } | null;
  iterateEvents(tabId: string): Iterable<ChatEvent>;
}

interface Entry {
  mtimeMs: number;
  size: number;
  blocks: IndexedBlock[];
  /** 대략적인 메모리 크기(문자 수 — 원문 + 소문자 사본). */
  chars: number;
}

/** 캐시가 붙들 수 있는 문자 수 상한(대략 2바이트/문자로 ~64MB). 넘으면 가장 오래 안 쓴 탭부터 비운다. */
export const SEARCH_INDEX_BUDGET_CHARS = 32 * 1024 * 1024;
const MAX_CACHED_TABS = 128;
const BLOCK_OVERHEAD_CHARS = 64;

export class SearchIndex {
  /** Map 의 삽입 순서를 LRU 로 쓴다 — 읽을 때마다 뒤로 옮긴다. */
  private readonly entries = new Map<string, Entry>();
  private chars = 0;
  /** 테스트·진단용: 파일을 실제로 다시 읽어 파싱한 횟수. */
  parses = 0;

  constructor(
    private readonly source: SearchIndexSource,
    private readonly budgetChars = SEARCH_INDEX_BUDGET_CHARS,
  ) {}

  /** 탭의 블록을 돌려준다(필요하면 갱신). 파일이 없으면 빈 배열이고 캐시도 지운다. */
  blocks(tabId: string): IndexedBlock[] {
    const st = this.source.threadStat(tabId);
    if (!st) {
      this.forget(tabId);
      return [];
    }
    const cur = this.entries.get(tabId);
    if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) {
      this.entries.delete(tabId); // 최근 사용으로 옮긴다
      this.entries.set(tabId, cur);
      return cur.blocks;
    }
    this.parses++;
    const blocks = indexBlocks(this.source.iterateEvents(tabId));
    const chars = blocks.reduce((n, b) => n + b.text.length + b.lower.length + b.blockId.length + BLOCK_OVERHEAD_CHARS, 0);
    this.forget(tabId);
    // A large tab remains fully searchable, but must not pin an oversized
    // index in the cache or evict every other tab on each search.
    if (chars > this.budgetChars) return blocks;
    this.entries.set(tabId, { mtimeMs: st.mtimeMs, size: st.size, blocks, chars });
    this.chars += chars;
    this.evict();
    return blocks;
  }

  /** 예산을 넘으면 가장 오래 안 쓴 것부터 비운다. */
  private evict() {
    for (const [id, e] of this.entries) {
      if (this.chars <= this.budgetChars && this.entries.size <= MAX_CACHED_TABS) break;
      this.entries.delete(id);
      this.chars -= e.chars;
    }
  }

  /** 모델에 남아 있는 탭만 유지한다 — 지워진 탭의 기록이 캐시에 남지 않게 검색 때마다 부른다. */
  retain(tabIds: Iterable<string>): void {
    const keep = new Set(tabIds);
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.forget(id);
  }

  search(tabId: string, query: string, limit = 20): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return searchBlocks(this.blocks(tabId), q, limit);
  }

  /** 스레드가 지워졌거나 비워졌을 때. */
  forget(tabId: string): void {
    const e = this.entries.get(tabId);
    if (!e) return;
    this.entries.delete(tabId);
    this.chars -= e.chars;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 테스트·진단용: 캐시가 붙든 문자 수. */
  get cachedChars(): number {
    return this.chars;
  }
}
