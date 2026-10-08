// "터미널에서 실행": 도구 카드·코드 블록의 명령을 이 탭의 셸에 넣는다.
// 요청은 여기 큐에 두고 TerminalPanel 이 마운트되고 대상 pty 가 붙은 뒤에 한 번만 꺼내 쓴다 —
// 패널이 아직 없을 때 window 이벤트로 보내면 그냥 사라지기 때문(reveal.ts 와 같은 이유).

import { createContext } from "react";

export interface TerminalRunRequest {
  command: string;
  /** true 면 넣고 바로 Enter. false 면 넣기만 하고 사용자가 확인 뒤 Enter. */
  run: boolean;
}

/** 요청은 탭별 FIFO. 너무 오래 기다린 요청(셸이 못 뜬 채 남은 것)은 버린다 — 한참 뒤 갑자기 명령이 들어가면 안 된다. */
const REQUEST_TTL_MS = 10_000;
const pending = new Map<string, { req: TerminalRunRequest; at: number }[]>();
const listeners = new Set<() => void>();

export function requestTerminalRun(tabId: string, req: TerminalRunRequest, now = Date.now()): void {
  const q = pending.get(tabId) ?? [];
  q.push({ req, at: now });
  pending.set(tabId, q);
  for (const l of listeners) l();
}

function fresh(tabId: string, now: number): { req: TerminalRunRequest; at: number }[] {
  const q = (pending.get(tabId) ?? []).filter((e) => now - e.at <= REQUEST_TTL_MS);
  if (q.length === 0) pending.delete(tabId);
  else pending.set(tabId, q);
  return q;
}

/** 꺼내지 않고 가장 오래된 것을 본다 — 대상 셸이 아직 준비되지 않았을 때 요청을 잃지 않으려고. */
export function peekTerminalRun(tabId: string, now = Date.now()): TerminalRunRequest | null {
  return fresh(tabId, now)[0]?.req ?? null;
}

export function takeTerminalRun(tabId: string, now = Date.now()): TerminalRunRequest | null {
  const q = fresh(tabId, now);
  const e = q.shift() ?? null;
  if (q.length === 0) pending.delete(tabId);
  return e?.req ?? null;
}

/** 남은 요청 수. 하나를 처리한 뒤 더 있으면 이어서 처리한다. */
export function pendingTerminalRuns(tabId: string, now = Date.now()): number {
  return fresh(tabId, now).length;
}

/**
 * 프롬프트 세대 — 터미널(pty)마다, 셸이 프롬프트를 그리며 bracketed paste 를 켤 때(CSI ?2004h)마다 1 씩 는다.
 * 패널이 아니라 여기서 센다: 채팅 탭을 오가면 패널은 다시 마운트되지만 pty 는 살아 있고, 그 사이에 온 프롬프트도 세야 게이트가 풀린다.
 * 실시간 출력(onData)만 보고 백로그 복원은 보지 않는다 — 백로그의 프롬프트는 이미 센 옛것이다.
 * 넣은 뒤의 요청은 넣을 때보다 세대가 커진 뒤에만 보낸다 — 아직 실행 안 된 명령 뒤에 붙지 않게.
 */
const promptEpochs = new Map<string, number>();
const deliveredEpochs = new Map<string, number>();
/** DECSET(CSI ? … h). 파라미터가 여럿일 수 있어(ESC[?1;2004h) 나눠서 본다. OSC 문자열 안의 우연한 일치는 감수한다 — 여기서 VT 파서를 돌리진 않는다. */
const DECSET_RE = /\x1b\[\?([0-9;]*)h/g;
/** 청크 경계에 시퀀스가 걸릴 수 있어 마지막 ESC 부터를 다음 청크 앞에 잇는다(너무 길면 시퀀스가 아니다). */
const carry = new Map<string, string>();
const CARRY_MAX = 32;

export function notePrompt(termId: string): number {
  const n = (promptEpochs.get(termId) ?? 0) + 1;
  promptEpochs.set(termId, n);
  for (const l of listeners) l();
  return n;
}

/** 출력 청크에서 프롬프트 시퀀스를 센다. 앱 시작 때 terminal.onData 에 한 번 건다. */
export function scanTerminalOutput(termId: string, data: string): void {
  const text = (carry.get(termId) ?? "") + data;
  let n = 0;
  let end = 0;
  DECSET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECSET_RE.exec(text))) {
    if (m[1].split(";").includes("2004")) n += 1;
    end = m.index + m[0].length;
  }
  const lastEsc = text.lastIndexOf("\x1b");
  carry.set(termId, lastEsc >= end && text.length - lastEsc <= CARRY_MAX ? text.slice(lastEsc) : "");
  for (let i = 0; i < n; i++) notePrompt(termId);
}

if (typeof window !== "undefined" && window.sudal?.terminal) window.sudal.terminal.onData(scanTerminalOutput);

export function promptEpoch(termId: string): number {
  return promptEpochs.get(termId) ?? 0;
}

export function noteDelivered(termId: string, epoch: number): void {
  deliveredEpochs.set(termId, epoch);
}

/** 지금 넣어도 되나 — 앞서 넣은 것이 없거나, 그 뒤로 새 프롬프트가 나왔다. */
export function canDeliver(termId: string): boolean {
  const last = deliveredEpochs.get(termId);
  return last === undefined || promptEpoch(termId) > last;
}

/** 터미널(pty)이 끝났다 — 다음에 같은 id 로 새 셸이 떠도 옛 기록이 남지 않게. */
export function forgetTerminalGate(termId: string): void {
  promptEpochs.delete(termId);
  deliveredEpochs.delete(termId);
  carry.delete(termId);
}

export function onTerminalRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** ChatView 가 준다. (command, run) — 패널을 열고 요청을 큐에 넣는다. */
export const RunInTerminalContext = createContext<((command: string, run: boolean) => void) | null>(null);

/** 코드 블록에서 온 명령: 끝의 개행은 뗀다 — 남기면 붙여넣기만 하려던 것이 실행된다. 앞뒤 빈 줄도. */
export function normalizeCommand(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
}

/** 코드 블록 언어가 이 운영체제의 셸이면 "터미널에서 실행" 을 붙인다. Windows 터미널은 PowerShell 이라 bash 류 대신 PowerShell·cmd 블록에. */
export function isShellLanguage(className: string | undefined, win = false): boolean {
  const re = win ? /(^|\s)language-(powershell|pwsh|ps1|ps|cmd|bat|batch)(\s|$)/ : /(^|\s)language-(bash|sh|zsh|shell)(\s|$)/;
  return re.test(className ?? "");
}

/**
 * 명령을 받을 터미널. 포커스가 있던 것이 셸이면 그것, 아니면(CLI 탭이거나 없으면) 셸 탭 중 마지막. 셸이 없으면 null — 호출자가 새로 만든다.
 */
export function pickShellTarget(tabs: { id: string; kind: "shell" | "command" }[], focused: string | null): string | null {
  const f = focused ? tabs.find((t) => t.id === focused) : null;
  if (f && f.kind === "shell") return f.id;
  const shells = tabs.filter((t) => t.kind === "shell");
  return shells.length > 0 ? shells[shells.length - 1].id : null;
}
