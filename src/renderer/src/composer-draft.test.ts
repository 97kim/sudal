import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrateKv, kvGet } from "./kv-store";
import { clearComposerDraft, codeSpan, dropComposerFiles, flushComposerDrafts, loadComposerDraft, loadComposerFiles, onComposerFilesDrop, pruneComposerDrafts, saveComposerDraft, saveComposerFiles, withAttachedFiles } from "./composer-draft";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stored = (tabId: string) => kvGet(`composerDraft.${tabId}`);

test("입력창 초안: 탭별로 저장·복원하고, 빈 글·너무 긴 글은 지우고, 전송(clear) 하면 없어진다", async () => {
  hydrateKv({ "composerDraft.restored": "지난번 글" }, () => {});
  assert.equal(loadComposerDraft("restored"), "지난번 글", "시작 때 받은 값을 읽는다");
  assert.equal(loadComposerDraft("t1"), "");
  saveComposerDraft("t1", "빠른 입력");
  assert.equal(loadComposerDraft("t1"), "빠른 입력", "저장이 예약된 동안에도(탭 왕복) 최신 입력을 읽는다");
  saveComposerDraft("t1", "쓰다 ");
  saveComposerDraft("t1", "쓰다 만 글");
  saveComposerDraft("t2", "다른 탭");
  await wait(400);
  assert.equal(stored("t1"), "쓰다 만 글", "마지막 값만 남는다");
  assert.equal(stored("t2"), "다른 탭");
  saveComposerDraft("t2", "   ");
  await wait(400);
  assert.equal(stored("t2"), null, "공백뿐이면 저장소에서 지운다(캐시는 입력창 그대로)");
  saveComposerDraft("t2", "x".repeat(200_001));
  await wait(400);
  assert.equal(stored("t2"), null, "너무 길면 저장하지 않는다");
  saveComposerDraft("t1", "아직 안 씀");
  clearComposerDraft("t1"); // 전송·탭 삭제
  await wait(400);
  assert.equal(loadComposerDraft("t1"), "");
  assert.equal(stored("t1"), null, "예약된 저장도 취소된다");
  // 모델에 없는 탭의 초안은 정리된다
  saveComposerDraft("gone", "지워질 글");
  saveComposerDraft("kept", "남을 글");
  await wait(400);
  pruneComposerDrafts(new Set(["kept"]));
  assert.equal(stored("gone"), null);
  assert.equal(stored("restored"), null, "시작 때 받았어도 모델에 없으면 지운다");
  assert.equal(stored("kept"), "남을 글");
  // 종료 직전 flush 는 예약된 저장을 실제로 쓴다
  saveComposerDraft("kept", "마지막 입력");
  flushComposerDrafts();
  assert.equal(stored("kept"), "마지막 입력");
});

test("첨부 파일: 보낼 글 끝에 목록으로, 경로는 백틱으로 감싼다(띄어쓰기·백틱도 한 덩어리)", () => {
  assert.equal(withAttachedFiles("이거 봐 줘", [], "첨부한 파일:"), "이거 봐 줘");
  assert.equal(
    withAttachedFiles("이거 봐 줘", [{ path: "/Users/me/My Report.pdf", name: "My Report.pdf" }, { path: "/tmp/a`b.txt", name: "a`b.txt" }], "첨부한 파일:"),
    "이거 봐 줘\n\n첨부한 파일:\n- `/Users/me/My Report.pdf`\n- ``/tmp/a`b.txt``",
  );
  // 글 없이 파일만 보내도 된다
  assert.equal(withAttachedFiles("", [{ path: "/a", name: "a" }], "첨부한 파일:"), "첨부한 파일:\n- `/a`");
});

test("첨부 파일: 탭별로 저장·복원하고, 모양이 틀린 저장값은 버리고, 지운 탭은 정리한다", () => {
  hydrateKv({ "composerFiles.bad": "{oops", "composerFiles.old": JSON.stringify([{ path: "/x", name: "x" }]) }, () => {});
  assert.deepEqual(loadComposerFiles("bad"), []);
  saveComposerFiles("t1", [{ path: "/a.ts", name: "a.ts" }]);
  assert.deepEqual(loadComposerFiles("t1"), [{ path: "/a.ts", name: "a.ts" }]);
  saveComposerFiles("t1", []);
  assert.equal(kvGet("composerFiles.t1"), null);
  pruneComposerDrafts(new Set(["t1"]));
  assert.equal(kvGet("composerFiles.old"), null);
});

test("채팅 화면에 놓은 파일은 그 탭 입력창으로만 간다", () => {
  const got: string[] = [];
  const off = onComposerFilesDrop("t1", (files) => got.push(...files.map((f) => f.name)));
  assert.equal(dropComposerFiles("t2", [new File(["x"], "a.png")]), false, "입력창이 없는 탭");
  assert.equal(dropComposerFiles("t1", [new File(["x"], "b.txt")]), true);
  off();
  assert.equal(dropComposerFiles("t1", [new File(["x"], "c.txt")]), false);
  assert.deepEqual(got, ["b.txt"]);
});

test("codeSpan: 경로 글자를 바꾸지 않고, 백틱이 들어도 한 코드 구간으로", () => {
  assert.equal(codeSpan("/a b"), "`/a b`");
  assert.equal(codeSpan("/a``b"), "```/a``b```");
  assert.equal(codeSpan("`x`"), "`` `x` ``");
});
