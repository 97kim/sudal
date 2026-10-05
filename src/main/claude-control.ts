// 프롬프트 없이 Claude CLI 를 열어 컨트롤 요청(supportedCommands, mcpServerStatus …)만 보내는 헬퍼.
// 스트리밍 입력(AsyncIterable)이어야 컨트롤 요청이 가능하므로, 아무것도 내보내지 않고 닫힘만 기다리는
// 제너레이터를 prompt 로 넘긴다. 턴이 시작되지 않으니 모델 호출·비용이 없다.

import type { ClaudeRuntime } from "./claude-adapter";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mt } from "./i18n";

type Query = import("@anthropic-ai/claude-agent-sdk").Query;
type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;

const INIT_TIMEOUT_MS = 25_000;

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(mt("session.error.timeout", { label, sec: ms / 1000 }))), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * CLI 를 띄워 initialize 가 끝나면 fn 을 실행하고, 끝나면 입력을 닫고 프로세스를 정리한다.
 * fn 안에서는 q.initializationResult(), q.mcpServerStatus() 같은 컨트롤 요청을 쓸 수 있다.
 */
export async function withControlQuery<T>(
  runtime: ClaudeRuntime,
  cwd: string,
  fn: (q: Query) => Promise<T>,
  log?: (line: string) => void,
): Promise<T> {
  let release!: () => void;
  const closed = new Promise<void>((r) => (release = r));
  async function* idle(): AsyncGenerator<SDKUserMessage, void, void> {
    await closed;
  }
  const abort = new AbortController();
  const q = query({
    prompt: idle(),
    options: {
      cwd,
      env: runtime.env,
      pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      abortController: abort,
      permissionMode: "default",
      stderr: (line) => log?.(line),
    },
  });
  // 컨트롤 응답이 처리되도록 출력 스트림을 뒤에서 소비한다.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        /* 메시지는 필요 없다 */
      }
    } catch {
      /* close 로 끝난다 */
    }
  })();
  try {
    await withTimeout(
      q.initializationResult(),
      INIT_TIMEOUT_MS,
      mt("session.error.label.initialize"),
    );
    return await fn(q);
  } finally {
    release();
    try {
      q.close();
    } catch {}
    abort.abort();
    await drain;
  }
}

/**
 * `/usage` 를 로컬 커맨드로 실행해 출력 텍스트를 돌려준다. 모델을 부르지 않으므로 비용이 없다.
 * 출력은 assistant(model "<synthetic>") 메시지의 text 블록 또는 system/local_command_output 으로 온다.
 */
export async function fetchUsageText(
  runtime: ClaudeRuntime,
  cwd: string,
  log?: (line: string) => void,
): Promise<string> {
  const abort = new AbortController();
  const q = query({
    prompt: "/usage",
    options: {
      cwd,
      env: runtime.env,
      pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      abortController: abort,
      permissionMode: "default",
      maxTurns: 1,
      stderr: (line) => log?.(line),
    },
  });
  const parts: string[] = [];
  const run = (async () => {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "local_command_output")
        parts.push(msg.content);
      else if (msg.type === "assistant") {
        const content: unknown = msg.message.content;
        if (Array.isArray(content)) {
          for (const b of content as { type?: string; text?: string }[])
            if (b.type === "text" && b.text) parts.push(b.text);
        }
      }
    }
  })();
  try {
    await withTimeout(run, INIT_TIMEOUT_MS, mt("session.error.label.usage"));
  } finally {
    abort.abort();
    try {
      q.close();
    } catch {}
  }
  return parts.join("\n");
}
