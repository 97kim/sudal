// 앱 단축키 표. 메뉴 가속기(main)와 화면 문구(renderer)가 같은 값을 쓰도록 한곳에 둔다.
// Windows 는 macOS 의 ⌘ 자리에 Ctrl 을 쓴다(Mod). 그러면 터미널의 셸 편집키(Ctrl+K·R·L·B·T)와 겹치는데,
// 터미널에 포커스가 있을 때만 그 키를 셸에 양보한다(TERMINAL_YIELD_KEYS). 다른 곳에서는 앱 단축키다.
import { formatShortcut } from "./shortcut";

type Spec = { mac: string; other: string };
const same = (s: string): Spec => ({ mac: s, other: s });

export const APP_SHORTCUTS = {
  newTab: same("Mod+T"),
  reopenTab: same("Mod+Shift+T"),
  closeTab: same("Mod+W"),
  switchWorkspace: same("Mod+K"),
  search: same("Mod+F"),
  sidebar: same("Mod+B"),
  terminal: same("Mod+J"),
  widenEditor: same("Mod+Shift+E"),
  browserAddress: same("Mod+L"),
  browserReload: same("Mod+R"),
  browserHardReload: same("Mod+Shift+R"),
  nextAttention: same("Mod+Shift+Down"),
  prevAttention: same("Mod+Shift+Up"),
  nextTab: same("Ctrl+Tab"),
  prevTab: same("Ctrl+Shift+Tab"),
  /** 앞에 숫자 1~9 를 붙인다 */
  tabN: same("Mod"),
  /** macOS 는 앱 메뉴가 없어 설정을 사이드바에서 연다. Windows 는 도움말 메뉴에 둔다. */
  settings: same("Mod+,"),
  /** 터미널·에디터의 선택을 채팅 입력창에 넣기 */
  attach: same("Mod+Shift+A"),
  // 터미널 안에서만. Windows 는 Ctrl+D 가 셸의 EOF(종료)라 빼앗을 수 없어 Shift 를 더한다.
  termSplitRow: { mac: "Mod+D", other: "Mod+Shift+D" },
  termSplitCol: { mac: "Mod+Shift+D", other: "Mod+Shift+Alt+D" },
} satisfies Record<string, Spec>;

/**
 * Windows 에서 터미널에 포커스가 있으면 앱 단축키 대신 셸로 보내는 Ctrl+글자(Shift·Alt 없이).
 * K 줄 끝까지 지우기 · R 기록 검색 · L 화면 지우기 · B 뒤로(tmux 접두키) · T 글자 바꾸기(fzf 파일 찾기).
 * W 는 macOS 의 ⌘W 처럼 터미널을 닫는다 — 기본 셸 PowerShell 은 Ctrl+W 를 쓰지 않는다(단어 지우기는 Ctrl+Backspace).
 * F(찾기)·J(터미널 패널)는 셸에서 거의 안 쓰고 터미널 안에서도 앱 동작이 쓸모 있어 앱에 둔다.
 */
export const TERMINAL_YIELD_KEYS: ReadonlySet<string> = new Set(["K", "R", "L", "B", "T"]);

const CODE_OF: Record<string, string> = { Up: "ArrowUp", Down: "ArrowDown", Tab: "Tab", ",": "Comma" };

/** "Mod+Shift+T" 와 키 입력이 같은가(Windows 기준, Mod = Ctrl). 물리 키(code)로 본다. */
function matchesSpec(spec: string, e: { ctrl: boolean; shift: boolean; alt: boolean; code: string }): boolean {
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => (p === "Mod" ? "Ctrl" : p)));
  if (mods.has("Ctrl") !== e.ctrl || mods.has("Shift") !== e.shift || mods.has("Alt") !== e.alt) return false;
  const code = CODE_OF[key] ?? (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : key);
  return e.code === code;
}

/**
 * Windows 터미널(xterm)이 손대지 말고 앱 메뉴로 넘길 키인가. Windows 는 메뉴보다 렌더러가 키를 먼저 받아서,
 * xterm 이 Ctrl+J(줄바꿈 — 입력하던 명령이 실행된다)·Ctrl+F 를 셸로 보내 버리면 메뉴가 받지 못한다.
 * 셸에 양보하는 키(TERMINAL_YIELD_KEYS)와 터미널 안에서 따로 처리하는 분할·첨부는 뺀다.
 */
export function passesToAppMenu(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }): boolean {
  if (!e.ctrlKey || e.metaKey) return false;
  const input = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code: e.code };
  if (yieldsToTerminal({ control: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, code: e.code })) return false;
  for (const [name, spec] of Object.entries(APP_SHORTCUTS) as [AppShortcut, Spec][]) {
    if (name === "attach" || name === "termSplitRow" || name === "termSplitCol") continue;
    if (name === "tabN") {
      for (let n = 1; n <= 9; n++) if (matchesSpec(`${spec.other}+${n}`, input)) return true;
    } else if (matchesSpec(spec.other, input)) return true;
  }
  return false;
}

/** 이 키 입력을 셸에 양보하나. 한글 입력 중이면 key 가 "ㅈ" 처럼 오므로 물리 키(code: "KeyW")로 본다. */
export function yieldsToTerminal(input: { control: boolean; shift: boolean; alt: boolean; meta: boolean; code: string }): boolean {
  if (!input.control || input.shift || input.alt || input.meta) return false;
  const m = /^Key([A-Z])$/.exec(input.code);
  return !!m && TERMINAL_YIELD_KEYS.has(m[1]);
}

export type AppShortcut = keyof typeof APP_SHORTCUTS;

/** "Mod+Shift+T" 꼴의 키 조합. */
export function shortcutSpec(name: AppShortcut, mac: boolean): string {
  return mac ? APP_SHORTCUTS[name].mac : APP_SHORTCUTS[name].other;
}

/** Electron 메뉴 가속기("CmdOrCtrl+Shift+T"). */
export function accelerator(name: AppShortcut, mac: boolean, suffix = ""): string {
  return (shortcutSpec(name, mac) + suffix).replace(/^Mod(?=\+|$)/, "CmdOrCtrl");
}

/** 화면 문구에 넣는 기본 변수. 문구는 "새 세션 ({{kNewTab}})" 처럼 쓰고 그릴 때 이 값으로 채운다. */
export function shortcutVars(mac: boolean): Record<string, string> {
  const f = (spec: string) => formatShortcut(spec, mac);
  const vars: Record<string, string> = {
    // 클릭과 함께 누르는 키: macOS ⌘클릭, Windows Ctrl+클릭
    kMod: f("Mod+"),
    kAlt: f("Alt+"),
    kShift: f("Shift+"),
    kShiftKey: f("Shift"),
    kTab: f("Tab"),
    kSave: f("Mod+S"),
    kModEnter: f("Mod+Enter"),
    kModReturn: f("Mod+Return"),
    kReturn: f("Return"),
    kShiftReturn: f("Shift+Return"),
    kShiftEnter: mac ? "⇧Enter" : "Shift+Enter",
    kZoomOut: f("Mod+-"),
    kZoomReset: f("Mod+0"),
    kZoomIn: f("Mod+Plus"),
  };
  for (const name of Object.keys(APP_SHORTCUTS) as AppShortcut[]) {
    vars[`k${name[0].toUpperCase()}${name.slice(1)}`] = f(shortcutSpec(name, mac));
  }
  return vars;
}
