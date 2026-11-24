import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  attachmentFileName,
  buildClaudeUserMessage,
  buildCodexInput,
  decodeChatImage,
  extensionForMime,
  prepareChatImages,
  saveChatImages,
  toDataUrl,
  toHistoryImages,
  type ChatImageInput,
} from "./chat-attachments";

const PNG_BASE64 = Buffer.from("fake-png-bytes").toString("base64");

function image(overrides: Partial<ChatImageInput> = {}): ChatImageInput {
  return {
    name: "shot.png",
    mime: "image/png",
    base64: PNG_BASE64,
    ...overrides,
  } as ChatImageInput;
}

test("extensionForMime: 지원 mime 만 확장자를 준다", () => {
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("image/jpeg"), "jpg");
  assert.equal(extensionForMime("image/webp"), "webp");
  assert.equal(extensionForMime("image/gif"), null);
  assert.equal(extensionForMime("application/pdf"), null);
});

test("attachmentFileName: <timestamp>-<i>.<ext>", () => {
  assert.equal(attachmentFileName(1700000000000, 0, "image/png"), "1700000000000-0.png");
  assert.equal(attachmentFileName(1700000000000, 2, "image/jpeg"), "1700000000000-2.jpg");
});

test("decodeChatImage: 정상 base64 는 원본 바이트로 디코드", () => {
  const got = decodeChatImage("shot.png", PNG_BASE64);
  assert.equal(got.ok, true);
  assert.equal(got.ok && got.bytes.toString(), "fake-png-bytes");
});

test("decodeChatImage: data: 접두사는 거부 (계약은 순수 base64)", () => {
  const got = decodeChatImage("shot.png", `data:image/png;base64,${PNG_BASE64}`);
  assert.equal(got.ok, false);
  assert.match(got.ok ? "" : got.error, /순수 base64/);
});

test("decodeChatImage: base64 가 아닌 문자열은 거부", () => {
  const got = decodeChatImage("shot.png", "not!!base64!!");
  assert.equal(got.ok, false);
  assert.match(got.ok ? "" : got.error, /base64/);
});

test("decodeChatImage: 빈 데이터는 거부", () => {
  assert.equal(decodeChatImage("shot.png", "   ").ok, false);
  assert.equal(decodeChatImage("shot.png", undefined).ok, false);
});

test("decodeChatImage: 6MB 초과는 거부, 상한 이하는 통과", () => {
  const overBase64 = Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1).toString("base64");
  const over = decodeChatImage("big.png", overBase64);
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.error, /6MB/);

  const atLimit = decodeChatImage("edge.png", Buffer.alloc(CHAT_IMAGE_MAX_BYTES).toString("base64"));
  assert.equal(atLimit.ok, true);
});

test("prepareChatImages: images 미지정/빈 배열은 빈 결과", () => {
  assert.deepEqual(prepareChatImages(undefined), { ok: true, prepared: [] });
  assert.deepEqual(prepareChatImages([]), { ok: true, prepared: [] });
});

test("prepareChatImages: 4장 초과는 거부", () => {
  const many = Array.from({ length: CHAT_IMAGE_MAX_COUNT + 1 }, () => image());
  const got = prepareChatImages(many);
  assert.equal(got.ok, false);
  assert.match(got.ok ? "" : got.error, /최대 4장/);
});

test("prepareChatImages: 4장까지는 통과", () => {
  const got = prepareChatImages(Array.from({ length: CHAT_IMAGE_MAX_COUNT }, () => image()));
  assert.equal(got.ok, true);
  assert.equal(got.ok ? got.prepared.length : 0, CHAT_IMAGE_MAX_COUNT);
});

test("prepareChatImages: 지원하지 않는 mime 은 전체 거부", () => {
  const got = prepareChatImages([image(), image({ mime: "image/gif" as never })]);
  assert.equal(got.ok, false);
  assert.match(got.ok ? "" : got.error, /지원하지 않는 이미지 형식/);
});

test("prepareChatImages: 이름이 없으면 표시용 기본 이름을 붙인다", () => {
  const got = prepareChatImages([image({ name: "  " })]);
  assert.equal(got.ok, true);
  assert.equal(got.ok ? got.prepared[0].input.name : "", "이미지 1");
});

test("saveChatImages: <threadId>/<timestamp>-<i>.<ext> 로 저장", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-attach-"));
  const prepared = prepareChatImages([
    image(),
    image({ name: "photo.jpg", mime: "image/jpeg" }),
  ]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const got = saveChatImages({
    baseDir,
    threadId: "thread-1",
    images: prepared.prepared,
    now: 1700000000000,
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;

  assert.deepEqual(
    got.stored.map((s) => path.relative(baseDir, s.filePath)),
    [
      path.join("thread-1", "1700000000000-0.png"),
      path.join("thread-1", "1700000000000-1.jpg"),
    ],
  );
  assert.equal(fs.readFileSync(got.stored[0].filePath).toString(), "fake-png-bytes");

  const second = prepareChatImages([image({ base64: Buffer.from("second message image").toString("base64") })]);
  assert.ok(second.ok);
  const alsoSaved = saveChatImages({ baseDir, threadId: "thread-1", images: second.prepared, now: 1700000000000 });
  assert.ok(alsoSaved.ok);
  assert.notEqual(alsoSaved.stored[0].filePath, got.stored[0].filePath);
  assert.equal(fs.readFileSync(alsoSaved.stored[0].filePath, "utf8"), "second message image");
  assert.equal(fs.readFileSync(got.stored[0].filePath, "utf8"), "fake-png-bytes");
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("saveChatImages: 쓰기 실패는 에러로 표면화", () => {
  // 파일을 baseDir 로 지정 → mkdir 이 ENOTDIR 로 실패한다.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chat-attach-")), "blocker");
  fs.writeFileSync(file, "x");
  const prepared = prepareChatImages([image()]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const got = saveChatImages({ baseDir: file, threadId: "t", images: prepared.prepared });
  assert.equal(got.ok, false);
  assert.match(got.ok ? "" : got.error, /이미지 첨부 저장에 실패/);
});

test("saveChatImages: 빈 배열이면 디렉토리도 만들지 않는다", () => {
  const baseDir = path.join(os.tmpdir(), `chat-attach-none-${Date.now()}`);
  const got = saveChatImages({ baseDir, threadId: "t", images: [] });
  assert.deepEqual(got, { ok: true, stored: [] });
  assert.equal(fs.existsSync(baseDir), false);
});

test("toDataUrl / toHistoryImages: mime 별 data URL 조립", () => {
  assert.equal(
    toDataUrl({ mime: "image/webp", base64: "AAAA" }),
    "data:image/webp;base64,AAAA",
  );
  assert.deepEqual(
    toHistoryImages([
      { mime: "image/png", base64: "AAAA" },
      { mime: "image/jpeg", base64: "BBBB" },
    ]),
    [{ dataUrl: "data:image/png;base64,AAAA" }, { dataUrl: "data:image/jpeg;base64,BBBB" }],
  );
});

test("buildClaudeUserMessage: 이미지 블록이 앞, 텍스트가 뒤", () => {
  const msg = buildClaudeUserMessage(
    [
      { mime: "image/png", base64: "AAAA" },
      { mime: "image/jpeg", base64: "BBBB" },
    ],
    "이 화면 뭐가 문제야?",
  );
  assert.equal(msg.type, "user");
  assert.equal(msg.parent_tool_use_id, null);
  assert.equal(msg.message.role, "user");
  assert.deepEqual(msg.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
    { type: "text", text: "이 화면 뭐가 문제야?" },
  ]);
});

test("buildClaudeUserMessage: 이미지가 없으면 텍스트 블록만", () => {
  const msg = buildClaudeUserMessage([], "안녕");
  assert.deepEqual(msg.message.content, [{ type: "text", text: "안녕" }]);
});

test("buildCodexInput: local_image 경로가 앞, 텍스트가 뒤", () => {
  assert.deepEqual(buildCodexInput(["/tmp/a.png", "/tmp/b.jpg"], "설명해줘"), [
    { type: "local_image", path: "/tmp/a.png" },
    { type: "local_image", path: "/tmp/b.jpg" },
    { type: "text", text: "설명해줘" },
  ]);
});
