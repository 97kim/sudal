// 앱이 직접 처리하는 슬래시 커맨드. CLI 로 보내지 않고 앱 UI 를 연다 — SDK 모드에서는 /model·/config 가 TUI 화면을 못 띄우기 때문.
import type { TFunction } from "i18next";
import type { SlashCommandDto } from "./slash-commands";
import { mergeSlashCommands } from "./slash-commands";

export type AppCommandName = "model" | "config" | "mcp";

export function appCommands(t: TFunction): (SlashCommandDto & { name: AppCommandName })[] {
  return [
    { name: "model", description: t("session.appCommand.model"), argumentHint: t("session.appCommand.modelHint") },
    { name: "config", description: t("session.appCommand.config"), argumentHint: "" },
    { name: "mcp", description: t("session.appCommand.mcp"), argumentHint: "" },
  ];
}

/** 입력이 앱 처리 커맨드면 이름과 인자(공백 정리)를 돌려준다. `/model`, `/model opus`, `/config` … 그 외는 null. */
export function parseAppCommand(text: string): { name: AppCommandName; arg: string } | null {
  const m = /^\/(model|config|mcp)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1] as AppCommandName, arg: (m[2] ?? "").trim() };
}

/** CLI 가 준 목록에 앱 처리 커맨드를 앞에 합친다. 같은 이름은 앱 설명으로 바꾼다(팔레트에서 "앱에서 처리" 가 보이게). */
export function withAppCommands(t: TFunction, commands: SlashCommandDto[]): SlashCommandDto[] {
  const own = appCommands(t);
  const app = new Set<string>(own.map((c) => c.name));
  return [...own, ...commands.filter((c) => !app.has(c.name))];
}

/** `/model` 인자 → 설정할 모델 문자열. "기본"·"default"·"" 는 CLI 기본값(빈 문자열). */
export function modelFromArg(arg: string): string {
  const a = arg.trim();
  // i18n-ignore: 별칭 정규식(한국어 입력도 받는다)
  if (!a || /^(기본|default|reset)$/i.test(a)) return "";
  return a.split(/\s+/)[0];
}

/**
 * Codex 탭의 "/" 명령. Codex 의 "/" 명령은 터미널 화면(TUI) 쪽 기능이라 app-server 는 목록도 실행도 주지 않는다 —
 * Codex CLI 와 같은 이름 중 Sudal 기능으로 할 수 있는 것만 앱이 처리한다. 나머지는 모델에게 글로 가 버리므로 넣지 않는다.
 */
export type CodexCommandName = "model" | "config" | "new" | "clear" | "compact" | "rename" | "cd" | "init" | "skills";
const CODEX_COMMANDS: CodexCommandName[] = ["model", "new", "clear", "compact", "rename", "cd", "init", "skills", "config"];

export function codexCommands(t: TFunction): SlashCommandDto[] {
  return CODEX_COMMANDS.map((name) => ({
    name,
    description: t(`session.codexCommand.${name}`),
    argumentHint: name === "model" ? t("session.codexCommand.modelHint") : name === "rename" ? t("session.codexCommand.renameHint") : "",
    ...(name === "skills" ? { insert: "$" } : {}),
  }));
}

/** Codex 탭 입력이 앱이 처리할 "/" 명령이면 이름과 인자. 그 외는 null. */
export function parseCodexCommand(text: string): { name: CodexCommandName; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !(CODEX_COMMANDS as string[]).includes(m[1])) return null;
  return { name: m[1] as CodexCommandName, arg: (m[2] ?? "").trim() };
}

/** ACP 에이전트 명령은 그대로 실행한다. 대화 비우기·이름·경로·앱 설정만 Sudal이 소유한다. */
const ACP_APP_COMMANDS = new Set(["config", "new", "clear", "rename", "cd"]);
export function acpCommands(t: TFunction, commands: SlashCommandDto[]): SlashCommandDto[] {
  return mergeSlashCommands(codexCommands(t).filter(command => ACP_APP_COMMANDS.has(command.name)), commands);
}
export function parseAcpAppCommand(text: string): { name: CodexCommandName; arg: string } | null {
  const command = parseCodexCommand(text);
  return command && ACP_APP_COMMANDS.has(command.name) ? command : null;
}

/**
 * Antigravity(agy) 탭의 "/" 명령.
 * - 앱이 직접 처리하는 명령(model, new, clear, compact, rename, cd, init, config, mcp)
 * - agy 에이전트가 프롬프트에서 직접 이해·수행하는 워크플로 명령(/plan, /boost, /goal, /grill-me, /teamwork, /browser, /schedule, /learn)
 */
export type AgyAppCommandName = "model" | "config" | "mcp" | "new" | "clear" | "compact" | "rename" | "cd" | "init";
export type AgyPromptCommandName = "plan" | "boost" | "goal" | "grill-me" | "teamwork" | "browser" | "schedule" | "learn";

const AGY_APP_COMMANDS: AgyAppCommandName[] = ["model", "new", "clear", "compact", "rename", "cd", "init", "config", "mcp"];
const AGY_PROMPT_COMMANDS: AgyPromptCommandName[] = ["plan", "boost", "goal", "grill-me", "teamwork", "browser", "schedule", "learn"];

export function agyCommands(t: TFunction): SlashCommandDto[] {
  const appRows: SlashCommandDto[] = AGY_APP_COMMANDS.map((name) => ({
    name,
    description: name === "mcp" ? t("session.appCommand.mcp") : t(`session.codexCommand.${name}`),
    argumentHint:
      name === "model"
        ? t("session.codexCommand.modelHint")
        : name === "rename"
          ? t("session.codexCommand.renameHint")
          : "",
  }));
  const promptRows: SlashCommandDto[] = AGY_PROMPT_COMMANDS.map((name) => ({
    name,
    description: t(`session.agyCommand.${name}`),
    argumentHint: t("session.agyCommand.promptHint"),
  }));
  return [...appRows, ...promptRows];
}

/** Antigravity 탭 입력이 앱이 가로채 처리할 "/" 명령이면 이름과 인자. (/plan 등은 에이전트에게 그대로 보내므로 null) */
export function parseAgyAppCommand(text: string): { name: AgyAppCommandName; arg: string } | null {
  const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !(AGY_APP_COMMANDS as string[]).includes(m[1])) return null;
  return { name: m[1] as AgyAppCommandName, arg: (m[2] ?? "").trim() };
}
