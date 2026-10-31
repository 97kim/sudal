// ACP 연결 계층. 명시적으로 만든 실험 탭과 개발용 진단에서 사용한다.
// CLI별 의미 변환은 여기 넣지 않고, 협상된 ACP v1 기능과 프로세스 수명주기만 다룬다.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { launchSpec } from "./cli-launch";
import { killProcessTree, taskkillArgs } from "./win-proc";
import { acpSlashCommands } from "./acp-session";
import type { SlashCommandDto } from "@shared/slash-commands";

export type AcpProvider = "claude" | "codex";

export interface AcpLaunchOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 초기화·세션 생성 등 제어 요청. 사용자 승인을 기다리는 prompt에는 적용하지 않는다. */
  requestTimeoutMs?: number;
  cancelGraceMs?: number;
  maxMessageBytes?: number;
  clientVersion?: string;
}

export interface AcpClientHandlers {
  /** 기록을 쌓아 두지 않고 세션 ID와 함께 즉시 전달한다. 히스토리 재생도 같은 경로다. */
  onUpdate?(notification: acp.SessionNotification): void;
  onCommands?(sessionId: string, commands: SlashCommandDto[]): void;
  /** ACP가 제안한 optionId만 반환한다. 구현이 없거나 취소·예외이면 실행을 허용하지 않는다. */
  requestPermission?(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<string | null>;
}

function interrupted(): Error {
  return new DOMException("ACP request cancelled", "AbortError");
}

/** 응답 없는 승인 콜백도 세션 취소/연결 종료 즉시 기다림을 해제한다. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? interrupted()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export class AcpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly connection: acp.ClientConnection;
  private readonly lifetime = new AbortController();
  // 턴이 끝날 때까지 취소 상태를 유지한다. 취소 후 늦게 도착한 승인에도 같은 signal을 적용한다.
  private readonly turns = new Map<string, AbortController>();
  private readonly sessions = new Set<string>();
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing: Promise<void> | null = null;
  private initialized: acp.InitializeResponse | null = null;

  private constructor(private readonly options: AcpLaunchOptions, private readonly handlers: AcpClientHandlers) {
    const spec = launchSpec(options.command, options.args ?? []);
    // 일반 배치는 셸의 인자·환경변수 확장이 개입한다. npm shim이나 실행 파일을 명시한다.
    if (spec.shell) throw new Error("ACP requires an executable or a recognized npm shim");
    this.proc = spawn(spec.command, spec.args, {
      cwd: options.cwd, env: options.env ?? process.env, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    // 인증 URL·계정 정보가 stderr에 포함될 수 있다. 공통 계층에서는 기록하지 않는다.
    this.proc.stderr.resume();
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", error => { void this.close(error); });
    this.proc.on("exit", code => { void this.close(new Error(`ACP process exited (${code ?? "signal"})`)); });
    const app = acp.client()
      .onNotification("session/update", ({ params }) => {
        if (this.lifetime.signal.aborted) return;
        this.handlers.onUpdate?.(params);
        if (params.update.sessionUpdate === "available_commands_update") {
          this.handlers.onCommands?.(params.sessionId, acpSlashCommands(params.update.availableCommands));
        }
      })
      .onRequest("session/request_permission", async ({ params, signal }) => {
        // 준비 단계에서는 우리가 진행한 턴 외의 백그라운드/하위 세션 승인을 허용하지 않는다.
        const turn = this.turns.get(params.sessionId);
        if (!turn || turn.signal.aborted) return { outcome: { outcome: "cancelled" } };
        const cancelled = AbortSignal.any([signal, this.lifetime.signal, turn.signal]);
        try {
          const answer = await untilAborted(
            Promise.resolve().then(() => cancelled.aborted ? null : this.handlers.requestPermission?.(params, cancelled) ?? null),
            cancelled,
          );
          if (cancelled.aborted || !answer || !params.options.some(option => option.optionId === answer)) {
            return { outcome: { outcome: "cancelled" } };
          }
          return { outcome: { outcome: "selected", optionId: answer } };
        } catch {
          return { outcome: { outcome: "cancelled" } };
        }
      });
    this.connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(this.proc.stdin), Readable.toWeb(this.proc.stdout),
      { maxMessageBytes: options.maxMessageBytes ?? 8 * 1024 * 1024 },
    ));
    void this.connection.closed.then(() => this.close(new Error("ACP connection closed")));
  }

  static async start(options: AcpLaunchOptions, handlers: AcpClientHandlers = {}, signal?: AbortSignal): Promise<AcpClient> {
    if (signal?.aborted) throw interrupted();
    for (const value of [options.requestTimeoutMs, options.cancelGraceMs, options.maxMessageBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("ACP limits must be positive integers");
    }
    const client = new AcpClient(options, handlers);
    const abort = () => { void client.close(interrupted()); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await client.control<acp.InitializeResponse>("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "sudal", title: "Sudal", version: options.clientVersion ?? "dev" },
        // 파일·터미널·인증 UI·확장은 아직 구현하지 않아 지원한다고 선언하지 않는다.
        clientCapabilities: {},
      } satisfies acp.InitializeRequest);
      if (response.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version: ${response.protocolVersion}`);
      client.initialized = response;
      return client;
    } catch (error) {
      await client.close(error);
      throw error;
    } finally { signal?.removeEventListener("abort", abort); }
  }

  get info(): acp.InitializeResponse {
    if (!this.initialized) throw new Error("ACP has not initialized");
    return this.initialized;
  }

  get alive(): boolean { return !this.lifetime.signal.aborted; }

  authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
    if (!this.info.authMethods?.some(method => method.id === methodId)) return Promise.reject(new Error(`Unsupported ACP authentication method: ${methodId}`));
    // 사용자 로그인 대기 시간. 이 메서드를 명시적으로 호출할 때에만 인증을 시작한다.
    return this.control("authenticate", { methodId }, 5 * 60_000);
  }

  async newSession(request: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const result = await this.control<acp.NewSessionResponse>("session/new", request);
    this.sessions.add(result.sessionId);
    return result;
  }

  async loadSession(request: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    if (!this.info.agentCapabilities?.loadSession) throw new Error("ACP session/load is not supported");
    const result = await this.control<acp.LoadSessionResponse>("session/load", request);
    this.sessions.add(request.sessionId);
    return result;
  }

  async resumeSession(request: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    if (!this.info.agentCapabilities?.sessionCapabilities?.resume) throw new Error("ACP session/resume is not supported");
    const result = await this.control<acp.ResumeSessionResponse>("session/resume", request);
    this.sessions.add(request.sessionId);
    return result;
  }

  listSessions(request: acp.ListSessionsRequest = {}): Promise<acp.ListSessionsResponse> {
    if (!this.info.agentCapabilities?.sessionCapabilities?.list) return Promise.reject(new Error("ACP session/list is not supported"));
    return this.control("session/list", request);
  }

  setConfigOption(request: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    this.requireSession(request.sessionId);
    return this.control("session/set_config_option", request);
  }

  async prompt(request: acp.PromptRequest, signal?: AbortSignal): Promise<acp.PromptResponse> {
    this.requireSession(request.sessionId);
    if (signal?.aborted) throw interrupted();
    if (this.turns.has(request.sessionId)) throw new Error("ACP session already has an active prompt");
    const caps = this.info.agentCapabilities?.promptCapabilities;
    for (const block of request.prompt) {
      if ((block.type === "image" && !caps?.image) || (block.type === "audio" && !caps?.audio) || (block.type === "resource" && !caps?.embeddedContext)) {
        throw new Error(`ACP prompt content is not supported: ${block.type}`);
      }
    }
    const turn = new AbortController();
    this.turns.set(request.sessionId, turn);
    const abort = () => {
      void this.cancel(request.sessionId).catch(() => {});
    };
    try {
      const result = this.connection.agent.request("session/prompt", request);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return await untilAborted(result, this.lifetime.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(this.cancelTimers.get(request.sessionId));
      this.cancelTimers.delete(request.sessionId);
      turn.abort();
      this.turns.delete(request.sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
    this.turns.get(sessionId)?.abort();
    if (this.turns.has(sessionId) && !this.cancelTimers.has(sessionId)) {
      const timer = setTimeout(() => { void this.close(new Error("ACP did not finish cancellation")); }, this.options.cancelGraceMs ?? 5000);
      timer.unref?.();
      this.cancelTimers.set(sessionId, timer);
    }
    await this.connection.agent.notify("session/cancel", { sessionId });
  }

  close(reason: unknown = new Error("ACP client closed")): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(reason);
    for (const turn of this.turns.values()) turn.abort();
    for (const timer of this.cancelTimers.values()) clearTimeout(timer);
    this.cancelTimers.clear();
    // Windows에서 stdin을 먼저 닫으면 부모가 먼저 끝나 helper가 분리될 수 있다. 트리를 먼저 정리한다.
    this.closing = this.stopProcess().finally(() => this.connection.close(reason));
    return this.closing;
  }

  private async stopProcess(): Promise<void> {
    const pid = this.proc.pid;
    if (!pid) return;
    if (process.platform !== "win32") { killProcessTree(pid, "SIGKILL"); return; }
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", taskkillArgs(pid), { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); this.proc.kill(); resolve(); }, 3000);
      const finish = () => { clearTimeout(timer); resolve(); };
      killer.once("error", () => { this.proc.kill(); finish(); });
      killer.once("exit", finish);
    });
  }

  private requireSession(sessionId: string): void {
    if (!this.alive) throw new Error("ACP client is closed");
    if (!this.sessions.has(sessionId)) throw new Error("ACP session is not attached to this connection");
  }

  private async control<T>(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<T> {
    if (!this.alive) throw new Error("ACP client is closed");
    const timer = setTimeout(() => { void this.close(new Error(`ACP request timed out: ${method}`)); }, timeoutMs);
    try { return await untilAborted(this.connection.agent.request<T>(method, params), this.lifetime.signal); }
    finally { clearTimeout(timer); }
  }
}
