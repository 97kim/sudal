import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./persistence";
import { SearchIndex } from "./search-index";

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sudal-search-"));
  const database = join(dir, "search.sqlite");
  const store = new Store(dir);
  const index = new SearchIndex(database);
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const thread = (tabId: string) => ({ tabId, file: store.threadPath(tabId) });
  return { database, store, index, thread };
}

test("SearchIndex reuses unchanged text and invalidates appends, replacements, and removals", t => {
  const { store, index, thread } = fixture(t);
  const tabs = [thread("t1")];
  store.appendEvent("t1", { type: "user_message", id: "u1", ts: 1, text: "첫 번째 질문 Hello" });
  store.appendEvent("t1", { type: "text_delta", blockId: "b1", ts: 2, text: "World " });
  store.appendEvent("t1", { type: "text_delta", blockId: "b1", ts: 2, text: "wide" });
  store.flush();
  assert.equal(index.search(tabs, "hello")[0]?.hits[0]?.blockId, "u1");
  const read = t.mock.method(fs, "readSync");
  assert.equal(index.search(tabs, "WORLD WIDE")[0]?.hits[0]?.blockId, "b1");
  assert.equal(read.mock.callCount(), 0, "a cache hit does not read the source JSONL");

  store.appendEvent("t1", { type: "user_message", id: "u2", ts: 3, text: "두 번째" });
  store.flush();
  assert.equal(index.search(tabs, "두 번째")[0]?.hits[0]?.blockId, "u2");
  const content = fs.readFileSync(tabs[0].file, "utf8");
  const { atime, mtime } = fs.statSync(tabs[0].file);
  fs.writeFileSync(tabs[0].file + ".new", content.replace("Hello", "Later"));
  fs.utimesSync(tabs[0].file + ".new", atime, mtime);
  fs.renameSync(tabs[0].file + ".new", tabs[0].file);
  assert.deepEqual(index.search(tabs, "hello"), []);
  assert.equal(index.search(tabs, "LATER")[0]?.hits[0]?.blockId, "u1");

  store.deleteThread("t1");
  assert.deepEqual(index.search(tabs, "later"), []);
});

test("SearchIndex persists large text indexes, then removes cleared and deleted tabs", t => {
  const { database, store, index, thread } = fixture(t);
  const large = thread("large");
  const small = thread("small");
  store.appendEvent("small", { type: "user_message", id: "small-1", ts: 1, text: "needle in small tab" });
  for (let i = 0; i < 6; i++) {
    store.appendEvent("large", { type: "tool_result", toolUseId: `tool-${i}`, ts: i, output: "x".repeat(2 * 1024 * 1024), isError: false });
  }
  store.appendEvent("large", { type: "user_message", id: "large-last", ts: 8, text: "needle in large tab" });
  store.flush();
  assert.deepEqual(index.search([large, small], "needle").map(result => result.hits[0].blockId), ["large-last", "small-1"]);
  index.close();

  const reopened = new SearchIndex(database);
  try {
    const read = t.mock.method(fs, "readSync");
    assert.equal(reopened.search([large, small], "IN LARGE")[0]?.hits[0]?.blockId, "large-last");
    assert.equal(read.mock.callCount(), 0, "the disk index survives a worker restart");

    reopened.forget("small");
    reopened.search([], "needle");
    const inspection = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(inspection.prepare("SELECT count(*) AS n FROM threads").get()?.n, 0);
      assert.equal(inspection.prepare("SELECT count(*) AS n FROM blocks").get()?.n, 0);
    } finally { inspection.close(); }
  } finally { reopened.close(); }
});

test("SearchIndex searches the same Unicode and JS string content on cache hits", t => {
  const { store, index, thread } = fixture(t);
  store.appendEvent("unicode", { type: "user_message", id: "u1", ts: 1, text: "한글 İ 😀 \ud800\u0000 end" });
  store.flush();
  const tabs = [thread("unicode")];
  const first = index.search(tabs, "\ud800\u0000");
  assert.equal(first[0]?.hits[0]?.blockId, "u1");
  assert.deepEqual(index.search(tabs, "\ud800\u0000"), first);
  assert.equal(index.search(tabs, "i\u0307 😀")[0]?.hits[0]?.blockId, "u1");
});

test("SearchIndex can read the source when the derived database cannot be opened", t => {
  const { database, store, thread } = fixture(t);
  store.appendEvent("tab", { type: "user_message", id: "u1", ts: 1, text: "source still available" });
  store.flush();
  const index = new SearchIndex(join(database, "missing-parent.sqlite"));
  assert.equal(index.search([thread("tab")], "still")[0]?.hits[0]?.blockId, "u1");
  index.close();
});

test("SearchIndex reads JSONL under a SQLite lock and reuses the intact cache when unlocked", t => {
  const { database, store, index, thread } = fixture(t);
  const tabs = [thread("tab")];
  store.appendEvent("tab", { type: "user_message", id: "u1", ts: 1, text: "needle" });
  store.flush();
  const expected = index.search(tabs, "needle");
  assert.equal(expected[0]?.hits[0]?.blockId, "u1");
  const read = t.mock.method(fs, "readSync");
  const lock = new DatabaseSync(database);
  try {
    lock.exec("BEGIN EXCLUSIVE");
    try {
      assert.deepEqual(index.search(tabs, "needle"), expected);
      assert.ok(read.mock.callCount() > 0, "read the source instead of the locked cache");
      assert.doesNotThrow(() => index.forget("tab"));
    } finally { lock.exec("ROLLBACK"); }
  } finally { lock.close(); }

  read.mock.resetCalls();
  assert.deepEqual(index.search(tabs, "needle"), expected);
  assert.equal(read.mock.callCount(), 0, "a lock does not invalidate or replace a healthy cache");
});

test("SearchIndex returns fresh results even when the cache write is locked", t => {
  const { database, store, index, thread } = fixture(t);
  const tabs = [thread("tab")];
  store.appendEvent("tab", { type: "user_message", id: "u1", ts: 1, text: "first" });
  store.flush();
  assert.equal(index.search(tabs, "first")[0]?.hits[0]?.blockId, "u1");
  store.appendEvent("tab", { type: "user_message", id: "u2", ts: 2, text: "second" });
  store.flush();

  const lock = new DatabaseSync(database);
  try {
    lock.exec("BEGIN IMMEDIATE");
    try { assert.equal(index.search(tabs, "second")[0]?.hits[0]?.blockId, "u2"); }
    finally { lock.exec("ROLLBACK"); }
  } finally { lock.close(); }

  assert.equal(index.search(tabs, "second")[0]?.hits[0]?.blockId, "u2");
  const read = t.mock.method(fs, "readSync");
  assert.equal(index.search(tabs, "second")[0]?.hits[0]?.blockId, "u2");
  assert.equal(read.mock.callCount(), 0, "the next unlocked search saves the fresh index");
});

for (const damage of ["header", "blocks page"] as const) {
  test(`SearchIndex rebuilds a corrupt SQLite ${damage} from JSONL`, t => {
    const { database, store, index, thread } = fixture(t);
    const tabs = [thread("tab")];
    store.appendEvent("tab", { type: "user_message", id: "u1", ts: 1, text: "recreate me" });
    store.flush();
    const expected = index.search(tabs, "recreate");
    assert.equal(expected[0]?.hits[0]?.blockId, "u1");
    index.close();

    let offset = 0;
    if (damage === "blocks page") {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const page = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'blocks'").get()?.rootpage);
        const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
        assert.ok(page > 1 && pageSize > 0);
        offset = (page - 1) * pageSize;
      } finally { db.close(); }
    }
    const fd = fs.openSync(database, "r+");
    try { fs.writeSync(fd, Buffer.from([0]), 0, 1, offset); }
    finally { fs.closeSync(fd); }

    assert.deepEqual(index.search(tabs, "recreate"), expected);
    const read = t.mock.method(fs, "readSync");
    assert.deepEqual(index.search(tabs, "recreate"), expected);
    assert.equal(read.mock.callCount(), 0, "the rebuilt SQLite index serves the next search");
  });
}

test("SearchIndex isolates an unreadable transcript from searchable tabs", t => {
  const { store, index, thread } = fixture(t);
  for (const tabId of ["unreadable", "healthy"]) {
    store.appendEvent(tabId, { type: "user_message", id: tabId, ts: 1, text: "needle" });
  }
  store.flush();
  const blocked = thread("unreadable");
  const open = fs.openSync;
  const mock = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === blocked.file) throw Object.assign(new Error("simulated access error"), { code: "EACCES" });
    return open(...args);
  });
  const tabs = [blocked, thread("healthy")];
  assert.deepEqual(index.search(tabs, "needle").map(result => result.tabId), ["healthy"]);
  mock.mock.restore();
  assert.deepEqual(index.search(tabs, "needle").map(result => result.tabId), ["unreadable", "healthy"]);
});
