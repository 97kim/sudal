// Antigravity CLI (`agy`) 실행 어댑터.
// 탭(sessionKey)마다 `--input-format stream-json --output-format stream-json -p=""` 프로세스를 유지해
// 멀티턴 대화를 이어 가고, 유휴 시간이 지나거나 탭을 닫으면 프로세스를 정리한다.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChatEvent, PermissionPolicy } from "@shared/chat-events";
import type { ChatImageDto } from "@shared/ipc";
function launchSpec(
  binPath: string,
  args: string[],
): { command: string; args: string[]; shell: boolean } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath)) {
    return { command: binPath, args, shell: true };
  }
  return { command: binPath, args, shell: false };
}
import { AgyEventMapper } from "./agy-events";
import { MsgError, mt } from "./i18n";

export interface AgyRuntime {
  agyPath: string;
  env: NodeJS.ProcessEnv;
}

export interface AgyTurnRequest {
  sessionKey: string;
  cwd: string;
  prompt: string;
  images?: ChatImageDto[];
  sessionId: string | null;
  policy: PermissionPolicy;
  model?: string;
  abort: AbortController;
  onEvent(event: ChatEvent): void;
  log?(line: string): void;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
let sessionIdleMs = DEFAULT_IDLE_MS;

export function setAgySessionIdleMs(ms: number): void {
  sessionIdleMs = ms;
}

export function agyPolicyArgs(policy: PermissionPolicy): string[] {
  switch (policy) {
    case "ask":
      return ["--sandbox"];
    case "auto_edit":
      return ["--mode", "accept-edits"];
    case "auto_review":
      return ["--mode", "auto"];
    case "full":
      return ["--dangerously-skip-permissions"];
  }
}

export function buildAgyUserInputLine(prompt: string, images?: ChatImageDto[]): string {
  if (!images || images.length === 0) {
    return JSON.stringify({
      event: "user",
      message: {
        role: "user",
        content: prompt,
      },
    });
  }
  return JSON.stringify({
    event: "user",
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
        { type: "text" as const, text: prompt },
      ],
    },
  });
}

interface TurnCtx {
  req: AgyTurnRequest;
  resolve(): void;
  reject(e: unknown): void;
}

interface LiveAgy {
  key: string;
  cwd: string;
  policy: PermissionPolicy;
  model?: string;
  sessionId: string | null;
  /** warmAgySession 중 도착한 init 의 sessionId 가 아직 턴 onEvent 로 전달되지 않았는지 추적. */
  sessionReported: boolean;
  proc: ChildProcessWithoutNullStreams;
  mapper: AgyEventMapper;
  buffer: string;
  turn: TurnCtx | null;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  log?(line: string): void;
}

const live = new Map<string, LiveAgy>();

function armIdle(s: LiveAgy) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (live.get(s.key) !== s || s.turn) return;
    s.log?.(`[agy ${s.key}] idle ${sessionIdleMs}ms — 프로세스 종료`);
    closeAgySession(s.key);
  }, sessionIdleMs);
  s.idleTimer.unref?.();
}

export function closeAgySession(key: string): void {
  const s = live.get(key);
  if (!s) return;
  live.delete(key);
  s.dead = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  try {
    s.proc.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    s.proc.kill();
  } catch {
    /* ignore */
  }
  if (s.turn) {
    const t = s.turn;
    s.turn = null;
    t.reject(new MsgError("session.msg.sessionEnded"));
  }
}

export function closeAllAgySessions(): void {
  for (const key of [...live.keys()]) closeAgySession(key);
}

export function applyAgyPolicy(key: string, policy: PermissionPolicy): "applied" | "next_turn" | "none" {
  const s = live.get(key);
  if (!s || s.dead) return "none";
  if (s.policy === policy) return "none";
  // agy 는 시작 인자로 권한 모드를 정하므로, 지금 놀고 있으면 바로 내려서 다음 턴에 새 플래그로 띄운다.
  if (!s.turn) {
    closeAgySession(key);
  }
  return "next_turn";
}

function openAgyProcess(
  runtime: AgyRuntime,
  opts: {
    sessionKey: string;
    cwd: string;
    sessionId: string | null;
    policy: PermissionPolicy;
    model?: string;
    log?(line: string): void;
  },
): LiveAgy {
  const cliArgs: string[] = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "-p=",
    ...agyPolicyArgs(opts.policy),
  ];
  if (opts.sessionId) cliArgs.push("--conversation", opts.sessionId);
  if (opts.model) cliArgs.push("--model", opts.model);

  const spec = launchSpec(runtime.agyPath, cliArgs);
  const proc = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    env: runtime.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: spec.shell,
    windowsHide: true,
  });

  const mapper = new AgyEventMapper({ model: opts.model, startedAt: Date.now() });
  const s: LiveAgy = {
    key: opts.sessionKey,
    cwd: opts.cwd,
    policy: opts.policy,
    model: opts.model,
    sessionId: opts.sessionId,
    sessionReported: false,
    proc,
    mapper,
    buffer: "",
    turn: null,
    dead: false,
    idleTimer: null,
    log: opts.log,
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    s.buffer += chunk;
    let nl: number;
    while ((nl = s.buffer.indexOf("\n")) !== -1) {
      const line = s.buffer.slice(0, nl).trim();
      s.buffer = s.buffer.slice(nl + 1);
      if (!line) continue;
      handleStdoutLine(s, line);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (!text) return;
    s.log?.(`[agy stderr] ${text.slice(0, 300)}`);
  });

  proc.stdin.on("error", (e) => {
    s.log?.(`[agy stdin] ${e.message}`);
  });

  const onEnd = (code: number | null, err?: Error) => {
    if (s.dead) return;
    s.dead = true;
    if (live.get(s.key) === s) live.delete(s.key);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.turn) {
      const t = s.turn;
      s.turn = null;
      t.reject(err ?? new Error(mt("session.msg.codexExited", { code: code ?? "?" })));
    }
  };

  proc.on("exit", (code) => onEnd(code));
  proc.on("error", (err) => onEnd(null, err));

  live.set(s.key, s);
  armIdle(s);
  return s;
}

function handleStdoutLine(s: LiveAgy, line: string): void {
  const { events, turnDone } = s.mapper.mapLine(line, Date.now());
  for (const ev of events) {
    if (ev.type === "session") {
      s.sessionId = ev.sessionId;
      if (s.turn) s.sessionReported = true;
    }
    s.turn?.req.onEvent(ev);
  }
  if (turnDone && s.turn) {
    const t = s.turn;
    s.turn = null;
    armIdle(s);
    t.resolve();
  }
}

export async function warmAgySession(
  runtime: AgyRuntime,
  req: {
    sessionKey: string;
    cwd: string;
    sessionId: string | null;
    policy: PermissionPolicy;
    model?: string;
    log?(line: string): void;
  },
): Promise<"opened" | "reused"> {
  const existing = live.get(req.sessionKey);
  if (
    existing &&
    !existing.dead &&
    existing.cwd === req.cwd &&
    existing.policy === req.policy &&
    (existing.model ?? "") === (req.model ?? "") &&
    (req.sessionId === null || existing.sessionId === req.sessionId)
  ) {
    return "reused";
  }
  if (existing) closeAgySession(req.sessionKey);
  openAgyProcess(runtime, req);
  return "opened";
}

export async function runAgyTurn(runtime: AgyRuntime, req: AgyTurnRequest): Promise<void> {
  if (req.abort.signal.aborted) return;

  let s = live.get(req.sessionKey);
  if (
    s &&
    (s.dead ||
      s.cwd !== req.cwd ||
      s.policy !== req.policy ||
      (s.model ?? "") !== (req.model ?? "") ||
      (req.sessionId !== null && s.sessionId !== null && s.sessionId !== req.sessionId))
  ) {
    closeAgySession(req.sessionKey);
    s = undefined;
  }
  if (!s) {
    s = openAgyProcess(runtime, {
      sessionKey: req.sessionKey,
      cwd: req.cwd,
      sessionId: req.sessionId,
      policy: req.policy,
      model: req.model,
      log: req.log,
    });
  }

  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  const startedAt = Date.now();
  s.mapper.resetTurn(startedAt);
  // warmAgySession 동안 init 이 먼저 도착해 s.sessionId 만 채워진 경우, 첫 턴 시작 시 세션 이벤트를 전달해 저장되게 한다.
  if (s.sessionId && !s.sessionReported) {
    s.sessionReported = true;
    req.onEvent({
      type: "session",
      ts: startedAt,
      sessionId: s.sessionId,
      provider: "agy",
      ...(s.model ? { model: s.model } : {}),
      cwd: s.cwd,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      closeAgySession(req.sessionKey);
      reject(new Error("aborted"));
    };
    if (req.abort.signal.aborted) {
      onAbort();
      return;
    }
    req.abort.signal.addEventListener("abort", onAbort, { once: true });

    s!.turn = {
      req,
      resolve: () => {
        req.abort.signal.removeEventListener("abort", onAbort);
        resolve();
      },
      reject: (e) => {
        req.abort.signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    };

    const payload = buildAgyUserInputLine(req.prompt, req.images) + "\n";
    s!.proc.stdin.write(payload, "utf8", (err) => {
      if (err && s!.turn) {
        const t = s!.turn;
        s!.turn = null;
        t.reject(err);
      }
    });
  });
}
