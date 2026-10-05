// 화면에 떠 있는 수달 창. 투명하고 테두리 없는 작은 창을 항상 위에, 모든 데스크톱과 전체 화면 위에 띄운다.
// 수달이 없는 투명한 부분은 클릭이 아래 창으로 지나간다 — 화면이 마우스가 수달 위에 있을 때만 클릭을 받겠다고 알린다.
import { BrowserWindow, Menu, ipcMain, screen } from "electron";
import { join } from "node:path";
import { OTTER_IPC, type OtterState } from "@shared/otter";
import type { OtterViewDto } from "@shared/ipc";

const WIDTH = 240;
const HEIGHT = 160;

export interface OtterDeps {
  state(): OtterState;
  /** 말풍선 문구(없으면 null). 앱 언어로 만든다. */
  bubble(s: OtterState): string | null;
  /** Sudal 창을 보고 있나. 그때는 같은 정보가 앱 안에 있으니 흐리게 둔다. */
  appFocused(): boolean;
  /** 수달을 눌렀다: 그 탭으로(없으면 창만 앞으로). */
  open(tabId: string | null): void;
  openSettings(): void;
  /** 메뉴의 "숨기기" — 설정을 끈다. */
  turnOff(): void;
  loadPosition(): { x: number; y: number } | null;
  savePosition(p: { x: number; y: number }): void;
  menuLabels(): { hide: string; snooze: string; settings: string };
}

export class OtterWindow {
  private win: BrowserWindow | null = null;
  private snoozedUntil = 0;
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(private readonly deps: OtterDeps) {
    ipcMain.on(OTTER_IPC.interactive, (_e, on: boolean) => this.win?.setIgnoreMouseEvents(!on, { forward: true }));
    ipcMain.on(OTTER_IPC.click, () => this.deps.open(this.deps.state().tabId));
    ipcMain.on(OTTER_IPC.drag, (_e, dx: number, dy: number) => {
      if (!this.win) return;
      const [x, y] = this.win.getPosition();
      this.win.setPosition(Math.round(x + dx), Math.round(y + dy));
    });
    ipcMain.on(OTTER_IPC.dragEnd, () => {
      if (!this.win) return;
      const [x, y] = this.win.getPosition();
      this.deps.savePosition({ x, y });
    });
    ipcMain.on(OTTER_IPC.menu, () => this.menu());
    ipcMain.on(OTTER_IPC.ready, () => this.push());
  }

  /** 설정에 따라 띄우거나 내린다. */
  setEnabled(on: boolean) {
    if (on && !this.win) this.create();
    else if (!on && this.win) {
      this.win.destroy();
      this.win = null;
    }
  }

  /** 상태가 바뀌었다. 같은 틱의 여러 변화는 한 번에 보낸다. */
  refresh() {
    if (!this.win || this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.push();
    });
  }

  private push() {
    if (!this.win || this.win.isDestroyed()) return;
    const snoozed = Date.now() < this.snoozedUntil;
    if (snoozed) {
      if (this.win.isVisible()) this.win.hide();
      return;
    }
    if (!this.win.isVisible()) this.win.showInactive();
    const s = this.deps.state();
    const view: OtterViewDto = { mood: s.mood, count: s.count, bubble: this.deps.bubble(s), dim: this.deps.appFocused() };
    this.win.webContents.send(OTTER_IPC.state, view);
  }

  private create() {
    const pos = this.deps.loadPosition() ?? defaultPosition();
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      ...onScreen(pos),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 눌러도 다른 앱의 포커스를 빼앗지 않는다(입력하던 곳에 그대로 남는다).
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/otter.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    // skipTransformProcessType: 이걸 빼면 macOS 에서 Dock 아이콘이 사라진다.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.once("ready-to-show", () => this.push());
    if (process.env.ELECTRON_RENDERER_URL && !process.env.ELECTRON_RENDERER_URL.startsWith("file:")) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/otter.html`);
    } else {
      void win.loadFile(join(import.meta.dirname, "../renderer/otter.html"));
    }
    this.win = win;
  }

  private menu() {
    const l = this.deps.menuLabels();
    Menu.buildFromTemplate([
      { label: l.snooze, click: () => this.snooze(60 * 60 * 1000) },
      { label: l.hide, click: () => this.deps.turnOff() },
      { type: "separator" },
      { label: l.settings, click: () => this.deps.openSettings() },
    ]).popup(this.win ? { window: this.win } : undefined);
  }

  private snooze(ms: number) {
    this.snoozedUntil = Date.now() + ms;
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = setTimeout(() => this.push(), ms + 100);
    this.push();
  }
}

/** 처음엔 주 화면 오른쪽 아래, Dock 바로 위. */
function defaultPosition(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIDTH - 16, y: wa.y + wa.height - HEIGHT - 8 };
}

/** 저장된 위치가 지금 연결된 화면 밖이면(모니터를 뺐다) 기본 위치로. */
function onScreen(p: { x: number; y: number }): { x: number; y: number } {
  const inside = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return p.x + WIDTH / 2 >= a.x && p.x + WIDTH / 2 <= a.x + a.width && p.y + HEIGHT / 2 >= a.y && p.y + HEIGHT / 2 <= a.y + a.height;
  });
  return inside ? p : defaultPosition();
}
