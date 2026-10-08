// (서버 종류, 저장소 루트)마다 CodeMirror LSP 클라이언트 하나. 전송은 main 의 서버 프로세스와 IPC 로 이어진다.
// 렌더러는 탭 cwd 만 넘기고 루트(저장소 최상위)는 main 이 정한다 — 서로 다른 cwd 가 같은 루트면 같은 클라이언트를 쓴다.
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import { lspServerForPath, type LspServerId } from "@shared/lsp-servers";
import { fileUri } from "./doc-path";

interface Entry {
  id: string;
  root: string;
  client: LSPClient;
  handlers: Set<(value: string) => void>;
}

const byCwd = new Map<string, Promise<Entry | null>>();
const byId = new Map<string, Entry>();
const lostListeners = new Set<(client: LSPClient) => void>();
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  window.sudal.lsp.onMessage((id, message) => {
    const e = byId.get(id);
    if (e) for (const h of e.handlers) h(message);
  });
  window.sudal.lsp.onExit((id) => {
    const e = byId.get(id);
    if (!e) return;
    byId.delete(id);
    for (const [cwd, p] of byCwd) void p.then((v) => v === e && byCwd.delete(cwd));
    try {
      e.client.disconnect();
    } catch {
      /* 이미 끊김 */
    }
    // disconnect 뒤의 클라이언트는 요청이 영원히 대기한다 — 쓰던 에디터가 놓게 알린다. 다음 getLspClient 가 새로 띄운다.
    for (const l of lostListeners) l(e.client);
  });
}

/** 파일이 어느 서버의 담당인지(shared/lsp-servers). 없으면 null. */
export function lspTarget(path: string): { serverId: LspServerId; languageId: string } | null {
  const hit = lspServerForPath(path);
  return hit ? { serverId: hit.server.id, languageId: hit.languageId } : null;
}

export { fileUri };

/** 서버가 죽어 클라이언트를 더 쓸 수 없게 되면 호출된다. 해제 함수를 돌려준다. */
export function onLspClientLost(listener: (client: LSPClient) => void): () => void {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

/** 탭 cwd 의 (서버 종류별) 클라이언트를 얻는다(없으면 서버를 띄움). 서버가 없거나 실패하면 null — 에디터는 LSP 없이 동작한다. */
export function getLspClient(cwd: string, serverId: LspServerId): Promise<LSPClient | null> {
  wire();
  const key = `${serverId} ${cwd}`;
  let p = byCwd.get(key);
  if (!p) {
    p = (async () => {
      const r = await window.sudal.lsp.start(cwd, serverId);
      if (!r.ok) {
        console.warn("[lsp]", r.error);
        return null;
      }
      // 다른 cwd 가 이미 같은 서버(id)에 붙어 있으면 그 클라이언트를 같이 쓴다
      const existing = byId.get(r.id);
      if (existing) return existing;
      const handlers = new Set<(value: string) => void>();
      const transport: Transport = {
        send: (message) => window.sudal.lsp.send(r.id, message),
        subscribe: (h) => void handlers.add(h),
        unsubscribe: (h) => void handlers.delete(h),
      };
      // languageServerExtensions 에 완성·hover·시그니처·정의로 이동·참조·이름 변경·진단(publishDiagnostics 수신 능력 포함)이 들어 있다.
      const client = new LSPClient({ rootUri: fileUri(r.root), timeout: 8000, extensions: languageServerExtensions() });
      const entry: Entry = { id: r.id, root: r.root, client, handlers };
      byId.set(r.id, entry);
      client.connect(transport);
      return entry;
    })();
    byCwd.set(key, p);
    // 실패(null)는 캐시하지 않는다 — 서버를 설치한 뒤 다음 파일부터 다시 시도할 수 있게
    void p.then((e) => e === null && byCwd.get(key) === p && byCwd.delete(key));
  }
  return p.then((e) => e?.client ?? null);
}
