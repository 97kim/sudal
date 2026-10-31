// 슬래시 커맨드 목록(Claude Agent SDK 의 SlashCommand)과 입력창 자동완성용 순수 함수.

export type SlashCommandSource = "sudal" | "claude" | "codex" | "agy";
export const COMMAND_SOURCE_LABELS: Record<SlashCommandSource, string> = { sudal: "Sudal", claude: "Claude", codex: "Codex", agy: "Antigravity" };

export interface SlashCommandDto {
  /** 기능 제공 주체. 앱이 명령을 가로채는지(clientHandled)와는 구분한다. */
  source?: SlashCommandSource;
  /** 선행 슬래시 없는 이름 */
  name: string;
  description: string;
  /** 인자 힌트. 예: "<file>" */
  argumentHint: string;
  aliases?: string[];
  /** 고르면 "/이름 " 대신 입력창에 넣을 글. Codex 의 /skills 는 "$" 를 넣어 스킬 목록을 연다. */
  insert?: string;
  /** CLI 화면 대신 앱이 직접 처리하는 명령은 터미널 전용 이름이어도 표시한다. */
  clientHandled?: boolean;
}

/**
 * 터미널 UI 에 묶여 SDK 환경에서 동작하지 않는 명령. init 메시지의 terminal_slash_commands 가 있으면
 * 그것을 우선 쓰고, 이 목록은 그 필드를 주지 않는 CLI 를 위한 폴백이다.
 */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "exit",
  "quit",
  "resume",
  "statusline",
  "terminal-setup",
  "vim",
  "theme",
  "login",
  "logout",
  "ide",
  "bug",
  "doctor",
]);

/**
 * 입력 텍스트가 "/" 로 시작하고 아직 공백이 없으면 커맨드 검색어(슬래시 제외)를 돌려준다.
 * "/co" → "co", "/" → "", "/compact 지금" → null (인자 입력 단계), "안녕" → null.
 */
export function parseSlashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1] : null;
}

/** `/__remote-workflow`, `/plugin:_config` 처럼 밑줄로 시작하는 이름은 내부용이라 숨긴다. */
export function isInternalCommand(name: string): boolean {
  return name.split(":").pop()!.startsWith("_");
}

/** 이름·별칭 접두 일치를 앞에, 이름 부분 일치를 뒤에. 터미널 전용·내부용은 제외. 설명은 검색하지 않는다. */
export function filterCommands(
  commands: SlashCommandDto[],
  query: string,
  terminal: ReadonlySet<string> = TERMINAL_ONLY_COMMANDS,
): SlashCommandDto[] {
  const q = query.toLowerCase();
  const names = (c: SlashCommandDto) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const prefix: SlashCommandDto[] = [];
  const partial: SlashCommandDto[] = [];
  for (const c of commands) {
    if ((terminal.has(c.name) && !c.clientHandled) || isInternalCommand(c.name)) continue;
    const ns = names(c);
    if (!q || ns.some((n) => n.startsWith(q))) prefix.push(c);
    else if (ns.some((n) => n.includes(q))) partial.push(c);
  }
  const byName = (a: SlashCommandDto, b: SlashCommandDto) => a.name.localeCompare(b.name);
  return [...prefix.sort(byName), ...partial.sort(byName)];
}
