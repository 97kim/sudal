// Codex 탭의 언어 리마인더. Claude 는 SDK 훅(함수)으로 넣지만 Codex app-server 에는 그런 통로가 없어
// Codex 훅(셸 명령)을 -c 로 등록한다. 훅은 앱이 남겨 둔 JSON 을 내보내기만 하고, 언제 넣을지는 어댑터가 정한다.
// 훅이 넣은 글은 Codex 기록에 developer 메시지로 남는다 — turn/steer 처럼 사용자가 쓴 말로 남지 않는다.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mt } from "./i18n";
import type { CodexAppServer } from "./codex-app-server";

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

function reminder(event: "UserPromptSubmit" | "PostToolUse"): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: mt("prompt.claude.languageReminder") } });
}

/** 훅 스크립트를 준비하고 app-server 에 넘길 -c 인자를 돌려준다. 준비하지 못하면 빈 배열(훅 없이 띄운다). */
export function codexLangHookArgs(): string[] {
  if (!dir) return [];
  const script = join(dir, "lang-reminder.sh");
  try {
    mkdirSync(join(dir, "pending"), { recursive: true });
    let cur = "";
    try {
      cur = readFileSync(script, "utf8");
    } catch {
      // 처음
    }
    // 내용이 그대로면 쓰지 않는다 — 훅 신뢰는 등록 내용의 해시라 스크립트 내용과는 무관하지만, 괜히 건드릴 이유도 없다.
    if (cur !== SCRIPT) writeFileSync(script, SCRIPT);
    chmodSync(script, 0o755);
    // 언어는 바뀔 수 있으니 띄울 때마다 새로 쓴다.
    writeFileSync(join(dir, "user-prompt.json"), reminder("UserPromptSubmit"));
  } catch {
    return [];
  }
  // 앱 데이터 경로에 공백이 있다("Application Support") — 셸 명령으로 넘기니 따옴표로 감싼다.
  const cmd = JSON.stringify(`/bin/sh '${script}'`);
  const handler = `{type="command",command=${cmd},timeout=5}`;
  return ["-c", `hooks.UserPromptSubmit=[{hooks=[${handler}]}]`, "-c", `hooks.PostToolUse=[{matcher="*",hooks=[${handler}]}]`];
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
export async function trustCodexLangHooks(server: CodexAppServer, cwd: string, log?: (line: string) => void): Promise<boolean> {
  if (!dir) return false;
  try {
    const r = await server.request<{ data?: { hooks?: HookMeta[] }[] }>("hooks/list", { cwds: [cwd] }, 10_000);
    const ours = (r.data ?? [])
      .flatMap((e) => e.hooks ?? [])
      .filter((h) => h.source === "sessionFlags" && h.command?.includes("lang-reminder.sh") && h.trustStatus !== "trusted" && h.trustStatus !== "managed");
    if (ours.length === 0) return false;
    // 키에 "." 이 있어(".../config.toml:post_tool_use:0:0") keyPath 로 못 쓴다 — hooks.state 표에 합친다.
    await server.request(
      "config/value/write",
      { keyPath: "hooks.state", mergeStrategy: "upsert", value: Object.fromEntries(ours.map((h) => [h.key, { trusted_hash: h.currentHash }])) },
      10_000,
    );
    log?.(`[codex] 언어 리마인더 훅 신뢰 ${ours.length}개 기록`);
    return true;
  } catch (e) {
    log?.(`[codex] 언어 리마인더 훅 확인 실패: ${(e as Error).message}`);
    return false;
  }
}
