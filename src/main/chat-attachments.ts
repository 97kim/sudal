// AI 채팅 이미지 첨부의 순수 로직 — 검증 / 파일명 결정 / 디스크 저장 / 프로바이더별 입력 조립.
// Electron 의존성을 두지 않아 node --test 로 그대로 돌릴 수 있다. index.ts 에는 IPC 배선만 남긴다.

import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { mt } from "./i18n";

// 타입만 사용하므로 `import(...)` 타입 구문으로 가져온다.
type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
type CodexUserInput = import("@openai/codex-sdk").UserInput;

/** 한 번에 첨부 가능한 장수. 초과분은 잘라내지 않고 거부한다 — 사용자가 빠진 걸 모르는 게 최악. */
export const CHAT_IMAGE_MAX_COUNT = 4;
/** base64 디코드 후 원본 바이트 기준 장당 상한. */
export const CHAT_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

export type ChatImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ChatImageInput {
  /** 표시용 파일명. 저장 경로에는 쓰지 않는다(경로 탈출·중복 방지). */
  name: string;
  mime: ChatImageMime;
  /** 순수 base64 — `data:` 접두사 없음. */
  base64: string;
}

export interface StoredChatImage {
  name: string;
  mime: ChatImageMime;
  base64: string;
  /** 디스크에 저장된 절대 경로. Codex 의 local_image 입력이 이 경로를 참조한다. */
  filePath: string;
}

const MIME_EXTENSIONS: Record<ChatImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isChatImageMime(mime: unknown): mime is ChatImageMime {
  return typeof mime === "string" && Object.hasOwn(MIME_EXTENSIONS, mime);
}

/** 지원 mime 이 아니면 null. 확장자는 mime 으로만 정한다 — 사용자 파일명은 신뢰하지 않는다. */
export function extensionForMime(mime: string): string | null {
  return isChatImageMime(mime) ? MIME_EXTENSIONS[mime] : null;
}

/** `<timestamp>-<i>.<ext>` — 같은 turn 의 여러 장이 인덱스로 구분된다. */
export function attachmentFileName(
  timestamp: number,
  index: number,
  mime: ChatImageMime,
): string {
  return `${timestamp}-${index}.${MIME_EXTENSIONS[mime]}`;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type DecodeResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

/**
 * base64 를 검증하며 디코드한다. Buffer.from(_, "base64") 는 잘못된 문자를 조용히 버리므로
 * 정규식으로 먼저 걸러야 깨진 파일이 디스크에 남지 않는다.
 */
export function decodeChatImage(name: string, base64: unknown): DecodeResult {
  if (typeof base64 !== "string" || !base64.trim()) {
    return { ok: false, error: mt("session.error.image.empty", { name }) };
  }
  const compact = base64.replace(/\s+/g, "");
  if (compact.startsWith("data:")) {
    return {
      ok: false,
      error: mt("session.error.image.dataPrefix", { name }),
    };
  }
  if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
    return { ok: false, error: mt("session.error.image.badBase64", { name }) };
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) {
    return { ok: false, error: mt("session.error.image.empty", { name }) };
  }
  if (bytes.length > CHAT_IMAGE_MAX_BYTES) {
    const mb = (bytes.length / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: mt("session.error.image.tooLarge", { name, max: CHAT_IMAGE_MAX_BYTES / 1024 / 1024, mb }),
    };
  }
  return { ok: true, bytes };
}

export type PreparedChatImage = { input: ChatImageInput; bytes: Buffer };
export type PrepareResult =
  | { ok: true; prepared: PreparedChatImage[] }
  | { ok: false; error: string };

/** 장수·mime·base64 를 한 번에 검증한다. 한 장이라도 실패하면 전체를 거부한다. */
export function prepareChatImages(images: unknown): PrepareResult {
  if (images === undefined || images === null) return { ok: true, prepared: [] };
  if (!Array.isArray(images)) {
    return { ok: false, error: mt("session.error.image.badFormat") };
  }
  if (images.length === 0) return { ok: true, prepared: [] };
  if (images.length > CHAT_IMAGE_MAX_COUNT) {
    return {
      ok: false,
      error: mt("session.error.image.tooMany", { max: CHAT_IMAGE_MAX_COUNT, requested: images.length }),
    };
  }

  const prepared: PreparedChatImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const raw = images[i] as Partial<ChatImageInput> | null;
    const name =
      raw && typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : mt("session.error.image.defaultName", { n: i + 1 });
    if (!raw || !isChatImageMime(raw.mime)) {
      return {
        ok: false,
        error: mt("session.error.image.badMime", { name }),
      };
    }
    const decoded = decodeChatImage(name, raw.base64);
    if (!decoded.ok) return { ok: false, error: decoded.error };
    prepared.push({
      input: { name, mime: raw.mime, base64: (raw.base64 as string).replace(/\s+/g, "") },
      bytes: decoded.bytes,
    });
  }
  return { ok: true, prepared };
}

export type SaveResult =
  | { ok: true; stored: StoredChatImage[] }
  | { ok: false; error: string };

/**
 * `<baseDir>/<threadId>/<timestamp>-<i>.<ext>` 로 저장한다.
 * 쓰기 실패는 삼키지 않고 그대로 올려보낸다 — 첨부가 빠진 채 질문이 전송되면 안 된다.
 */
export function saveChatImages({
  baseDir,
  threadId,
  images,
  now = Date.now(),
}: {
  baseDir: string;
  threadId: string;
  images: PreparedChatImage[];
  now?: number;
}): SaveResult {
  if (images.length === 0) return { ok: true, stored: [] };
  const dir = path.join(baseDir, threadId);
  const created: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stored = images.map(({ input, bytes }, i) => {
      const name = attachmentFileName(now, i, input.mime);
      let filePath = path.join(dir, name);
      let fd: number;
      try {
        fd = fs.openSync(filePath, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Two sends to the same tab can share a timestamp. Never replace the earlier attachment.
        filePath = path.join(dir, `${randomUUID()}-${name}`);
        fd = fs.openSync(filePath, "wx");
      }
      created.push(filePath);
      try {
        fs.writeFileSync(fd, bytes);
      } finally {
        fs.closeSync(fd);
      }
      return { name: input.name, mime: input.mime, base64: input.base64, filePath };
    });
    return { ok: true, stored };
  } catch (e) {
    discardChatImageFiles(created);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: mt("session.error.image.saveFailed", { detail: msg }) };
  }
}

/** Best-effort cleanup after a write or send fails. Preserve the original error. */
export function discardChatImageFiles(paths: string[]): void {
  for (const filePath of paths) {
    try { fs.unlinkSync(filePath); } catch { /* The original failure is reported by the caller. */ }
  }
}

/** 히스토리·렌더러 썸네일용 data URL. main 이 들고 있어야 렌더러 재렌더 시에도 남는다. */
export function toDataUrl(image: { mime: ChatImageMime; base64: string }): string {
  return `data:${image.mime};base64,${image.base64}`;
}

export function toHistoryImages(
  images: { mime: ChatImageMime; base64: string }[],
): { dataUrl: string }[] {
  return images.map((img) => ({ dataUrl: toDataUrl(img) }));
}

/**
 * Claude SDK 의 streaming input 용 user 메시지 1건.
 * 이미지 블록을 먼저 두고 텍스트를 뒤에 붙인다(모델이 "이 이미지에 대한 질문"으로 읽게).
 */
export function buildClaudeUserMessage(
  images: { mime: ChatImageMime; base64: string }[],
  text: string,
): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mime,
            data: img.base64,
          },
        })),
        { type: "text" as const, text },
      ],
    },
  };
}

/** Codex 는 base64 를 받지 않고 로컬 파일 경로(local_image)만 받는다. */
export function buildCodexInput(
  filePaths: string[],
  text: string,
): CodexUserInput[] {
  return [
    ...filePaths.map((p) => ({ type: "local_image" as const, path: p })),
    { type: "text" as const, text },
  ];
}
