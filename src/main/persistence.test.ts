import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEvent } from "../shared/chat-events";
import { addWorkspace, createTab, emptyModel } from "../shared/workspace-model";
import { Store } from "./persistence";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-store-"));
  return { dir, store: new Store(dir) };
}

test("모델 저장/로드 라운드트립, 없으면 빈 모델", () => {
  const { store } = tmpStore();
  assert.deepEqual(store.loadModel(), emptyModel());
  let m = addWorkspace(emptyModel(), "/r", 1, "w").model;
  m = createTab(m, "w", 2, "t").model;
  store.saveModel(m);
  assert.deepEqual(store.loadModel(), m);
});

test("손상된 workspaces.json 은 백업 후 빈 모델", () => {
  const { dir, store } = tmpStore();
  fs.writeFileSync(path.join(dir, "workspaces.json"), "{not json", "utf8");
  assert.deepEqual(store.loadModel(), emptyModel());
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("workspaces.json.broken-")));
});

test("이벤트 append 는 버퍼링되고 readEvents 가 flush 후 읽는다; 잘린 줄은 버린다", () => {
  const { store } = tmpStore();
  const ev: ChatEvent[] = [
    { type: "user_message", ts: 1, id: "u", text: "hi" },
    { type: "text_delta", ts: 2, blockId: "b", text: "안" },
    { type: "text_delta", ts: 3, blockId: "b", text: "녕" },
  ];
  for (const e of ev) store.appendEvent("tab1", e);
  assert.ok(!fs.existsSync(store.threadPath("tab1")));
  assert.deepEqual(store.readEvents("tab1"), ev);
  fs.appendFileSync(store.threadPath("tab1"), '{"type":"status","ts":4,"sta', "utf8");
  assert.deepEqual(store.readEvents("tab1"), ev);
  store.resetThread("tab1");
  assert.deepEqual(store.readEvents("tab1"), []);
});

test("탭 id 는 파일명으로 안전하게 바뀐다", () => {
  const { store } = tmpStore();
  assert.match(path.basename(store.threadPath("a/b c")), /^a_b_c\.jsonl$/);
});

test("prompt queue: 첨부 디렉토리가 없어도(이미지를 붙인 적 없음) 텍스트 지시는 복원된다", async () => {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("./persistence");
  const dir = mkdtempSync(join(tmpdir(), "wb-queue-txt-"));
  const store = new Store(dir);
  const ev = { type: "user_message" as const, id: "u1", ts: 1, text: "hi" };
  store.savePromptQueue("t1", [{ id: "p1", text: "hi", images: [], userEvent: ev as never }]);
  assert.equal(existsSync(join(dir, "attachments")), false, "텍스트만 저장하면 첨부 디렉토리를 만들지 않는다");
  const loaded = store.loadPromptQueue("t1");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].text, "hi");
  assert.deepEqual(loaded[0].images, []);
  rmSync(dir, { recursive: true, force: true });
});

test("prompt queue: 저장은 base64 를 빼고, 복원은 파일에서 다시 읽으며, 없어진 이미지는 뺀다", async () => {
  const { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("./persistence");
  const dir = mkdtempSync(join(tmpdir(), "wb-queue-"));
  const store = new Store(dir);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "attachments", "t1"), { recursive: true });
  const img = join(dir, "attachments", "t1", "a.png");
  writeFileSync(img, Buffer.from([1, 2, 3]));
  const ev = { type: "user_message" as const, id: "u1", ts: 1, text: "hi" };
  const evImg = { ...ev, images: [{ dataUrl: "data:image/png;base64,AQID" }] };
  store.savePromptQueue("t1", [
    { id: "p1", text: "hi", images: [{ name: "a.png", mime: "image/png", base64: "AQID", filePath: img }], userEvent: evImg as never },
    { id: "p2", text: "gone", images: [{ name: "b.png", mime: "image/png", base64: "xx", filePath: join(dir, "missing.png") }], userEvent: evImg as never },
  ]);
  const onDisk = readFileSync(store.queuePath("t1"), "utf8");
  assert.equal(onDisk.includes("AQID"), false, "base64 는 images 에도 userEvent.images 에도 저장하지 않는다");
  const loaded = store.loadPromptQueue("t1");
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].images[0].base64, Buffer.from([1, 2, 3]).toString("base64"));
  assert.deepEqual((loaded[0].userEvent as { images?: { dataUrl: string }[] }).images, [{ dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` }], "기록용 dataUrl 은 파일에서 다시 만든다");
  assert.deepEqual(loaded[1].images, []);
  assert.equal("images" in (loaded[1].userEvent as object), false, "이미지가 사라진 항목은 dataUrl 도 없다");
  // 첨부 디렉토리 밖 경로·틀린 MIME 은 다시 읽지 않는다(파일이 있어도)
  const outside = join(dir, "secret.txt");
  writeFileSync(outside, "top secret");
  store.savePromptQueue("t1", [
    { id: "p9", text: "x", images: [{ name: "s.png", mime: "image/png", base64: "", filePath: outside }, { name: "a.png", mime: "text/plain" as never, base64: "", filePath: img }], userEvent: ev as never },
  ]);
  assert.deepEqual(store.loadPromptQueue("t1")[0].images, []);
  store.savePromptQueue("t1", []);
  assert.equal(existsSync(store.queuePath("t1")), false, "비면 파일을 지운다");
  store.savePromptQueue("t1", [{ id: "p3", text: "x", images: [], userEvent: ev as never }]);
  store.deleteThread("t1");
  assert.equal(existsSync(store.queuePath("t1")), false, "스레드 삭제와 함께 지운다");
  assert.equal(existsSync(join(dir, "attachments", "t1")), false, "첨부 디렉토리도 함께 지운다");
  rmSync(dir, { recursive: true, force: true });
});

test("인계서는 디스크에 남아 앱을 껐다 켜도 살아남는다", () => {
  const { dir, store } = tmpStore();
  assert.equal(store.loadHandoffPrefix("t1"), null);

  store.saveHandoffPrefix("t1", "## 인계서\n원래 요청: 버그 고치기");
  // 다른 Store 인스턴스 = 앱을 새로 띄운 것과 같다.
  assert.equal(new Store(dir).loadHandoffPrefix("t1"), "## 인계서\n원래 요청: 버그 고치기");

  // 다음 메시지에 실려 나갔으면 지운다 — 두 번 붙으면 안 된다.
  store.saveHandoffPrefix("t1", null);
  assert.equal(new Store(dir).loadHandoffPrefix("t1"), null);
});

test("대화를 비우면 인계서도 함께 지운다", () => {
  const { dir, store } = tmpStore();
  store.saveHandoffPrefix("t1", "옛 맥락");
  store.resetThread("t1");
  assert.equal(new Store(dir).loadHandoffPrefix("t1"), null);
});

test("대화를 비워도 기록은 보관한다 — CLI 의 /clear 처럼 되돌아갈 것을 남긴다", () => {
  const { store } = tmpStore();
  const dirOf = () => path.dirname(store.threadPath("tab1"));
  const archives = () =>
    fs.readdirSync(dirOf()).filter((n) => n.startsWith("tab1.cleared-") && n.endsWith(".jsonl"));

  store.appendEvent("tab1", { type: "user_message", ts: 1, id: "u1", text: "질문" } as ChatEvent);
  store.appendEvent("tab1", { type: "session", ts: 2, sessionId: "sess-1", provider: "claude" } as ChatEvent);
  store.flush?.();
  store.resetThread("tab1");

  assert.deepEqual(store.readEvents("tab1"), [], "살아 있는 스레드는 비워진다");
  assert.equal(archives().length, 1, "보관본이 하나 생긴다");
  // 세션 id 는 보관본 안에 있다 — 따로 적어 두지 않아도 되돌아갈 실마리가 남는다.
  const kept = fs.readFileSync(path.join(dirOf(), archives()[0]), "utf8");
  assert.ok(kept.includes("sess-1"), "보관본에 세션 id 가 들어 있다");
  assert.ok(kept.includes("질문"), "보관본에 대화가 들어 있다");
});

test("보관본은 탭마다 최근 것만 남는다", () => {
  const { store } = tmpStore();
  const dirOf = () => path.dirname(store.threadPath("tab1"));
  const archives = () => fs.readdirSync(dirOf()).filter((n) => n.startsWith("tab1.cleared-"));

  for (let i = 0; i < 13; i += 1) {
    store.appendEvent("tab1", { type: "user_message", ts: i, id: `u${i}`, text: `말${i}` } as ChatEvent);
    store.flush?.();
    // 파일명이 시각이라 같은 밀리초에 몰리면 덮어쓴다 — 테스트에서만 자리를 벌린다.
    const live = store.threadPath("tab1");
    if (fs.existsSync(live)) fs.renameSync(live, store.clearedPath("tab1", 1_700_000_000_000 + i));
  }
  assert.equal(archives().length, 13, "직접 만든 보관본 13개");
  store.appendEvent("tab1", { type: "user_message", ts: 99, id: "u99", text: "마지막" } as ChatEvent);
  store.flush?.();
  store.resetThread("tab1");
  assert.equal(archives().length, 10, "정리하고 나면 10개만 남는다");
});

test("control cursor starts after buffered history and advances only over new bytes", () => {
  const { store } = tmpStore();
  const event: ChatEvent = { type: "user_message", id: "a", ts: 1, text: "한글" };
  store.appendEvent("tab", event);
  const poll = store.controlEventCursor("tab");
  assert.deepEqual(poll(), []);
  store.appendEvent("tab", event);
  assert.deepEqual(poll(), [event]);
  assert.deepEqual(poll(), []);
});
