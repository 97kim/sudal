import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { collectTexts, searchBlocks, type IndexedBlock, type SearchHit } from "@shared/transcript-search";
import { readChatEvents } from "./jsonl-reader";

export interface SearchThread { tabId: string; file: string }
export interface TabSearchHits { tabId: string; hits: SearchHit[] }

function isCorruptDatabase(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === 11 || primary === 26; // SQLITE_CORRUPT or SQLITE_NOTADB, including extended codes.
}

function threadStamp(file: string) {
  try {
    const { dev, ino, birthtimeNs, ctimeNs, mtimeNs, size } = statSync(file, { bigint: true });
    return { key: [dev, ino, birthtimeNs, ctimeNs, mtimeNs, size].join(":"), size: Number(size) };
  } catch { return undefined; }
}

function* searchRows(rows: Iterable<Omit<IndexedBlock, "lower">>): Iterable<IndexedBlock> {
  for (const row of rows) yield { ...row, lower: row.text.toLowerCase() };
}

/** A derived disk index owned by the search worker. The JSONL remains the source of truth. */
export class SearchIndex {
  private db: DatabaseSync | undefined;

  constructor(private readonly cachePath: string) {}

  private connect(): void {
    closeSync(openSync(this.cachePath, "a", 0o600));
    const db = new DatabaseSync(this.cachePath);
    try {
      db.exec(`
        PRAGMA auto_vacuum = FULL;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS threads (tab_id TEXT PRIMARY KEY, stamp TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS blocks (
          tab_id TEXT NOT NULL REFERENCES threads(tab_id) ON DELETE CASCADE,
          position INTEGER NOT NULL, block_id TEXT NOT NULL, kind TEXT NOT NULL,
          ts REAL NOT NULL, body BLOB NOT NULL, PRIMARY KEY(tab_id, position)
        ) WITHOUT ROWID;
      `);
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private openCache(): void {
    if (this.db) return;
    try { this.connect(); }
    catch (error) { if (isCorruptDatabase(error)) this.rebuildCache(); }
  }

  private rebuildCache(): void {
    // This database is derived from JSONL. Ordinary contention and I/O errors
    // never remove it, and a failed rebuild leaves the source search available.
    try {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(this.cachePath + suffix, { force: true });
      this.connect();
    } catch { /* Retry opening on the next operation. */ }
  }

  private useCache<T>(fn: (db: DatabaseSync) => T): T | undefined {
    if (!this.db) return;
    try { return fn(this.db); }
    catch (error) {
      this.close();
      if (isCorruptDatabase(error)) this.rebuildCache();
    }
  }

  search(threads: SearchThread[], query: string): TabSearchHits[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    this.openCache();
    this.useCache(db => {
      const keep = new Set(threads.map(thread => thread.tabId));
      const remove = db.prepare("DELETE FROM threads WHERE tab_id = ?");
      for (const row of db.prepare("SELECT tab_id FROM threads").all()) {
        if (!keep.has(row.tab_id as string)) remove.run(row.tab_id);
      }
    });

    const results: TabSearchHits[] = [];
    for (const thread of threads) {
      const hits = this.searchThread(thread, q);
      if (hits.length) results.push({ tabId: thread.tabId, hits });
      if (results.length >= 60) break;
    }
    return results;
  }

  private searchThread({ tabId, file }: SearchThread, query: string): SearchHit[] {
    const stamp = threadStamp(file);
    if (!stamp) {
      this.removeCachedThread(tabId);
      return [];
    }
    const cached = this.useCache(db => {
      const row = db.prepare("SELECT stamp FROM threads WHERE tab_id = ?").get(tabId);
      if (row?.stamp === stamp.key) return searchBlocks(searchRows(this.cachedRows(db, tabId)), query, 20);
    });
    if (cached !== undefined) return cached;

    let rows: ReturnType<typeof collectTexts>;
    let hits: SearchHit[];
    try {
      rows = collectTexts(readChatEvents(file, 0, stamp.size));
      hits = searchBlocks(searchRows(rows), query, 20);
    } catch (error) {
      // A missing, inaccessible, or unreadable thread must not hide other tabs.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.removeCachedThread(tabId);
      return [];
    }
    if (this.db && threadStamp(file)?.key === stamp.key) this.save(tabId, stamp.key, rows);
    return hits;
  }

  private *cachedRows(db: DatabaseSync, tabId: string): Iterable<Omit<IndexedBlock, "lower">> {
    const statement = db.prepare("SELECT block_id, kind, ts, body FROM blocks WHERE tab_id = ? ORDER BY position");
    for (const row of statement.iterate(tabId)) {
      const body = row.body as Uint8Array;
      yield {
        blockId: row.block_id as string,
        kind: row.kind as IndexedBlock["kind"],
        ts: row.ts as number,
        text: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf16le"),
      };
    }
  }

  private save(tabId: string, stamp: string, rows: ReturnType<typeof collectTexts>): void {
    this.useCache(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM threads WHERE tab_id = ?").run(tabId);
        db.prepare("INSERT INTO threads(tab_id, stamp) VALUES (?, ?)").run(tabId, stamp);
        const insert = db.prepare("INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?)");
        // UTF-16 keeps JS substring semantics, including isolated surrogates at a tool-output boundary.
        rows.forEach(({ blockId, kind, ts, text }, position) => {
          insert.run(tabId, position, blockId, kind, ts, Buffer.from(text, "utf16le"));
        });
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
        throw error;
      }
    });
  }

  forget(tabId: string): void {
    this.openCache();
    this.removeCachedThread(tabId);
  }

  private removeCachedThread(tabId: string): void {
    this.useCache(db => db.prepare("DELETE FROM threads WHERE tab_id = ?").run(tabId));
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
