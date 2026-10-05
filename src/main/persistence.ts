// 파일 영속화. userData/workspaces.json (모델) + userData/threads/<tabId>.jsonl (이벤트 append).
// SQLite 는 Phase 4 에서 node:sqlite 로 갈지 결정 — better-sqlite3 는 쓰지 않는다 (PLAN 참조).

import fs from "node:fs";
import path from "node:path";
import { isInsideRel } from "./path-within";
import type { ChatEvent } from "@shared/chat-events";
import type { ProviderRateLimitDto } from "@shared/ipc";
import { emptyModel, type WorkspaceModel } from "@shared/workspace-model";
import { mt } from "./i18n";
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_COUNT, isChatImageMime, toHistoryImages, type StoredChatImage } from "./chat-attachments";

/** 탭마다 남겨 두는 "비운 대화" 보관본 수. 되돌아갈 만큼은 남기되 무한히 쌓이지는 않게. */
const MAX_CLEARED_ARCHIVES = 10;

/** 프롬프트 큐 항목의 디스크 형태. 이미지는 base64 를 빼고 경로만 둔다(첨부 파일은 이미 userData 에 있다). */
export interface PersistedPrompt {
  id: string;
  text: string;
  images: StoredChatImage[];
  userEvent: ChatEvent;
}

const FLUSH_DELAY_MS = 40;
/** 프롬프트 큐 파일 상한 — 항목 20개 × 20k 자 + 이미지 메타를 넉넉히 덮는다. */
const QUEUE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const QUEUE_MAX_ITEMS = 20;

export class Store {
  private readonly modelPath: string;
  private readonly threadsDir: string;
  private readonly attentionPath: string;
  private readonly buffers = new Map<string, string[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dir: string) {
    this.modelPath = path.join(dir, "workspaces.json");
    this.threadsDir = path.join(dir, "threads");
    this.attentionPath = path.join(dir, "attention.json");
  }

  // ===== 확인하지 않은 응답 =====
  // 앱을 껐다 켜도 남아야 한다. 안 그러면 "안 본 것" 표시가 업데이트 한 번에 사라져 믿을 수 없게 된다.

  saveAttention(map: Record<string, string>): void {
    try {
      if (Object.keys(map).length === 0) {
        fs.rmSync(this.attentionPath, { force: true });
        return;
      }
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.attentionPath, JSON.stringify(map), "utf8");
    } catch (e) {
      console.error("[store] attention 저장 실패:", e);
    }
  }

  loadAttention(): Record<string, string> {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.attentionPath, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, string> = {};
      for (const [k, kind] of Object.entries(v as Record<string, unknown>)) if (typeof kind === "string") out[k] = kind;
      return out;
    } catch {
      return {};
    }
  }

  // ===== model =====

  loadModel(): WorkspaceModel {
    if (!fs.existsSync(this.modelPath)) return emptyModel();
    try {
      const raw = fs.readFileSync(this.modelPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkspaceModel>;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.workspaces)) {
        return {
          version: 1,
          workspaces: parsed.workspaces,
          tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
          openTabIds: Array.isArray(parsed.openTabIds) ? parsed.openTabIds : [],
          activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null,
        };
      }
      throw new Error(mt("main.error.badWorkspacesFile"));
    } catch (e) {
      // 손상된 파일은 백업하고 빈 모델로 시작 — 사용자가 수동 복구할 수 있게 원본 보존.
      const backup = `${this.modelPath}.broken-${Date.now()}`;
      try {
        fs.renameSync(this.modelPath, backup);
      } catch {}
      console.error(`[store] workspaces.json 손상. 백업: ${backup}`, e);
      return emptyModel();
    }
  }

  /** 임시 파일에 쓰고 rename — 쓰는 중에 죽어도 반쪽 파일이 남지 않게. */
  saveModel(model: WorkspaceModel): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.modelPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(model, null, 2), "utf8");
    fs.renameSync(tmp, this.modelPath);
  }

  // ===== 인앱 세션 표시 (사용량 대시보드의 인앱/터미널 구분) =====

  private inAppPath(): string {
    return path.join(this.dir, "inapp-sessions.json");
  }

  loadInAppSessions(): Set<string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.inAppPath(), "utf8"));
      return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  markInAppSession(sessionId: string): void {
    const set = this.loadInAppSessions();
    if (set.has(sessionId)) return;
    set.add(sessionId);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.inAppPath(), JSON.stringify([...set]), "utf8");
    } catch (e) {
      console.error("[store] inapp-sessions 저장 실패:", e);
    }
  }

  // ===== 구독 한도 관측값 (rate-limits.json) — 앱 재시작 후에도 마지막 값을 보여 주기 위해 =====

  loadRateLimits(): Record<string, ProviderRateLimitDto> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, "rate-limits.json"), "utf8"));
      return raw && typeof raw === "object" ? (raw as Record<string, ProviderRateLimitDto>) : {};
    } catch {
      return {};
    }
  }

  saveRateLimit(provider: string, limit: ProviderRateLimitDto): void {
    const all = { ...this.loadRateLimits(), [provider]: limit };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, "rate-limits.json"), JSON.stringify(all, null, 2), "utf8");
    } catch (e) {
      console.error("[store] rate-limits 저장 실패:", e);
    }
  }

  // ===== 작은 설정 JSON (settings.json) =====

  loadSettings<T extends object>(defaults: T): T {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, "settings.json"), "utf8"));
      return { ...defaults, ...(raw && typeof raw === "object" ? raw : {}) };
    } catch {
      return { ...defaults };
    }
  }

  saveSettings(settings: object): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  }

  /** userData/pricing.json — 있으면 기본 가격표를 대체한다. 없거나 깨지면 null. */
  loadPricing<T>(): T | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, "pricing.json"), "utf8"));
      return Array.isArray(raw) ? (raw as T) : null;
    } catch {
      return null;
    }
  }

  // ===== threads =====

  threadPath(tabId: string): string {
    return path.join(this.threadsDir, `${safeName(tabId)}.jsonl`);
  }

  /** 이벤트를 버퍼에 쌓고 잠시 뒤 한 번에 append 한다 (text_delta 가 초당 수십 개라서). */
  appendEvent(tabId: string, event: ChatEvent): void {
    const buf = this.buffers.get(tabId) ?? [];
    buf.push(JSON.stringify(event));
    this.buffers.set(tabId, buf);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffers.size === 0) return;
    fs.mkdirSync(this.threadsDir, { recursive: true });
    for (const [tabId, lines] of this.buffers) {
      try {
        fs.appendFileSync(this.threadPath(tabId), `${lines.join("\n")}\n`, "utf8");
      } catch (e) {
        console.error(`[store] thread append 실패 (${tabId}):`, e);
      }
    }
    this.buffers.clear();
  }

  /** 스레드 파일의 mtime·크기(검색 인덱스의 캐시 키). 아직 안 내려간 버퍼가 있으면 먼저 내린다. 파일이 없으면 null. */
  threadStat(tabId: string): { mtimeMs: number; size: number } | null {
    if (this.buffers.has(tabId)) this.flush();
    try {
      const st = fs.statSync(this.threadPath(tabId));
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  readEvents(tabId: string): ChatEvent[] {
    // 아직 디스크에 안 내려간 버퍼가 있으면 먼저 내린다.
    if (this.buffers.has(tabId)) this.flush();
    const p = this.threadPath(tabId);
    if (!fs.existsSync(p)) return [];
    const out: ChatEvent[] = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ChatEvent);
      } catch {
        // 마지막 줄이 잘렸을 수 있다(강제 종료). 그 줄만 버린다.
      }
    }
    return out;
  }

  /** 비운 대화의 보관본. 파일명으로만 찾으므로 살아 있는 스레드(`<tabId>.jsonl`)와 섞이지 않는다. */
  clearedPath(tabId: string, ts: number): string {
    return path.join(this.threadsDir, `${safeName(tabId)}.cleared-${ts}.jsonl`);
  }

  /** 탭마다 최근 것만 남긴다. 안 두면 비울 때마다 쌓여 userData 가 계속 커진다. */
  private pruneCleared(tabId: string, keep = MAX_CLEARED_ARCHIVES): void {
    const prefix = `${safeName(tabId)}.cleared-`;
    let names: string[];
    try {
      names = fs.readdirSync(this.threadsDir).filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl"));
    } catch {
      return;
    }
    // 이름에 박힌 시각으로 정렬한다 — mtime 은 복사·백업으로 바뀐다.
    names.sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep)))
      try {
        fs.rmSync(path.join(this.threadsDir, n), { force: true });
      } catch {}
  }

  /**
   * 대화 비우기: 기록은 지우지 않고 옆에 보관한다. CLI 의 /clear 도 이전 세션을 디스크에 남긴다 —
   * 지워 버리면 이름만 같고 하는 일이 다른 명령이 된다. 세션 id 는 보관본 안의 session 이벤트에 들어 있어
   * 따로 적어 두지 않아도 되돌아갈 길이 남는다.
   *
   * 대기 중인 지시·인계서·첨부는 진행 중이던 상태라 함께 버린다(첨부 이미지의 dataUrl 은 보관본에 있다).
   */
  resetThread(tabId: string): void {
    this.buffers.delete(tabId);
    try {
      const live = this.threadPath(tabId);
      if (fs.existsSync(live)) fs.renameSync(live, this.clearedPath(tabId, Date.now()));
      this.pruneCleared(tabId);
      fs.rmSync(this.queuePath(tabId), { force: true });
      fs.rmSync(this.handoffPath(tabId), { force: true });
      // 첨부는 attachments/<tabId>/ 에 쌓인다(Codex local_image 입력·큐 복원용).
      if (safeName(tabId) === tabId) fs.rmSync(path.join(this.attachmentsDir(), tabId), { recursive: true, force: true });
    } catch {}
  }

  // ===== handoff (전환·압축 때 만든 인계서 — 다음 메시지에 실려 나갈 때까지 보관) =====

  handoffPath(tabId: string): string {
    return path.join(this.threadsDir, `${safeName(tabId)}.handoff.txt`);
  }

  /**
   * 인계서는 다음 메시지가 나갈 때까지만 살면 되지만, 그 사이에 앱이 꺼지면 맥락이
   * 통째로 사라진다. 만드는 데 턴 하나가 드는 글이라 메모리에만 두지 않는다.
   */
  saveHandoffPrefix(tabId: string, prefix: string | null): void {
    const p = this.handoffPath(tabId);
    try {
      if (!prefix) {
        fs.rmSync(p, { force: true });
        return;
      }
      fs.mkdirSync(this.threadsDir, { recursive: true });
      fs.writeFileSync(`${p}.tmp`, prefix, "utf8");
      fs.renameSync(`${p}.tmp`, p);
    } catch (e) {
      console.error(`[store] handoff 저장 실패 (${tabId}):`, e);
    }
  }

  loadHandoffPrefix(tabId: string): string | null {
    try {
      const text = fs.readFileSync(this.handoffPath(tabId), "utf8");
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  // ===== prompt queue (턴 진행 중 써 둔 다음 지시들 — 앱을 껐다 켜도 남는다) =====

  queuePath(tabId: string): string {
    return path.join(this.threadsDir, `${safeName(tabId)}.queue.json`);
  }

  /** 비어 있으면 파일을 지운다. 쓰기는 임시 파일 → rename 으로 끊김 없이. */
  savePromptQueue(tabId: string, items: PersistedPrompt[]): void {
    const p = this.queuePath(tabId);
    try {
      if (items.length === 0) {
        fs.rmSync(p, { force: true });
        return;
      }
      fs.mkdirSync(this.threadsDir, { recursive: true });
      // base64 는 두 군데(images[].base64, userEvent.images[].dataUrl)에 있다 — 둘 다 빼고 복원 때 파일에서 다시 만든다.
      const slim = items.map((it) => ({
        ...it,
        images: it.images.map((im) => ({ ...im, base64: "" })),
        userEvent: it.userEvent.type === "user_message" && it.userEvent.images ? { ...it.userEvent, images: [] } : it.userEvent,
      }));
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(slim), "utf8");
      fs.renameSync(`${p}.tmp`, p);
    } catch (e) {
      console.error(`[store] prompt queue 저장 실패 (${tabId}):`, e);
    }
  }

  /**
   * 이미지 base64 는 저장된 파일에서 다시 읽는다. 파일이 없어진 이미지는 뺀다.
   * 파일은 main 이 쓴 것이지만 디스크에 있는 동안 바뀔 수 있으므로 믿지 않는다: 크기·개수 상한, 이미지 경로는 첨부 디렉토리 안의
   * 보통 파일만, MIME 재검사. 어긋나는 항목은 조용히 뺀다.
   */
  loadPromptQueue(tabId: string): PersistedPrompt[] {
    const p = this.queuePath(tabId);
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      return [];
    }
    if (size > QUEUE_FILE_MAX_BYTES) {
      console.error(`[store] prompt queue 파일이 너무 큽니다 (${tabId}): ${size}B`);
      return [];
    }
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      // 이미지를 첨부한 적이 없으면 첨부 디렉토리가 없다 — 그래도 텍스트 지시는 복원해야 한다.
      let attachmentsDir: string | null = null;
      try {
        attachmentsDir = fs.realpathSync(this.attachmentsDir());
      } catch {
        attachmentsDir = null;
      }
      return raw
        .slice(0, QUEUE_MAX_ITEMS)
        .filter(
          (it): it is PersistedPrompt =>
            !!it && typeof it === "object" && typeof (it as PersistedPrompt).id === "string" && typeof (it as PersistedPrompt).text === "string" && !!(it as PersistedPrompt).userEvent,
        )
        .map((it) => {
          const images = attachmentsDir
            ? (Array.isArray(it.images) ? it.images : []).slice(0, CHAT_IMAGE_MAX_COUNT).flatMap((im) => this.reloadImage(im, attachmentsDir!))
            : [];
          // 기록용 user_message 의 dataUrl 도 파일에서 다시 만든다(디스크의 값은 믿지 않는다)
          const userEvent =
            it.userEvent.type === "user_message"
              ? { ...it.userEvent, ...(images.length > 0 ? { images: toHistoryImages(images) } : { images: undefined }) }
              : it.userEvent;
          if (userEvent.type === "user_message" && userEvent.images === undefined) delete (userEvent as { images?: unknown }).images;
          return { id: it.id.slice(0, 64), text: it.text.slice(0, 20_000), userEvent, images };
        });
    } catch (e) {
      console.error(`[store] prompt queue 손상 (${tabId}):`, e);
      return [];
    }
  }

  attachmentsDir(): string {
    return path.join(this.dir, "attachments");
  }

  /** 첨부 디렉토리 안의 보통 파일이고 크기·MIME 이 맞을 때만 다시 읽는다. */
  private reloadImage(im: unknown, attachmentsDir: string): StoredChatImage[] {
    if (!im || typeof im !== "object") return [];
    const { name, mime, filePath } = im as Partial<StoredChatImage>;
    if (typeof name !== "string" || typeof filePath !== "string" || !isChatImageMime(mime)) return [];
    try {
      const real = fs.realpathSync(filePath);
      const rel = path.relative(attachmentsDir, real);
      if (!rel || !isInsideRel(rel)) return [];
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > CHAT_IMAGE_MAX_BYTES) return [];
      return [{ name: name.slice(0, 255), mime, filePath: real, base64: fs.readFileSync(real).toString("base64") }];
    } catch {
      return [];
    }
  }

  deleteThread(tabId: string): void {
    this.resetThread(tabId);
  }
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
