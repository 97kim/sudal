// 단축키 표기와 판정. 문구·코드에는 "Mod+Shift+A" 처럼 적고, 그릴 때 macOS 면 ⌘⇧A, 그 밖에는 Ctrl+Shift+A 로 바꾼다.
// Mod 는 macOS 의 ⌘, Windows·Linux 의 Ctrl 이다(Electron 메뉴의 CmdOrCtrl 과 같다).

// Return 은 Enter 와 같은 키인데 macOS 문구가 ⏎ 로 써 온 자리에 쓴다. Plus 는 + 가 구분자라서 따로 적는다.
const MAC: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", Enter: "↩", Return: "⏎", Backspace: "⌫", Tab: "⇥", Esc: "⎋", Plus: "+" };
const OTHER: Record<string, string> = { Mod: "Ctrl", Return: "Enter", Plus: "+" };
const ARROWS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };

export function formatShortcut(spec: string, mac: boolean): string {
  const parts = spec.split("+").map((k) => ARROWS[k] ?? (mac ? MAC[k] : OTHER[k]) ?? k);
  return mac ? parts.join("") : parts.join("+");
}

/** 눌린 키에 Mod(⌘ 또는 Ctrl)가 들어 있나. 다른 쪽 키(macOS 의 Ctrl, Windows 의 Win 키)는 Mod 가 아니다. */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}
