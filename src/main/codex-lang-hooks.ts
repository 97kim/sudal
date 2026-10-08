// Codex 탭의 언어 리마인더. Claude 는 SDK 훅(함수)으로 넣지만 Codex app-server 에는 그런 통로가 없어
// Codex 훅(셸 명령)을 -c 로 등록한다. 훅은 앱이 남겨 둔 JSON 을 내보내기만 하고, 언제 넣을지는 어댑터가 정한다.
// 훅이 넣은 글은 Codex 기록에 developer 메시지로 남는다 — turn/steer 처럼 사용자가 쓴 말로 남지 않는다.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mt } from "./i18n";
import type { CodexAppServer } from "./codex-app-server";
import { cmdQuote, nodeCmdWrapper } from "./win-proc";

let dir: string | null = null;

/** 앱 데이터 아래 훅 폴더. 정하지 않으면(테스트 등) 훅을 쓰지 않는다. */
export function setCodexHookDir(d: string): void {
  dir = d;
}

// session_id 는 도구 출력에도 나올 수 있어 첫 번째 것만 쓰고, 파일 이름에 쓸 수 있는 글자인지 본다.
const SCRIPT = `#!/bin/sh
# Sudal 이 만든 Codex 훅(언어 리마인더). Sudal 이 띄운 Codex 에서만 등록된다.
d=$(dirname "$0")
in=$(cat)
case "$in" in
  *'"hook_event_name":"UserPromptSubmit"'*) cat "$d/user-prompt.json" 2>/dev/null; exit 0 ;;
esac
id=$(printf '%s' "$in" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
case "$id" in ''|*[!A-Za-z0-9-]*) exit 0 ;; esac
f="$d/pending/$id.json"
if [ -f "$f" ]; then cat "$f"; rm -f "$f"; fi
exit 0
`;

// Windows 에는 /bin/sh 가 없다 — 같은 일을 하는 node 스크립트를 Sudal 실행 파일(ELECTRON_RUN_AS_NODE)로 돌린다.
// 입력·출력·pending 파일 규칙은 위 sh 와 같다.
export const WIN_SCRIPT = `// Sudal 이 만든 Codex 훅(언어 리마인더). Sudal 이 띄운 Codex 에서만 등록된다.
const fs = require("fs");
const path = require("path");
const d = __dirname;
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString("utf8");
  let j = null;
  try { j = JSON.parse(input); } catch {}
  const out = (f) => { try { process.stdout.write(fs.readFileSync(f)); return true; } catch { return false; } };
  if (j && j.hook_event_name === "UserPromptSubmit") { out(path.join(d, "user-prompt.json")); return; }
  const m = /"session_id"\\s*:\\s*"([^"]*)"/.exec(input);
  const id = j && typeof j.session_id === "string" ? j.session_id : m ? m[1] : "";
  if (!/^[A-Za-z0-9-]+$/.test(id)) return;
  const f = path.join(d, "pending", id + ".json");
  if (out(f)) { try { fs.rmSync(f, { force: true }); } catch {} }
});
`;

function reminder(event: "UserPromptSubmit" | "PostToolUse"): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: mt("prompt.claude.languageReminder") } });
}

/** 훅 스크립트를 준비하고 app-server 에 넘길 -c 인자를 돌려준다. 준비하지 못하면 빈 배열(훅 없이 띄운다). */
export function codexLangHookArgs(): string[] {
  if (!dir) return [];
  const win = process.platform === "win32";
  const script = join(dir, win ? "lang-reminder.cjs" : "lang-reminder.sh");
  const wrapper = join(dir, "lang-reminder.cmd");
  try {
    mkdirSync(join(dir, "pending"), { recursive: true });
    // 내용이 그대로면 쓰지 않는다 — 훅 신뢰는 등록 내용의 해시라 스크립트 내용과는 무관하지만, 괜히 건드릴 이유도 없다.
    writeIfChanged(script, win ? WIN_SCRIPT : SCRIPT);
    if (win) writeIfChanged(wrapper, nodeCmdWrapper(process.execPath, `"%~dp0lang-reminder.cjs"`));
    else chmodSync(script, 0o755);
    // 언어는 바뀔 수 있으니 띄울 때마다 새로 쓴다.
    writeFileSync(join(dir, "user-prompt.json"), reminder("UserPromptSubmit"));
  } catch {
    return [];
  }
  // 앱 데이터 경로에 공백이 있다("Application Support") — 셸 명령으로 넘기니 작은따옴표로 감싸고, 경로 속 ' 는 '\'' 로 바꾼다.
  // Windows 의 Codex 는 훅을 cmd.exe /C 로 돌린다 — .cmd 경로를 큰따옴표로 감싸 넘긴다.
  const cmd = JSON.stringify(win ? cmdQuote(wrapper) : `/bin/sh ${shellQuote(script)}`);
  const handler = `{type="command",command=${cmd},timeout=5}`;
  return ["-c", `hooks.UserPromptSubmit=[{hooks=[${handler}]}]`, "-c", `hooks.PostToolUse=[{matcher="*",hooks=[${handler}]}]`];
}

function writeIfChanged(file: string, content: string): void {
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    // 처음
  }
  if (cur !== content) writeFileSync(file, content);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 다음 도구 결과 뒤에 리마인더를 넣게 한다(훅이 한 번 쓰고 지운다). */
export function queueCodexLangReminder(threadId: string): void {
  if (!dir || !/^[A-Za-z0-9-]+$/.test(threadId)) return;
  try {
    writeFileSync(join(dir, "pending", `${threadId}.json`), reminder("PostToolUse"));
  } catch {
    // 못 넣으면 이번에는 넘어간다
  }
}

/** 지난 턴에 남은 것을 지운다(턴이 도구 없이 끝나면 남는다). */
export function clearCodexLangReminder(threadId: string): void {
  if (!dir || !/^[A-Za-z0-9-]+$/.test(threadId)) return;
  rmSync(join(dir, "pending", `${threadId}.json`), { force: true });
}

interface HookMeta {
  key: string;
  command?: string;
  source: string;
  currentHash: string;
  trustStatus: string;
}

/**
 * Codex 는 처음 보는 훅을 신뢰 승인 없이는 돌리지 않고, 승인은 사용자 config.toml 의 hooks.state 에서만 인정한다
 * (-c 로 같이 넘겨도 안 된다). 우리 훅이 승인 전이면 터미널 Codex 에서 승인할 때와 같은 항목을 써 넣는다.
 * 사용자가 허락한 동작이다(2026-10-07). 다른 훅·설정은 건드리지 않는다.
 */
export function trustCodexLangHooks(server: CodexAppServer, cwd: string, log?: (line: string) => void): Promise<boolean> {
  if (!dir || trusted) return Promise.resolve(false);
  // 탭 여러 개가 한꺼번에 Codex 를 띄우면 config.toml 쓰기가 겹쳐 사용자 설정 변경이 사라질 수 있다 — 한 번에 하나씩.
  const run = trustQueue.then(() => (trusted ? false : trustNow(server, cwd, log)));
  trustQueue = run.catch(() => false);
  return run;
}

/** 이번 실행에서 우리 훅이 신뢰된 것을 확인했다. 등록 내용은 실행 중에 바뀌지 않으니 다시 보지 않는다. */
let trusted = false;
let trustQueue: Promise<unknown> = Promise.resolve();

async function trustNow(server: CodexAppServer, cwd: string, log?: (line: string) => void): Promise<boolean> {
  try {
    const r = await server.request<{ data?: { hooks?: HookMeta[] }[] }>("hooks/list", { cwds: [cwd] }, 10_000);
    const ours = (r.data ?? [])
      .flatMap((e) => e.hooks ?? [])
      .filter((h) => h.source === "sessionFlags" && /lang-reminder\.(sh|cmd)/.test(h.command ?? ""));
    const untrusted = ours.filter((h) => h.trustStatus !== "trusted" && h.trustStatus !== "managed");
    if (untrusted.length === 0) {
      trusted = ours.length > 0;
      return false;
    }
    // 키에 "." 이 있어(".../config.toml:post_tool_use:0:0") keyPath 로 못 쓴다 — hooks.state 표에 합친다.
    await server.request(
      "config/value/write",
      { keyPath: "hooks.state", mergeStrategy: "upsert", value: Object.fromEntries(untrusted.map((h) => [h.key, { trusted_hash: h.currentHash }])) },
      10_000,
    );
    trusted = true;
    log?.(`[codex] 언어 리마인더 훅 신뢰 ${untrusted.length}개 기록`);
    return true;
  } catch (e) {
    log?.(`[codex] 언어 리마인더 훅 확인 실패: ${(e as Error).message}`);
    return false;
  }
}
