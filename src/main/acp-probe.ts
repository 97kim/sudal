// 개발용 진단 명령. 앱의 제공사 선택과 연결하지 않으며 모델에 프롬프트를 보내지 않는다.
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { InitializeResponse, NewSessionResponse } from "@agentclientprotocol/sdk";
import type { SlashCommandDto } from "@shared/slash-commands";
import { AcpClient, type AcpProvider } from "./acp-client";
import { acpCapabilities } from "./acp-session";

interface ProbeConfig { provider: AcpProvider; command: string; args?: string[] }

async function run(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, cwd: { type: "string" }, authenticate: { type: "string" },
    output: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || !values.config) {
    console.log("사용법: yarn acp:probe --config <설정.json> [--cwd <작업폴더>] [--authenticate <인증방식>] [--output <결과.json>]");
    console.log('설정 예: {"provider":"codex","command":"codex-acp","args":[]}');
    console.log("기본 작업폴더는 임시 폴더입니다. 명령 목록과 기능만 조회하며 모델에 프롬프트를 보내지 않습니다.");
    if (!values.help) process.exitCode = 1;
    return;
  }
  const configPath = resolve(values.config);
  const config: ProbeConfig = JSON.parse(await readFile(configPath, "utf8"));
  if (config.provider !== "claude" && config.provider !== "codex") throw new Error("provider는 claude 또는 codex여야 합니다.");
  if (typeof config.command !== "string" || !config.command.trim()) throw new Error("실행할 command가 필요합니다.");
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string"))) throw new Error("args는 문자열 배열이어야 합니다.");
  // 경로처럼 적은 명령은 설정 파일 기준으로, node 등의 이름은 PATH에서 찾는다.
  const command = !isAbsolute(config.command) && /[\\/]/.test(config.command) ? resolve(dirname(configPath), config.command) : config.command;
  const temporaryCwd = values.cwd ? undefined : await mkdtemp(resolve(tmpdir(), "sudal-acp-probe-"));
  const cwd = values.cwd ? resolve(values.cwd) : temporaryCwd!;
  let client: AcpClient | undefined;
  let commands: SlashCommandDto[] = [];
  let sessionId: string | undefined;
  const earlyCommands = new Map<string, SlashCommandDto[]>();
  let commandUpdate!: () => void;
  const commandsArrived = new Promise<void>(resolve => { commandUpdate = resolve; });
  const report: {
    provider: AcpProvider; initialized?: InitializeResponse; session?: NewSessionResponse;
    capabilities?: ReturnType<typeof acpCapabilities>; commands: SlashCommandDto[];
    startupMs?: number; sessionOpenMs?: number; commandsReceived?: boolean; error?: string;
    modelPromptSent: boolean;
  } = { provider: config.provider, commands: [], modelPromptSent: false };
  try {
    const started = Date.now();
    const pkg: { version: string } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    client = await AcpClient.start({ command, args: config.args, cwd, clientVersion: pkg.version }, {
      onCommands: (id, rows) => {
        if (!sessionId) { earlyCommands.set(id, rows); return; }
        if (id === sessionId) { commands = rows; commandUpdate(); }
      },
      // 진단 명령에서는 도구 실행을 승인하지 않는다.
      requestPermission: async () => null,
    });
    report.startupMs = Date.now() - started;
    report.initialized = client.info;
    report.capabilities = acpCapabilities(client.info);
    if (values.authenticate) await client.authenticate(values.authenticate);
    const opening = Date.now();
    const session = await client.newSession({ cwd, mcpServers: [] });
    report.sessionOpenMs = Date.now() - opening;
    report.session = session;
    sessionId = session.sessionId;
    if (earlyCommands.has(sessionId)) { commands = earlyCommands.get(sessionId)!; commandUpdate(); }
    earlyCommands.clear();
    // 명령 목록 알림은 세션 응답 앞이나 뒤에 도착할 수 있다.
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([commandsArrived.then(() => { report.commandsReceived = true; }), new Promise<void>(r => { wait = setTimeout(r, 2000); })]);
    if (wait) clearTimeout(wait);
    report.commands = commands;
  } catch (error) {
    // SDK·어댑터의 stderr에는 인증 정보가 포함될 수 있어 출력하지 않는다.
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await client?.close();
    if (temporaryCwd) await rm(temporaryCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const json = JSON.stringify(report, null, 2) + "\n";
    if (values.output) await writeFile(resolve(values.output), json, "utf8");
    console.log(json);
  }
}

void run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
