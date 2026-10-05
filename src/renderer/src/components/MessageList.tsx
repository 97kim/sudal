import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clearReveal, onReveal, pendingReveal } from "../reveal";
import type { ForkPoint, SessionStatus } from "@shared/chat-events";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import { msgText } from "@shared/i18n/msg";
import type { Provider } from "@shared/ipc";
import type { Block, ReviewBlock } from "@shared/session-state";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { Logo } from "./Logo";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { VerifyCard } from "./VerifyCard";
import { FanoutCard } from "./FanoutCard";
import { OrchestrationCard } from "./OrchestrationCard";
import { formatElapsed, useNow } from "../hooks/useNow";

/** 위로 올린 직후 이만큼은 바닥에 있어도 다시 따라가지 않는다(막 떠나는 중). */
const UP_GRACE_MS = 300;

export function MessageList({
  tabId,
  blocks,
  status,
  provider,
  reasoning = "",
  onRerunVerify,
  onCompareFanout,
  onOpenOrchestration,
  turnStartedAt = null,
  sessionId = null,
  ambientFromBg = false,
  loading = false,
  queuedCount = 0,
}: {
  tabId: string;
  blocks: Block[];
  status: SessionStatus;
  /** 이 탭의 provider 세션 id — 백그라운드 작업이 어느 대화 것인지 잇는 열쇠. */
  sessionId?: string | null;
  /** 지금 도는 턴이 백그라운드 작업이 끝나 CLI 가 스스로 이어간 것이면 true. */
  ambientFromBg?: boolean;
  /** 지금 턴의 생각(reasoning) 텍스트 꼬리. "생각 중" 아래에 흘려 보여 준다. */
  reasoning?: string;
  provider: Provider;
  /** 검증 카드의 "다시 실행" — 그 카드의 명령들로 다시 돌린다. */
  onRerunVerify?: (commands: string[]) => void;
  /** 팬아웃 카드의 "비교" — 비교 오버레이를 연다. */
  onCompareFanout?: (fanoutId: string) => void;
  /** 오케스트레이션 카드의 "패널". */
  onOpenOrchestration?: (runId: string) => void;
  /** 지금 턴이 실제로 시작된 시각(큐 대기 제외). 없으면 마지막 사용자 메시지 시각. */
  turnStartedAt?: number | null;
  /** 기록을 아직 불러오는 중. 빈 대화와 구분해 "대화가 없다" 고 단정하지 않는다. */
  loading?: boolean;
  /** 응답 중에 보내 대기열에 있는 메시지 수. 목록에는 앞 응답이 끝난 뒤에야 나타난다. */
  queuedCount?: number;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  // 검색 결과에서 "이 블록으로": 예약된 블록이 이 탭의 것이고 화면에 생겼으면 스크롤 + 잠깐 강조.
  // 블록 목록이 바뀔 때마다(재생 진행) 다시 시도하므로 닫혀 있던 세션도 마운트 뒤 정상 이동한다.
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => onReveal(() => setRevealTick((n) => n + 1)), []);
  useEffect(() => {
    const blockId = pendingReveal(tabId);
    if (!blockId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(blockId)}"]`,
    );
    if (!el) return;
    clearReveal();
    el.scrollIntoView({ block: "center" });
    el.classList.add("reveal-flash");
    const t = setTimeout(() => el.classList.remove("reveal-flash"), 1600);
    return () => clearTimeout(t);
  }, [tabId, blocks, revealTick]);
  // 자동 스크롤: 사용자가 맨 아래에 있을 때만 따라간다. 위로 올려 읽는 중이면 새 블록(툴카드·응답)이 와도 끌어내리지 않는다 —
  // 자동으로 내려가는데 사람이 올리면 위아래로 튀기 때문. 예외는 사용자가 방금 보낸 메시지(자기 메시지는 보고 싶으니 맨 아래로).
  // 내용 높이가 바뀔 때(스트리밍·이미지·코드 하이라이트)도 같은 규칙으로 따라간다. "맨 아래로" pill 로 언제든 복귀.
  const stickToBottom = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 따라가는 중인지. false 면 "맨 아래로" pill 을 띄운다. */
  const [atBottom, setAtBottom] = useState(true);
  /** 사람이 마지막으로 위로 올리려 한 시각. 그 직후에 바닥에 붙어 있는 건 다시 따라갈 근거가 아니다(막 떠나는 중). */
  const userUpAt = useRef(0);
  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };
  const follow = () => {
    stickToBottom.current = true;
    setAtBottom(true);
  };
  /**
   * 올리자마자 바닥으로 돌아와 멈추면 scroll 이벤트가 더 오지 않는다 — 유예가 끝날 때 한 번 더 본다.
   * 지금 위치가 아니라 마지막 스크롤이 바닥에서 끝났는지로 본다. 글이 흐르면 그 사이에 바닥이 또 내려가 있다.
   */
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollAtEnd = useRef(true);
  /** 스크롤바를 잡고 있는 중. 그동안은 바닥에 닿아도 다시 따라가지 않는다 — 손을 뗄 때 정한다. */
  const draggingBar = useRef(false);
  /** 마지막 클릭이 이 목록 안이었나. 키보드 스크롤은 마지막으로 누른 스크롤 상자로 간다. */
  const pointerInside = useRef(false);
  const followIfAtEnd = () => {
    if (stickToBottom.current || draggingBar.current || !lastScrollAtEnd.current) return;
    follow();
    scrollToBottom();
  };
  useEffect(() => {
    const onUp = () => {
      if (!draggingBar.current) return;
      draggingBar.current = false;
      followIfAtEnd();
    };
    const onDown = (e: PointerEvent) => {
      pointerInside.current = !!containerRef.current?.contains(e.target as Node);
    };
    // 위로 가는 키. 입력창·에디터·터미널 안의 키는 목록을 움직이지 않으니 넘긴다.
    const onKey = (e: KeyboardEvent) => {
      if (!pointerInside.current || !stickToBottom.current) return;
      const up = e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey);
      const t = e.target as HTMLElement | null;
      if (!up || t?.closest("input, textarea, select, [contenteditable], .cm-editor, .xterm")) return;
      release();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      if (recheckTimer.current) clearTimeout(recheckTimer.current);
    };
  }, []);
  const release = () => {
    stickToBottom.current = false;
    userUpAt.current = performance.now();
    setAtBottom(false);
    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(() => {
      recheckTimer.current = null;
      followIfAtEnd();
    }, UP_GRACE_MS + 20);
  };

  // 턴이 돌고 있지만 모델이 아직 말을 시작하지 않은 구간에만 "생각 중 …" 표시:
  // 첫 토큰 전(마지막 블록이 사용자 메시지) 또는 도구 결과를 받은 직후. 글자가 흐르는 중, 도구가 실행 중,
  // 답은 끝났고 turn_result 만 기다리는 꼬리 구간에는 띄우지 않는다.
  const last = blocks[blocks.length - 1];
  const thinking =
    status === "running" &&
    (!last ||
      last.kind === "user" ||
      (last.kind === "tool" && last.result !== undefined));
  // 턴 시작 시각 = 마지막 사용자 메시지. "생각 중" 옆의 경과 시간에 쓴다.
  let lastUserTs: number | null = null;
  let lastUserId: string | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "user") {
      lastUserTs = b.ts;
      lastUserId = b.id;
      break;
    }
  }

  // 사람이 휠을 위로 굴리면 스크롤이 일어나기 전에 바로 따라가기를 끈다. scroll 이벤트까지 기다리면 그 사이에
  // 글이 자라 ResizeObserver 가 먼저 끌어내리고, 사람은 올리고 앱은 내려서 화면이 떨린다.
  // 안쪽의 스크롤 상자(명령 출력 등)가 휠을 먹는 경우는 목록을 올린 게 아니니 넘긴다.
  const onWheel = (e: React.WheelEvent) => {
    // 더 올라갈 데가 없으면(맨 위이거나 넘치지 않는 짧은 대화) 목록은 그대로다.
    if (e.deltaY >= 0 || !containerRef.current || containerRef.current.scrollTop <= 0) return;
    for (let n = e.target as HTMLElement | null; n && n !== containerRef.current; n = n.parentElement) {
      if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) return;
    }
    release();
  };
  // 스크롤바를 누르는 순간도 휠과 같다. 스크롤바를 누르면 이벤트 대상이 목록 상자 자신이고, 위치는 내용 폭 밖이다.
  const onPointerDown = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el || e.target !== el || e.clientX < el.getBoundingClientRect().left + el.clientWidth) return;
    draggingBar.current = true;
    release();
  };
  // 사람이 올렸는지는 입력(휠·스크롤바·키)으로만 판단한다. scroll 이벤트의 위치 변화로 판단하면 안 된다 —
  // 위쪽 내용이 줄 때 브라우저가 스스로 위치를 당기고(scroll anchoring), 그 이벤트가 크기 변화를 따라 내리기 전에 와서
  // 사람은 손도 안 댔는데 따라가기가 꺼졌다(보낸 직후 "생각 중" 이 붙을 때 실측).
  // scroll 이벤트는 바닥에 다시 닿았는지만 본다.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    lastScrollAtEnd.current = atEnd;
    // 바닥까지 내려오면 다시 따라간다. 바닥 "근처" 로 넓히지 않는다 — 조금 올려 읽는 중에 다시 붙어 버리면 끌어내리기가 이어져 떨린다.
    if (atEnd && !stickToBottom.current && !draggingBar.current && performance.now() - userUpAt.current > UP_GRACE_MS) follow();
  };
  // 사용자가 새 메시지를 보냈으면 맨 아래로 붙인다. 마지막 블록만 보면 응답 첫 블록이 같은 렌더에 함께 들어온 경우를 놓친다.
  // 응답 중에 보낸 것은 대기열에만 들어가 목록에 아직 없다 — 대기열이 늘어난 것도 보낸 것으로 본다.
  // 그 밖의 새 블록은 붙어 있을 때만 따라간다.
  const prevUserId = useRef(lastUserId);
  const prevQueued = useRef(queuedCount);
  useEffect(() => {
    if (lastUserId !== prevUserId.current) {
      prevUserId.current = lastUserId;
      if (lastUserId) follow();
    }
    if (queuedCount > prevQueued.current) follow();
    prevQueued.current = queuedCount;
    if (stickToBottom.current) scrollToBottom();
  }, [blocks, thinking, lastUserId, queuedCount]);
  // 내용 높이(스트리밍·이미지·하이라이트)나 목록 영역 높이(입력창이 커지거나 권한 요청이 뜸)가 바뀌어도 따라 내려간다.
  useEffect(() => {
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    ro.observe(content);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // 연속된 어시스턴트 블록(text/tool/turn)을 한 그룹으로 묶어 아바타를 한 번만 그린다.
  const groups: { kind: GroupKind; blocks: Block[] }[] = [];
  for (const b of blocks) {
    const kind: GroupKind =
      b.kind === "user" ? "user" : b.kind === "compacted" ? "compacted" : b.kind === "error" ? "error" : b.kind === "notice" ? "notice" : b.kind === "review" ? "review" : b.kind === "verify" ? "verify" : b.kind === "fanout" ? "fanout" : b.kind === "orchestration" ? "orchestration" : "assistant";
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && kind === "assistant") last.blocks.push(b);
    else groups.push({ kind, blocks: [b] });
  }

  // 턴 끝의 "여기서 분기": 지금 이어지는 세션의 턴이고 탭이 쉬고 있을 때만
  const forkCtx: ForkCtx = {
    can: (p) => !!sessionId && p.sessionId === sessionId && (status === "idle" || status === "error"),
    fork: (pointId) => window.sudal.chat.fork(tabId, pointId),
  };
  return (
    <ForkContext.Provider value={forkCtx}>
    <div className="relative h-full">
    <div
      ref={containerRef}
      onScroll={onScroll}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      className="h-full overflow-y-auto px-6 py-5"
      data-message-list
    >
      <div ref={contentRef} className="mx-auto flex max-w-[820px] flex-col gap-5">
        {blocks.length === 0 &&
          (loading ? (
            <LoadingConversation />
          ) : (
            <div className="mt-24 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-panel text-fg">
                <Logo size={20} />
              </div>
              <p className="text-muted">{t("chat.messages.empty")}</p>
            </div>
          ))}
        {groups.map((g, i) => (
          <Group key={g.blocks[0].id + i} group={g} provider={provider} tabId={tabId} onRerunVerify={onRerunVerify} onCompareFanout={onCompareFanout} onOpenOrchestration={onOpenOrchestration} />
        ))}
        {thinking && (
          <Thinking
            withAvatar={groups[groups.length - 1]?.kind !== "assistant"}
            provider={provider}
            reasoning={reasoning}
            since={lastUserTs}
            afterTool={last?.kind === "tool" ? last.name : null}
          />
        )}
        {status !== "idle" && status !== "error" && (turnStartedAt ?? lastUserTs) !== null && <RunningFooter since={status === "queued" ? lastUserTs! : (turnStartedAt ?? lastUserTs!)} blocks={blocks} status={status} ambientFromBg={ambientFromBg} />}
      </div>
    </div>
      {!atBottom && blocks.length > 0 && (
        <button
          onClick={() => {
            follow();
            scrollToBottom();
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted shadow-md hover:text-fg"
          title={t("chat.messages.scrollBottomHint")}
          data-scroll-bottom
        >
          <Icon name="arrowUp" size={11} className="rotate-180" />
          {t("chat.messages.scrollBottom")}
        </button>
      )}
    </div>
    </ForkContext.Provider>
  );
}

/**
 * 턴이 돌고 있지만 아직 말이 없는 구간의 표시. 경과 시간을 세고, 모델의 생각(reasoning)이 흘러오면 그 마지막 줄들을
 * 아래에 보여 준다 — 무엇을 따져 보고 있는지 보이면 "멈춘 것 아닌가" 하는 느낌이 줄어든다. 생각은 화면에만 흐르고 기록엔 남지 않는다.
 */
function Thinking({
  withAvatar,
  provider,
  reasoning,
  since,
  afterTool,
}: {
  withAvatar: boolean;
  provider: Provider;
  /** 지금 턴에서 흘러온 생각 텍스트의 꼬리(없으면 빈 문자열) */
  reasoning: string;
  /** 턴 시작 시각(마지막 사용자 메시지). 없으면 시간을 세지 않는다. */
  since: number | null;
  /** 도구 결과를 막 받은 뒤면 그 도구 이름(다음 행동을 정하는 구간), 아니면 null */
  afterTool: string | null;
}) {
  // 총 경과 시간은 맨 아래 RunningFooter 가 보여 주므로 여기선 라벨만
  void since;
  const { t } = useTranslation();
  const tail = reasoning
    .split("\n")
    // Codex 요약은 단락 제목을 "**Preparing review**" 처럼 굵게 표시해 보낸다 — 일반 텍스트로 보여 주므로 기호만 걷는다
    .map((l) => l.trim().replace(/\*\*(.+?)\*\*/g, "$1"))
    .filter(Boolean)
    .slice(-2)
    .join("\n");
  const label = afterTool ? t("chat.messages.thinkingAfterTool", { tool: afterTool }) : t("chat.messages.thinking");
  return (
    <div className={`flex gap-3 ${withAvatar ? "items-start" : "-mt-3"}`} aria-live="polite" data-thinking>
      {withAvatar ? <Avatar provider={provider} /> : <div className="avatar-gap" />}
      <div className="min-w-0 flex-1">
        {/* 아바타(32px + 위 여백 2px)와 같은 높이로 두고 세로 가운데 — 생각 텍스트가 붙으면 그 아래로 이어진다 */}
        <div className={`thinking-dots flex items-center gap-1.5 text-muted ${withAvatar ? "min-h-[34px]" : ""}`}>
          {/* 라벨에 긴 MCP 도구 이름이 들어온다 — 줄어들 수 있게 하고(min-w-0), 공백이 없으면 토큰 안에서 감기게. */}
          <span className="mr-1 min-w-0 break-words text-[12.5px]">
            <span className="shimmer">{label}</span>
          </span>
          <span />
          <span />
          <span />
        </div>
        {tail && (
          // 폭 상한을 두지 않는다. 목록이 820px 로 묶여 있어 칼럼은 778px 에서 더 안 커지고,
          // 두 줄 제한이 이미 길이를 잡아 준다. 좁히면 그만큼 글만 더 잘려 나간다(실측 159자 → 188자).
          <div key={tail} className="reasoning-tail mt-1 text-[12px] leading-relaxed text-muted-2" data-thinking-text>
            {tail}
          </div>
        )}
      </div>
    </div>
  );
}

/** 턴이 도는 동안 맨 아래에 붙는 한 줄: 총 경과 시간 · 이번 턴의 도구 호출 수 · 상태. 끝나면 turn 블록의 요약이 대신한다. */
/**
 * 턴이 끝난 뒤에도 도는 작업(백그라운드 Codex 등). 탭은 "대기" 인데 일은 남아 있다는 것을 여기서만 알 수 있다 —
 * 그 프로세스는 앱에서 떨어져 나가 하위 에이전트 표시에도 안 잡힌다.
 */

function RunningFooter({ since, blocks, status, ambientFromBg }: { since: number; blocks: Block[]; status: SessionStatus; ambientFromBg: boolean }) {
  const { t } = useTranslation();
  const secs = Math.max(0, Math.floor((useNow() - since) / 1000));
  let tools = 0;
  let running = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "user") break;
    if (b.kind === "tool") {
      tools += 1;
      if (!b.result) running += 1;
    }
  }
  // 권한 대기 중 AskUserQuestion 이 걸려 있으면 승인이 아니라 답을 기다리는 것
  const askingQuestion = blocks.some((b) => b.kind === "tool" && b.permission === "pending" && b.name === "AskUserQuestion");
  // 사용자가 아무 말도 안 했는데 도는 턴이 있다. 백그라운드 작업이 끝나 CLI 가 그 결과를 들고
  // 스스로 이어간 것인데, 그걸 "응답 중" 이라고 적으면 무엇에 답하는 중인지 알 수 없다.
  const running0 = ambientFromBg ? t("chat.messages.footer.ambient") : t("chat.messages.footer.responding");
  const label = status === "queued" ? t("chat.messages.footer.queued") : status === "waiting_permission" ? (askingQuestion ? t("toolCard.state.waiting_answer") : t("toolCard.state.waiting_permission")) : running > 0 ? t("chat.messages.footer.toolRunning") : running0;
  return (
    <div className="content-indent flex items-center gap-2 text-[11px] text-muted-2" data-turn-elapsed={secs}>
      <span className="spin inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-accent border-t-transparent" />
      <span className="shimmer" style={{ "--shimmer-base": "var(--color-muted)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}>
        {label}
      </span>
      <span className="mono">{formatElapsed(t, secs)}</span>
      {tools > 0 && <span className="mono">{t("chat.messages.footer.tools", { count: tools })}</span>}
    </div>
  );
}

/** 어시스턴트 이름·아바타는 제공자를 따른다 (헤더의 제공자 버튼과 같은 로고). */
const ASSISTANT: Record<Provider, { label: string }> = {
  claude: { label: "Claude" },
  codex: { label: "Codex" },
};

function Avatar({ provider }: { provider: Provider }) {
  return <ProviderLogo provider={provider} size={32} className="mt-0.5" />;
}

type GroupKind = "user" | "assistant" | "compacted" | "error" | "notice" | "review" | "verify" | "fanout" | "orchestration";

function Group({
  group,
  provider,
  tabId,
  onRerunVerify,
  onCompareFanout,
  onOpenOrchestration,
}: {
  group: { kind: GroupKind; blocks: Block[] };
  provider: Provider;
  tabId: string;
  onRerunVerify?: (commands: string[]) => void;
  onCompareFanout?: (fanoutId: string) => void;
  onOpenOrchestration?: (runId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  if (group.kind === "orchestration") {
    const b = group.blocks[0];
    return b.kind === "orchestration" ? <OrchestrationCard block={b} onOpen={(id) => onOpenOrchestration?.(id)} /> : null;
  }
  if (group.kind === "fanout") {
    const b = group.blocks[0];
    return b.kind === "fanout" ? <FanoutCard block={b} tabId={tabId} onCompare={(id) => onCompareFanout?.(id)} /> : null;
  }
  if (group.kind === "verify") {
    const b = group.blocks[0];
    return b.kind === "verify" ? <VerifyCard block={b} tabId={tabId} onRerun={onRerunVerify ? () => onRerunVerify(b.commands.map((c) => c.cmd)) : undefined} /> : null;
  }
  if (group.kind === "review") {
    const b = group.blocks[0];
    return b.kind === "review" ? <ReviewCard block={b} /> : null;
  }
  if (group.kind === "compacted") {
    const b = group.blocks[0];
    if (b.kind !== "compacted") return null;
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-muted" data-compacted={b.trigger}>
        <div className="h-px flex-1 bg-line" />
        <span className="shrink-0">
          {t(b.trigger === "auto" ? "chat.messages.compactedAuto" : "chat.messages.compacted", {
            tokens: `${k(b.preTokens)}${b.postTokens !== undefined ? ` → ${k(b.postTokens)}` : ""}`,
          })}
        </span>
        <div className="h-px flex-1 bg-line" />
      </div>
    );
  }
  if (group.kind === "notice") {
    const b = group.blocks[0];
    if (b.kind !== "notice") return null;
    // notice 는 흐린 한 줄, suggestion·warning 은 오류 줄처럼 눈에 띄게(CLI 의 표시 수준을 따른다)
    return b.level === "notice" ? (
      <div className="content-indent flex items-center gap-2 px-1 text-[12px] text-muted-2" data-notice="notice">
        <Icon name="info" size={12} className="shrink-0" />
        <span style={{ userSelect: "text" }}>{msgText(i18n, b.msg, b.message)}</span>
      </div>
    ) : (
      <div className="content-indent flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-muted" data-notice={b.level}>
        <Icon name="info" size={13} className={`shrink-0 ${b.level === "warning" ? "text-warn" : "text-accent"}`} />
        <span style={{ userSelect: "text" }}>{msgText(i18n, b.msg, b.message)}</span>
      </div>
    );
  }
  if (group.kind === "error") {
    const b = group.blocks[0];
    return b.kind === "error" ? (
      <div className="content-indent flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-muted">
        <Icon name="info" size={13} className="shrink-0 text-warn" />
        <span style={{ userSelect: "text" }}>{msgText(i18n, b.msg, b.message)}</span>
      </div>
    ) : null;
  }

  const isUser = group.kind === "user";
  const first = group.blocks[0];
  const dateLocale = intlLocale(i18n.language as Locale);
  const ts = first.kind === "user" ? first.ts : null;
  const time = ts
    ? new Date(ts).toLocaleTimeString(dateLocale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  // 말풍선 아래에는 시각만 둔다. 며칠 전 대화를 다시 볼 때 날짜가 필요해서,
  // 올려 두면 그 자리에서 날짜로 바뀐다(기본 툴팁은 1초를 기다려야 떠서 그것만으로는 부족하다).
  // 말풍선 아래 오른쪽 끝에 홀로 있는 줄이라, 길어져도 왼쪽으로 늘어날 뿐 다른 것을 밀지 않는다.
  const dated = ts
    ? new Date(ts).toLocaleString(dateLocale, {
        month: "long",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  // 연도·초까지 필요하면 조금 머물러 기본 툴팁으로 본다.
  const timeFull = ts
    ? new Date(ts).toLocaleString(dateLocale, {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : undefined;

  // 내 메시지는 메신저처럼 오른쪽 말풍선. 아바타·이름 없이 시각만 아래에.
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="min-w-0 max-w-[72%] rounded-2xl rounded-br-md bg-panel-2 px-4 py-2.5">
          {group.blocks.map((b) => (
            <div key={b.id} data-block-id={b.id} className="reveal-target">
              <BlockView block={b} />
            </div>
          ))}
        </div>
        {time && (
          <span className="group mono cursor-default pr-1 text-[10px] text-muted" title={timeFull} data-user-time>
            <span className="group-hover:hidden">{time}</span>
            <span className="hidden group-hover:inline" data-user-date>
              {dated}
            </span>
          </span>
        )}
      </div>
    );
  }

  // 압축처럼 말 없이 끝나는 턴이 있다 — 그때는 통계 블록만 온다.
  // 이름표와 아바타를 그리면 "클로드가 무언가 말했는데 비어 있다" 로 보인다. 통계 한 줄만 남긴다.
  if (group.blocks.every((b) => b.kind === "turn")) {
    return (
      <div className="content-indent" data-silent-turn>
        {group.blocks.map((b) => (
          <div key={b.id} data-block-id={b.id}>
            <BlockView block={b} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <Avatar provider={provider} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-semibold">{ASSISTANT[provider].label}</span>
        </div>
        <div className="flex flex-col gap-1">
          {group.blocks.map((b) => (
            <div key={b.id} data-block-id={b.id} className="reveal-target">
              <BlockView block={b} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 기록을 불러오는 동안의 자리. 금방 끝나면 눈에 띄지 않는다 — 짧게 스쳐 가는 표시는
 * 없는 것보다 산만하다. 늦게 나타나는 일은 CSS(.late-in)에 맡긴다. 큰 대화를 재생하는
 * 동안은 메인 스레드가 막혀서 JS 타이머가 제때 돌지 못하고, 그러면 정작 오래 걸리는
 * 경우에만 표시가 빠진다 — 실제로 재어 보고 옮겼다.
 */
function LoadingConversation() {
  const { t } = useTranslation();
  return (
    <div className="late-in mt-24 text-center" data-message-list-loading>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-panel">
        <span className="spin inline-block h-4 w-4 rounded-full border-[1.5px] border-muted border-t-transparent" />
      </div>
      <p className="text-muted">{t("chat.messages.loading")}</p>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  const { t, i18n } = useTranslation();
  switch (block.kind) {
    case "user":
      return (
        <div
          className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed"
          style={{ userSelect: "text" }}
        >
          {block.images && block.images.length > 0 && (
            <div className="mb-2 flex gap-2">
              {block.images.map((img, i) => (
                <img
                  key={i}
                  src={img.dataUrl}
                  className="h-20 rounded-md border border-line"
                  alt=""
                />
              ))}
            </div>
          )}
          {block.text}
        </div>
      );
    case "text":
      return (
        <div className="py-0.5" style={{ userSelect: "text" }}>
          <Markdown text={block.text} />
          {block.streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />
          )}
        </div>
      );
    case "tool":
      return <ToolCard block={block} />;
    case "turn": {
      const stats = (
        <span className="mono text-[10px]">
          {(block.durationMs / 1000).toFixed(1)}s · in {fmt(block.usage.input)}{" "}
          / out {fmt(block.usage.output)}
          {block.usage.cacheRead > 0 &&
            ` · cache ${fmt(block.usage.cacheRead)}`}
          {block.costUsd > 0 && ` · $${block.costUsd.toFixed(4)}`}
        </span>
      );
      // 성공한 턴은 통계 한 줄만 조용히. 실패는 원인을 봐야 하니 박스로.
      if (!block.isError)
        return (
          <div className="group/turn mt-1 flex items-center justify-end gap-2 text-muted-2">
            {block.forkPoint && <ForkButton point={block.forkPoint} />}
            {stats}
          </div>
        );
      return (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-err/40 bg-err-bg px-3 py-2 text-err">
          <Icon name="alert" size={13} />
          <span className="flex-1">
            {block.errorText ? msgText(i18n, block.errorMsg, block.errorText) : t("chat.messages.turnFailed")}
          </span>
          <span className="opacity-80">{stats}</span>
        </div>
      );
    }
    default:
      return null;
  }
}

interface ForkCtx {
  can: (p: ForkPoint) => boolean;
  fork: (pointId: string) => Promise<{ ok: true; tabId: string } | { ok: false; error: string }>;
}
const ForkContext = createContext<ForkCtx | null>(null);

/** 턴 통계 줄의 "여기서 분기". 줄에 올렸을 때만 보인다. 새 탭이 열리면 앱이 그리로 옮겨 간다. */
function ForkButton({ point }: { point: ForkPoint }) {
  const { t } = useTranslation();
  const ctx = useContext(ForkContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ctx?.can(point)) return null;
  return (
    <>
      {error && <span className="text-[11px] text-err">{error}</span>}
      <button
        onClick={() => {
          setBusy(true);
          setError(null);
          void ctx.fork(point.pointId).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.error);
          });
        }}
        disabled={busy}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-panel-2 hover:text-fg disabled:opacity-60 ${busy || error ? "" : "opacity-0 group-hover/turn:opacity-100 focus:opacity-100"}`}
        title={t("chat.messages.forkHint")}
        data-fork-turn
      >
        <Icon name="switch" size={10} />
        {busy ? t("chat.messages.forking") : t("chat.messages.fork")}
      </button>
    </>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 교차 리뷰 카드: 요청 중엔 shimmer + 경과, 끝나면 리뷰 본문(마크다운). 리뷰 탭으로 바로 갈 수 있다. */
function ReviewCard({ block }: { block: ReviewBlock }) {
  const { t, i18n } = useTranslation();
  const now = useNow(block.status === "requested");
  const name = block.reviewer === "claude" ? "Claude Code" : "Codex";
  const secs = Math.max(0, Math.floor((now - block.ts) / 1000));
  return (
    <div className="content-indent rounded-lg border border-line bg-panel" data-review-card={block.id} data-review-status={block.status}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ProviderLogo provider={block.reviewer} size={18} />
        <span className="font-medium">{t("chat.messages.review.title", { name })}</span>
        {block.scope && <span className="mono text-[10.5px] text-muted-2">{msgText(i18n, block.scopeMsg, block.scope)}</span>}
        <span className="flex-1" />
        {block.status === "requested" && (
          <span className="label flex items-center gap-1.5 text-accent">
            <span className="shimmer" style={{ "--shimmer-base": "var(--color-accent)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}>
              {t("chat.messages.review.running")}
            </span>
            {secs >= 3 && <span className="mono normal-case tracking-normal text-muted-2">{formatElapsed(t, secs)}</span>}
          </span>
        )}
        {block.status === "done" && <span className="label text-ok">{t("chat.messages.review.done")}</span>}
        {block.status === "failed" && <span className="label text-err">{t("chat.messages.review.failed")}</span>}
        <button
          onClick={() => void window.sudal.workspaces.activateTab(block.id)}
          className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
          title={t("chat.messages.review.openHint")}
          data-review-open
        >
          {t("chat.messages.review.open")}
        </button>
      </div>
      {block.status === "done" && (
        <div className="px-3 py-2.5" style={{ userSelect: "text" }}>
          <Markdown text={msgText(i18n, block.textMsg, block.text)} />
        </div>
      )}
      {block.status === "failed" && <div className="px-3 py-2 text-[12px] text-err">{msgText(i18n, block.textMsg, block.text)}</div>}
      {block.status === "requested" && <div className="px-3 py-2 text-[12px] text-muted">{t("chat.messages.review.waiting", { name })}</div>}
    </div>
  );
}
