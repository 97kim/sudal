// 이 앱이 도는 운영체제. 단축키 표기·판정과 창 여백(macOS 신호등 자리)이 여기에 기댄다.
import { formatShortcut, isModKey } from "@shared/shortcut";
import { shortcutSpec, type AppShortcut } from "@shared/app-shortcuts";

export const IS_MAC = window.sudal.platform === "darwin";
export const IS_WIN = window.sudal.platform === "win32";

/** "Mod+Shift+A" → macOS ⌘⇧A, 그 밖 Ctrl+Shift+A */
export function sc(spec: string): string {
  return formatShortcut(spec, IS_MAC);
}

/** 앱 단축키 표(메뉴와 같은 값)의 표기. Windows 는 macOS 와 키가 다른 것이 있다. */
export function scApp(name: AppShortcut): string {
  return sc(shortcutSpec(name, IS_MAC));
}

/** Mod(⌘ 또는 Ctrl)가 눌렸나 */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isModKey(e, IS_MAC);
}
