// CLI 가 스스로 쓰는 기본 모델. 앱의 "기본 (CLI 설정)" 항목에 실제 이름을 붙여 주기 위해 설정 파일에서 읽는다 — 이름을 추측하지 않는다.
import fs from "node:fs";
import { join } from "node:path";
import type { Provider } from "@shared/ipc";

/** ~/.claude/settings.json 의 "model", ~/.codex/config.toml 의 최상위 `model = "…"`. 없거나 못 읽으면 null. */
export function readCliDefaultModel(provider: Provider, home: string): string | null {
  try {
    if (provider === "claude") {
      const raw = JSON.parse(fs.readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { model?: unknown };
      return typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
    }
    return codexTopLevelModel(fs.readFileSync(join(home, ".codex", "config.toml"), "utf8"));
  } catch {
    return null;
  }
}

/** TOML 을 다 파싱하지 않고 첫 `[section]` 이전의 `model = "…"` 만 본다(프로필·MCP 섹션의 model 은 다른 뜻). */
export function codexTopLevelModel(toml: string): string | null {
  for (const line of toml.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) break;
    const m = /^model\s*=\s*"([^"]*)"/.exec(t);
    if (m) return m[1].trim() || null;
  }
  return null;
}

/**
 * 사용자가 Codex 에 개발자 지시(developer_instructions)를 직접 정해 두었나. app-server 의 developerInstructions 는
 * 설정의 값에 덧붙지 않고 **대신한다** — 정해 둔 것이 있으면 앱의 지시를 싣지 않아야 사용자의 규칙이 남는다.
 * TOML 을 다 파싱하지 않고 키가 있는지만 본다(프로필 안에 있어도 있는 것으로 친다 — 잃는 쪽보다 안 싣는 쪽이 안전하다).
 */
export function codexHasDeveloperInstructions(env: Record<string, string | undefined>, home: string, cwd: string | null): boolean {
  const files = [join(env.CODEX_HOME?.trim() || join(home, ".codex"), "config.toml")];
  if (cwd) files.push(join(cwd, ".codex", "config.toml"));
  for (const f of files) {
    try {
      if (/^\s*developer_instructions\s*=/m.test(fs.readFileSync(f, "utf8"))) return true;
    } catch {
      /* 없거나 못 읽는 파일은 건너뛴다 */
    }
  }
  return false;
}

/** 관리형 설정. 사용자·프로젝트 설정보다 앞선다. 위치는 운영체제마다 다르다(Claude Code 문서 기준). */
export function claudeManagedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/Library/Application Support/ClaudeCode/managed-settings.json";
}
export const CLAUDE_MANAGED_SETTINGS = claudeManagedSettingsPath();

/**
 * Claude Code 의 showThinkingSummaries 가 켜져 있나. 켜져 있으면 CLI 가 thinking 블록에 추론 요약을 담아 보내고,
 * 꺼져 있으면(기본) 도구 사이 진행 설명만 담는다(display "updates"). 우선순위는 CLI 와 같다: 사용자 < 프로젝트 < 로컬 < 관리형.
 * 사용자 설정 폴더는 CLI 처럼 CLAUDE_CONFIG_DIR 을 따른다.
 */
export function claudeShowsThinkingSummaries(env: Record<string, string | undefined>, home: string, cwd: string | null, managed = CLAUDE_MANAGED_SETTINGS): boolean {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const files = [join(configDir, "settings.json")];
  if (cwd) files.push(join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"));
  files.push(managed);
  let on = false;
  for (const f of files) {
    try {
      const v = (JSON.parse(fs.readFileSync(f, "utf8")) as { showThinkingSummaries?: unknown }).showThinkingSummaries;
      if (typeof v === "boolean") on = v;
    } catch {
      /* 없거나 못 읽는 파일은 건너뛴다 */
    }
  }
  return on;
}

/**
 * thinking 블록을 도구 사이 진행 설명으로 믿어도 되나. CLI 는 Anthropic API 에 직접 붙을 때만 진행 설명 모드(display "updates")를 켠다 —
 * Bedrock·Vertex·Foundry 경로에서는 켜지 않으니 알 수 없는 쪽으로 보고 끈다. showThinkingSummaries 가 켜져 있으면 추론 요약이 섞이니 끈다.
 */
export function claudeProgressNotes(env: Record<string, string | undefined>, home: string, cwd: string | null, managed = CLAUDE_MANAGED_SETTINGS): boolean {
  const on = (k: string) => !!env[k] && env[k] !== "0" && env[k]!.toLowerCase() !== "false";
  if (on("CLAUDE_CODE_USE_BEDROCK") || on("CLAUDE_CODE_USE_VERTEX") || on("CLAUDE_CODE_USE_FOUNDRY")) return false;
  return !claudeShowsThinkingSummaries(env, home, cwd, managed);
}
