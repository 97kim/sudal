// 실험 연결은 사용자가 지정한 실행 파일만 쓴다. 프로젝트 파일에서 자동 실행 설정을 읽지 않는다.
import fs from "node:fs/promises";
import path from "node:path";
import type { AcpLaunchOptions, AcpProvider } from "./acp-client";

export async function readAcpRuntime(file: string, provider: AcpProvider): Promise<Omit<AcpLaunchOptions, "cwd">> {
  const config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  const entry = config[provider] as { command?: unknown; args?: unknown } | undefined;
  if (!entry || typeof entry.command !== "string" || !entry.command.trim()) throw new Error(`ACP adapter is not configured: ${provider}`);
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== "string"))) throw new Error("ACP args must be a string array");
  const command = !path.isAbsolute(entry.command) && /[\\/]/.test(entry.command) ? path.resolve(path.dirname(file), entry.command) : entry.command;
  return { command, args: entry.args as string[] | undefined };
}
