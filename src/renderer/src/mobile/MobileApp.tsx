// 휴대폰 화면: 연결(6자리 코드) → 탭 목록 → 대화. 대화 상태는 앱 창과 같은 리듀서(reduceSession)로 만든다.
// 토큰은 이 출처(스킴·주소·포트)의 localStorage 에만 둔다 — 쿠키처럼 다른 포트·다른 사이트 요청에 저절로 붙지 않는다.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatEvent } from "@shared/chat-events";
import { msgText } from "@shared/i18n/msg";
import { reduceSession, replaySession, type Block, type SessionState } from "@shared/session-state";
import { Icon, type IconName } from "../components/Icon";
import { Preview } from "../components/PermissionPrompt";

interface Tab {
  id: string;
  title: string;
  workspace: string | null;
  cwd: string | null;
  provider: string | null;
  status: string;
  waiting: boolean;
}

const TOKEN_KEY = "sudal.mobile.token";
class Unpaired extends Error {}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY) ?? "";
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) throw new Unpaired();
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? String(r.status));
  return data;
}

/**
 * 실시간 스트림. EventSource 는 헤더를 못 붙여서 fetch 로 읽는다. 끊기면 간격을 늘려 가며(3초→최대 30초, 무작위로 흩어) 다시 붙는다.
 * 같은 기기에서 페이지를 여럿 열어 서버가 이 연결을 밀어내면(replaced) 화면에 다시 보일 때까지 붙지 않는다 — 페이지끼리 서로 밀어내며 돌지 않게.
 */
function useStream(onEvent: (type: string, data: unknown) => void, onState: (s: "open" | "closed" | "unpaired") => void) {
  const cb = useRef({ onEvent, onState });
  cb.current = { onEvent, onState };
  useEffect(() => {
    let stop = false;
    let ctrl: AbortController | null = null;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        const t = setTimeout(res, ms);
        wake = () => {
          clearTimeout(t);
          res();
        };
      });
    const run = async () => {
      let fails = 0;
      while (!stop) {
        ctrl = new AbortController();
        let replaced = false;
        let openedAt = 0;
        try {
          const r = await fetch("/api/stream", { headers: { authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}` }, signal: ctrl.signal });
          if (r.status === 401) {
            cb.current.onState("unpaired");
            return;
          }
          if (!r.ok || !r.body) throw new Error(String(r.status));
          openedAt = Date.now();
          cb.current.onState("open");
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const type = /^event: (.+)$/m.exec(chunk)?.[1];
              const data = /^data: (.*)$/m.exec(chunk)?.[1];
              if (type === "replaced") replaced = true;
              else if (type && data !== undefined) cb.current.onEvent(type, JSON.parse(data));
            }
          }
        } catch {
          /* 아래에서 다시 붙는다 */
        }
        if (stop) return;
        // 붙자마자 끊기기를 되풀이하면 간격이 늘어야 한다 — 한동안 잘 이어졌을 때만 처음 간격으로 돌린다
        if (openedAt && Date.now() - openedAt > 10_000) fails = 0;
        cb.current.onState("closed");
        if (replaced) {
          // 숨은 페이지는 다시 보일 때까지(onVisible 이 깨운다), 보이는 페이지는 30초 뒤에
          await sleep(document.visibilityState === "visible" ? 30_000 : 24 * 3600_000);
        } else {
          await sleep(Math.min(30_000, 3000 * 2 ** fails) * (0.5 + Math.random() / 2));
          fails += 1;
        }
      }
    };
    void run();
    // 화면이 다시 보이면(휴대폰 잠금 해제 등) 바로 다시 붙는다
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      ctrl?.abort();
      wake?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      ctrl?.abort();
      wake?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

export function MobileApp() {
  const [paired, setPaired] = useState(() => !!localStorage.getItem(TOKEN_KEY));
  if (!paired) return <PairScreen onPaired={() => setPaired(true)} />;
  const unpair = () => {
    localStorage.removeItem(TOKEN_KEY);
    setPaired(false);
  };
  return <Paired onUnpaired={unpair} />;
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ua = navigator.userAgent;
    const name = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : "";
    const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim(), name }) });
    const data = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
    if (r.ok && data.token) {
      localStorage.setItem(TOKEN_KEY, data.token);
      onPaired();
    } else setError(data.error === "locked" ? t("mobile.pairLocked") : t("mobile.pairWrong"));
  };
  const [focused, setFocused] = useState(true);
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto flex min-h-[100dvh] max-w-sm flex-col px-7 pb-[max(env(safe-area-inset-bottom),28px)] pt-12">
      <div className="flex-1">
        <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-tint text-accent">
          <Icon name="laptop" size={26} />
        </div>
        <h1 className="mb-2.5 text-[26px] font-bold">{t("mobile.pairTitle")}</h1>
        <p className="mb-7 leading-relaxed text-muted">{t("mobile.pairHint")}</p>
        {/* 칸 6개는 그림이고, 실제 입력은 그 위에 투명하게 겹친 input 하나다 — 붙여넣기·코드 자동 채우기가 그대로 된다 */}
        <div className="relative">
          <div className="flex gap-2" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className={`mono flex h-[60px] flex-1 items-center justify-center rounded-xl border bg-panel font-semibold ${
                  focused && i === Math.min(code.length, 5) ? "border-2 border-accent" : "border-line"
                }`}
                // .mono 가 글자 크기를 고정해서 크기는 직접 준다
                style={{ fontSize: 26 }}
              >
                {code[i] ?? ""}
              </div>
            ))}
          </div>
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
              setError(null);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            aria-label={t("mobile.pairTitle")}
            className="absolute inset-0 h-full w-full opacity-0"
            data-mobile-code
          />
        </div>
        {error ? (
          <p className="mt-4 text-[14px] text-err">{error}</p>
        ) : (
          <p className="mt-4 flex items-center gap-1.5 text-[13px] text-muted-2">
            <Icon name="clock" size={14} />
            {t("mobile.pairExpiry")}
          </p>
        )}
      </div>
      <button disabled={code.length !== 6} className="h-[52px] w-full rounded-[14px] bg-primary text-[16px] font-semibold text-on-primary disabled:opacity-40">
        {t("mobile.pairButton")}
      </button>
      <p className="mt-3.5 flex items-center justify-center gap-1.5 text-[12px] text-muted-2">
        <Icon name="lock" size={13} />
        {t("mobile.pairSecure")}
      </p>
    </form>
  );
}

function Paired({ onUnpaired }: { onUnpaired: () => void }) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [tabId, setTabId] = useState<string | null>(() => location.hash.slice(1) || null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [conn, setConn] = useState<"open" | "closed">("open");
  const tabRef = useRef(tabId);
  tabRef.current = tabId;

  const guard = useCallback(
    (e: unknown) => {
      if (e instanceof Unpaired) onUnpaired();
    },
    [onUnpaired],
  );
  const loadTabs = useCallback(() => api<{ tabs: Tab[] }>("/api/tabs").then((r) => setTabs(r.tabs), guard), [guard]);
  const loadTab = useCallback(
    (id: string) =>
      api<{ events: ChatEvent[]; truncated: boolean }>(`/api/tabs/${id}/events`).then((r) => {
        if (tabRef.current !== id) return;
        setSession(replaySession(r.events));
        setTruncated(r.truncated);
      }, guard),
    [guard],
  );

  useEffect(() => void loadTabs(), [loadTabs]);
  useEffect(() => {
    const onHash = () => setTabId(location.hash.slice(1) || null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    setSession(null);
    if (tabId) void loadTab(tabId);
  }, [tabId, loadTab]);

  // 탭 상태가 바뀌는 이벤트가 몰려도 목록은 잠깐 모아 한 번만 다시 받는다
  const tabsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTabsSoon = useCallback(() => {
    if (tabsTimer.current) return;
    tabsTimer.current = setTimeout(() => {
      tabsTimer.current = null;
      void loadTabs();
    }, 800);
  }, [loadTabs]);

  useStream(
    (type, data) => {
      if (type === "tabs") return refreshTabsSoon();
      if (type !== "chat") return;
      const { tabId: id, event } = data as { tabId: string; event: ChatEvent };
      if (id === tabRef.current) setSession((s) => (s ? reduceSession(s, event) : s));
      if (/^(status|turn_result|permission_|session|error)/.test(event.type)) refreshTabsSoon();
    },
    (state) => {
      if (state === "unpaired") return onUnpaired();
      // 다시 붙으면 끊긴 사이 놓친 것을 받는다
      if (state === "open" && conn === "closed") {
        void loadTabs();
        if (tabRef.current) void loadTab(tabRef.current);
      }
      setConn(state);
    },
  );

  const tab = tabs?.find((x) => x.id === tabId) ?? null;
  return (
    <div className="flex min-h-[100dvh] flex-col">
      {conn === "closed" && (
        <div className="sticky top-0 z-30 flex items-center gap-2 bg-warn-bg px-4 py-2.5 pt-[max(env(safe-area-inset-top),10px)] text-[13px] text-warn">
          <Icon name="alert" size={15} />
          {t("mobile.disconnected")}
        </div>
      )}
      {tabId ? (
        <ChatScreen tabId={tabId} tab={tab} session={session} truncated={truncated} onBack={() => (location.hash = "")} onError={guard} />
      ) : (
        <TabList tabs={tabs} online={conn === "open"} />
      )}
    </div>
  );
}

const STATUS_KEYS = {
  idle: "mobile.status.idle",
  running: "mobile.status.running",
  queued: "mobile.status.queued",
  waiting_permission: "mobile.status.waiting_permission",
  error: "mobile.status.error",
} as const;

function statusLabel(t: TFunction, status: string): string {
  const key = STATUS_KEYS[status as keyof typeof STATUS_KEYS];
  return key ? t(key) : status;
}

const providerName = (p: string | null) => (p === "codex" ? "Codex" : p === "claude" ? "Claude" : null);
const isWorking = (status: string) => status === "running" || status === "queued";

/** 탭 상태 점. 작업 중은 도는 고리, 응답 필요는 노랑, 오류는 빨강. */
function StatusDot({ status, waiting }: { status: string; waiting: boolean }) {
  if (waiting || status === "waiting_permission") return <span className="h-2 w-2 shrink-0 rounded-full bg-warn" />;
  if (isWorking(status)) return <span className="spin h-2.5 w-2.5 shrink-0 rounded-full border-2 border-accent border-r-transparent" />;
  return <span className={`h-2 w-2 shrink-0 rounded-full ${status === "error" ? "bg-err" : "bg-muted-2"}`} />;
}

function TabList({ tabs, online }: { tabs: Tab[] | null; online: boolean }) {
  const { t } = useTranslation();
  // 응답이 필요한 탭은 따로 맨 위에 모으고, 나머지는 워크스페이스별로 처음 나온 순서대로 묶는다
  const groups: { key: string; title: string; warn: boolean; tabs: Tab[] }[] = [];
  const waiting = tabs?.filter((x) => x.waiting) ?? [];
  if (waiting.length) groups.push({ key: "!waiting", title: t("mobile.needsYou"), warn: true, tabs: waiting });
  for (const tab of tabs ?? []) {
    if (tab.waiting) continue;
    const key = tab.workspace ?? "";
    let g = groups.find((x) => !x.warn && x.key === key);
    if (!g) groups.push((g = { key, title: tab.workspace ?? t("mobile.noWorkspace"), warn: false, tabs: [] }));
    g.tabs.push(tab);
  }
  return (
    <main className="px-4 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),12px)]">
      <header className="mb-6 flex items-center justify-between px-1 pt-3">
        <h1 className="text-[30px] font-bold">{t("mobile.tabs")}</h1>
        <span className="flex items-center gap-1.5 rounded-full bg-panel px-2.5 py-1.5 text-[12px] text-muted">
          <span className={`h-[7px] w-[7px] rounded-full ${online ? "bg-ok" : "bg-warn"}`} />
          {online ? t("mobile.connected") : t("mobile.offline")}
        </span>
      </header>
      {tabs && tabs.length === 0 && <p className="px-1 text-muted">{t("mobile.noTabs")}</p>}
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <section key={g.key}>
            <h2 className={`mb-2 flex items-center gap-1.5 px-1 text-[13px] font-semibold ${g.warn ? "text-warn" : "text-muted"}`}>
              {g.warn && <Icon name="alert" size={13} />}
              {g.title}
              <span className="font-normal text-muted-2">{g.tabs.length}</span>
            </h2>
            <div className={`overflow-hidden rounded-2xl ${g.warn ? "border border-warn/25 bg-warn-bg" : "bg-panel"}`}>
              {g.tabs.map((tab) => (
                <a
                  key={tab.id}
                  href={`#${tab.id}`}
                  className={`flex min-h-[60px] items-center gap-3 px-4 py-3 active:bg-panel-2 [&:not(:last-child)]:border-b ${g.warn ? "border-warn/20" : "border-line"}`}
                  data-mobile-tab={tab.id}
                >
                  <StatusDot status={tab.status} waiting={tab.waiting} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{tab.title}</span>
                    <span className="mt-0.5 block truncate text-[12px] text-muted">
                      {[providerName(tab.provider), g.warn ? tab.workspace : null].filter(Boolean).join(" · ")}
                      {(tab.provider || (g.warn && tab.workspace)) && <span className="text-muted-2"> · </span>}
                      <span className={tab.waiting ? "text-warn" : isWorking(tab.status) ? "text-accent" : tab.status === "error" ? "text-err" : ""}>
                        {tab.waiting ? t("mobile.waiting") : statusLabel(t, tab.status)}
                      </span>
                    </span>
                  </span>
                  <Icon name="chevronRight" size={18} className="text-muted-2" />
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function ChatScreen({
  tabId,
  tab,
  session,
  truncated,
  onBack,
  onError,
}: {
  tabId: string;
  tab: Tab | null;
  session: SessionState | null;
  truncated: boolean;
  onBack: () => void;
  onError: (e: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const onScroll = () => (stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [session]);

  const status = session?.status ?? tab?.status ?? "idle";
  const busy = status === "running" || status === "queued" || status === "waiting_permission";
  const send = async () => {
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/tabs/${tabId}/send`, { text: msg });
      setText("");
      stick.current = true;
    } catch (e) {
      onError(e);
      setError(t("mobile.sendFailed", { error: (e as Error).message }));
    } finally {
      setSending(false);
    }
  };
  const answer = (requestId: string, allow: boolean) => void api(`/api/tabs/${tabId}/permission`, { requestId, allow }).catch(onError);
  const perm = session?.pendingPermission ?? null;
  const permCwd = (typeof perm?.input.cwd === "string" && perm.input.cwd.trim()) || tab?.cwd || tab?.workspace || null;

  const waitingPerm = status === "waiting_permission" || !!perm;
  const provider = providerName(tab?.provider ?? null);
  // 글이 늘면 입력칸도 늘어난다(최대 높이는 CSS 가 막는다)
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (input.current) grow(input.current);
  }, [text]);

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-bg/95 pb-2 pl-1.5 pr-3 pt-[max(env(safe-area-inset-top),6px)] backdrop-blur">
        <button onClick={onBack} className="flex min-h-11 items-center gap-0.5 px-1.5 text-[16px] text-accent">
          <Icon name="chevronLeft" size={22} />
          {t("mobile.back")}
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[15px] font-semibold">{tab?.title ?? ""}</div>
          <div className="flex items-center justify-center gap-1.5 text-[12px] text-muted">
            <StatusDot status={status} waiting={waitingPerm} />
            <span className={waitingPerm ? "text-warn" : ""}>{[provider, statusLabel(t, status)].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        {/* 제목이 가운데 오도록 뒤로 버튼만큼 비워 둔다 */}
        <span className="w-[52px] shrink-0" />
      </header>
      <main className="flex flex-1 flex-col justify-end gap-3.5 px-4 py-4">
        {truncated && <p className="text-center text-[12px] text-muted-2">{t("mobile.earlier")}</p>}
        {session?.blocks.map((b) => <BlockView key={`${b.kind}:${b.id}`} block={b} />)}
        {busy && session?.reasoning && (
          <p className="flex items-center gap-2 text-[13px] text-muted-2">
            <Icon name="sparkles" size={14} />
            <span className="shimmer min-w-0 truncate italic">{session.reasoning.split("\n").filter(Boolean).pop()}</span>
          </p>
        )}
        <div ref={bottom} />
      </main>
      <footer className="sticky bottom-0 border-t border-line bg-bg/95 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-2.5 backdrop-blur">
        {error && <p className="mb-2 px-1 text-[13px] text-err">{error}</p>}
        <div className="flex items-end gap-2 rounded-3xl border border-line bg-panel py-1.5 pl-4 pr-1.5">
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder={t("mobile.placeholder")}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-[7px] leading-snug text-fg outline-none placeholder:text-muted-2"
            data-mobile-input
          />
          {busy && (
            <button
              onClick={() => void api(`/api/tabs/${tabId}/abort`, {}).catch(onError)}
              aria-label={t("mobile.stop")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-panel-2"
              data-mobile-stop
            >
              <span className="h-3 w-3 rounded-[3px] bg-fg" />
            </button>
          )}
          {(!busy || text.trim()) && (
            <button
              onClick={() => void send()}
              disabled={!text.trim() || sending}
              aria-label={t("mobile.send")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-30"
              data-mobile-send
            >
              <Icon name="arrowUp" size={18} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </footer>
      {perm && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-overlay/70">
          <div className="max-h-[85dvh] overflow-auto rounded-t-[28px] border-t border-line bg-panel px-5 pb-[max(env(safe-area-inset-bottom),24px)] pt-2.5" data-mobile-permission>
            <div className="mx-auto mb-4 h-[5px] w-9 rounded-full bg-line" />
            <div className="mb-3 flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warn-bg text-warn">
                <Icon name="shield" size={20} />
              </span>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-warn">{t("mobile.permissionTitle")}</div>
                <div className="text-[17px] font-semibold">{msgText(i18n, perm.titleMsg, perm.title ?? t("mobile.tool", { name: perm.tool }))}</div>
              </div>
            </div>
            {perm.description && <p className="mb-3 text-[14px] leading-relaxed text-muted">{perm.description}</p>}
            {/* 앱 창과 같은 미리 보기 — 명령만이 아니라 고칠 파일·diff·쓰기 허용 범위·모르는 도구의 입력 전체까지 보여 준다 */}
            <div className="mb-3 max-h-[45dvh] overflow-auto text-[12.5px]" data-mobile-permission-preview>
              <Preview tool={perm.tool} input={perm.input} />
            </div>
            {/* 요청에 실행 폴더가 따로 있으면(Codex) 그게 실제로 실행되는 곳이다. 없을 때만 탭 폴더 */}
            {permCwd && (
              <p className="mb-4 flex items-start gap-1.5 text-[12px] text-muted-2" data-mobile-permission-cwd>
                <Icon name="folder" size={13} className="mt-px" />
                <span className="min-w-0 break-all">{permCwd}</span>
              </p>
            )}
            <div className="flex gap-2.5">
              <button onClick={() => answer(perm.requestId, false)} className="h-[52px] flex-1 rounded-[14px] border border-line bg-panel-2 text-[16px] font-semibold">
                {t("mobile.deny")}
              </button>
              <button onClick={() => answer(perm.requestId, true)} className="h-[52px] flex-1 rounded-[14px] bg-primary text-[16px] font-semibold text-on-primary">
                {t("mobile.allow")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const TOOL_ICONS: Record<string, IconName> = { Read: "file", Grep: "search", Glob: "search", Edit: "edit", MultiEdit: "edit", Write: "edit", Bash: "terminal", WebFetch: "globe", WebSearch: "globe" };

function BlockView({ block: b }: { block: Block }) {
  const { i18n } = useTranslation();
  switch (b.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-accent-tint px-3.5 py-2.5 leading-snug">{b.text}</div>
        </div>
      );
    case "text":
      return (
        <div className="md break-words leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>
        </div>
      );
    case "tool": {
      const input = b.input as Record<string, unknown> | null;
      const first = input ? Object.values(input).find((v) => typeof v === "string" && v.trim()) : undefined;
      // 경로는 앞부분보다 파일 이름이 중요해서 뒤 두 마디만 보인다
      const arg = typeof first === "string" ? first.split("\n")[0].replace(/^\S*\/([^/\s]+\/[^/\s]+)$/, "$1").slice(0, 120) : "";
      return (
        <div className="-my-1.5 flex items-center gap-2 rounded-[10px] bg-panel px-2.5 py-2 text-[13px]">
          <Icon name={TOOL_ICONS[b.name] ?? "braces"} size={14} className="text-muted" />
          <span className="shrink-0 font-medium">{b.name}</span>
          <span className="mono min-w-0 flex-1 truncate text-[12px] text-muted">{arg}</span>
          {b.result ? (
            <Icon name={b.result.isError ? "x" : "check"} size={14} className={b.result.isError ? "text-err" : "text-ok"} />
          ) : (
            <span className="spin h-3 w-3 shrink-0 rounded-full border-2 border-accent border-r-transparent" />
          )}
        </div>
      );
    }
    case "error":
      return <p className="text-[13px] text-err">{msgText(i18n, b.msg, b.message)}</p>;
    case "notice":
      return <p className="text-[13px] text-muted">{msgText(i18n, b.msg, b.message)}</p>;
    case "turn":
      return b.isError ? <p className="text-[13px] text-err">{msgText(i18n, b.errorMsg, b.errorText ?? "")}</p> : <div className="border-t border-line" />;
    default:
      return null;
  }
}
