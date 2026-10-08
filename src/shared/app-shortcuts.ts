// 앱 단축키 표. 메뉴 가속기(main)와 화면 문구(renderer)가 같은 값을 쓰도록 한곳에 둔다.
// Windows 는 Mod 가 Ctrl 이라 macOS 와 같은 키를 쓰면 터미널의 셸 편집키(Ctrl+W·K·R·L·B·T·F·D)를 앱이 빼앗는다.
// 그래서 그런 키는 Windows Terminal·VS Code 처럼 Ctrl+Shift+… 로 옮긴다.
import { formatShortcut } from "./shortcut";

type Spec = { mac: string; other: string };
const same = (s: string): Spec => ({ mac: s, other: s });

export const APP_SHORTCUTS = {
  newTab: { mac: "Mod+T", other: "Mod+Shift+T" },
  reopenTab: { mac: "Mod+Shift+T", other: "Mod+Shift+Alt+T" },
  closeTab: { mac: "Mod+W", other: "Mod+Shift+W" },
  switchWorkspace: { mac: "Mod+K", other: "Mod+Shift+K" },
  search: { mac: "Mod+F", other: "Mod+Shift+F" },
  sidebar: { mac: "Mod+B", other: "Mod+Shift+B" },
  terminal: { mac: "Mod+J", other: "Mod+Shift+J" },
  widenEditor: same("Mod+Shift+E"),
  browserAddress: { mac: "Mod+L", other: "Mod+Shift+L" },
  browserReload: { mac: "Mod+R", other: "F5" },
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
  // 터미널 안에서만
  termSplitRow: { mac: "Mod+D", other: "Mod+Shift+D" },
  termSplitCol: { mac: "Mod+Shift+D", other: "Mod+Shift+Alt+D" },
} satisfies Record<string, Spec>;

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
