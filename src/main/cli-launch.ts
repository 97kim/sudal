// CLI 실행 파일을 띄울 명령으로 바꾼다. macOS 는 경로를 그대로 쓴다.
// Windows 의 npm 전역 설치는 claude.cmd·codex.cmd 같은 배치 파일인데, Node 는 .cmd/.bat 을 shell 없이
// spawn·execFile 하면 EINVAL 로 거절한다(CVE-2024-27980 이후). shell: true 로 돌리면 인자를 cmd.exe 규칙으로
// 다시 인용해야 하고 % 는 막을 길이 없어서, 먼저 npm shim 이 가리키는 진짜 대상(.exe 또는 .js)을 읽어 그것을 띄운다.

import fs from "node:fs";
import path from "node:path";

export interface LaunchSpec {
  command: string;
  args: string[];
  /** true 면 command·args 는 이미 cmd.exe 규칙으로 인용돼 있다(shell: true 로 넘긴다). */
  shell?: boolean;
}

export function isBatchFile(p: string): boolean {
  return /\.(cmd|bat)$/i.test(p);
}

/**
 * npm cmd-shim 이 실행하는 대상의 절대 경로. 형식(요지):
 *   IF EXIST "%dp0%\node.exe" ( SET "_prog=%dp0%\node.exe" ) ELSE ( SET "_prog=node" ... )
 *   endLocal & ... "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 * 네이티브 바이너리를 가리키는 shim 은 "%dp0%\...\claude.exe" %* 만 있다. 마지막 "%dp0%\..." 가 대상이고 node.exe 는 실행기다.
 * 옛 형식의 %~dp0 도 받는다. 모르는 형식이면 null.
 */
export function parseCmdShimTarget(text: string, shimPath: string): string | null {
  const dir = path.win32.dirname(shimPath);
  const found = [...text.matchAll(/"%~?dp0%?\\([^"%]+)"/gi)].map((m) => m[1]).filter((rel) => !/^node\.exe$/i.test(rel));
  const rel = found.at(-1);
  return rel ? path.win32.join(dir, rel) : null;
}

/** cmd.exe 한 인자 인용: 큰따옴표로 감싸고 안의 큰따옴표는 두 번. 셸 메타 문자(& | < > ^)는 따옴표 안이라 그대로 둔다. */
export function quoteCmdArg(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * binPath 를 args 와 함께 띄울 명령. win32 의 .cmd/.bat 만 바꾼다:
 * shim 대상이 .exe 면 그 exe, .js 면 node <js>, 못 읽으면 cmd.exe 를 거친다(shell: true).
 */
export function launchSpec(
  binPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  readText: (p: string) => string | null = readTextOrNull,
): LaunchSpec {
  if (platform !== "win32" || !isBatchFile(binPath)) return { command: binPath, args };
  const text = readText(binPath);
  const target = text ? parseCmdShimTarget(text, binPath) : null;
  if (target && /\.exe$/i.test(target)) return { command: target, args };
  if (target && /\.(c|m)?js$/i.test(target)) return { command: "node", args: [target, ...args] };
  return { command: quoteCmdArg(binPath), args: args.map(quoteCmdArg), shell: true };
}

/**
 * Claude Agent SDK 의 pathToClaudeCodeExecutable 로 넘길 값. SDK 는 .js 면 node 로, 아니면 그 파일을 shell 없이 spawn 한다 —
 * .cmd 를 그대로 주면 EINVAL 이다. shim 대상(.exe·.js)을 못 찾으면 null.
 */
export function claudeExecutableFor(binPath: string, platform: NodeJS.Platform = process.platform, readText: (p: string) => string | null = readTextOrNull): string | null {
  if (platform !== "win32" || !isBatchFile(binPath)) return binPath;
  const text = readText(binPath);
  const target = text ? parseCmdShimTarget(text, binPath) : null;
  // SDK 가 node 로 돌리는 확장자는 .js·.mjs 등이고 .cjs 는 빠져 있다
  return target && /\.(exe|js|mjs)$/i.test(target) ? target : null;
}

function readTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
