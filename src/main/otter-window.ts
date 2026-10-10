// 화면에 떠 있는 수달 창. 투명하고 테두리 없는 작은 창을 항상 위에, 모든 데스크톱과 전체 화면 위에 띄운다.
// 수달이 없는 투명한 부분은 클릭이 아래 창으로 지나간다 — 화면이 마우스가 수달 위에 있을 때만 클릭을 받겠다고 알린다.
import { BrowserWindow, Menu, ipcMain, screen } from "electron";
import { join } from "node:path";
import { OTTER_IPC, OTTER_ROAM, OTTER_ROAM_RANGE, nextRoam, roamPauseMs, type OtterMood, type OtterMotion, type OtterRoamTuning, type OtterState } from "@shared/otter";
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
  /** 시간이 지나 저절로 바뀔 때(끝남 표시가 줄어드는 때) 다시 그리는 타이머. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** 돌아다니기: 켰나, 마우스가 수달 위에 있나, 지금 기분, 다음 출발 타이머, 걷는 중이면 그 상태. */
  private roam = false;
  private tuning: OtterRoamTuning = { pauseSec: OTTER_ROAM_RANGE.pauseSec.default, runPct: OTTER_ROAM_RANGE.runPct.default, distancePct: OTTER_ROAM_RANGE.distancePct.default };
  private hovering = false;
  private mood: OtterMood = "idle";
  private roamTimer: ReturnType<typeof setTimeout> | null = null;
  /** 끄는 중의 위치(소수까지). 끌기가 끝나면 비운다. */
  private dragAt: { x: number; y: number } | null = null;
  private walking: { timer: ReturnType<typeof setInterval>; motion: OtterMotion; dir: 1 | -1; toX: number; x: number; y: number; at: number } | null = null;

  constructor(private readonly deps: OtterDeps) {
    ipcMain.on(OTTER_IPC.interactive, (_e, on: boolean) => {
      this.win?.setIgnoreMouseEvents(!on, { forward: true });
      // 마우스를 올리면 멈춰 선다 — 누르거나 끌려는데 도망가면 안 된다.
      this.hovering = on;
      if (on) this.stopWalk(true);
      // 올리면 기다리던 출발도 취소하고, 빼면 처음부터 다시 쉰다
      this.scheduleRoam();
    });
    ipcMain.on(OTTER_IPC.click, () => this.deps.open(this.deps.state().tabId));
    ipcMain.on(OTTER_IPC.drag, (_e, dx: number, dy: number) => {
      if (!this.win) return;
      this.stopWalk(false);
      // 끄는 동안 위치를 매번 다시 읽어 더하면 소수 배율에서 반올림 오차가 쌓인다 — 시작 위치에 이동량을 누적한다
      if (!this.dragAt) {
        const [x, y] = this.win.getPosition();
        this.dragAt = { x, y };
      }
      this.dragAt.x += dx;
      this.dragAt.y += dy;
      this.moveTo(this.dragAt.x, this.dragAt.y);
    });
    ipcMain.on(OTTER_IPC.dragEnd, () => {
      this.dragAt = null;
      if (!this.win) return;
      const [x, y] = this.win.getPosition();
      this.deps.savePosition({ x, y });
    });
    ipcMain.on(OTTER_IPC.menu, () => this.menu());
    ipcMain.on(OTTER_IPC.ready, () => this.push());
    // 걷는 중에 모니터를 빼거나 배치를 바꾸면 옛 화면 기준으로 계속 걷는다 — 멈추고 화면 안으로 끌어넣는다.
    const onDisplays = () => {
      if (!this.walking || !this.win || this.win.isDestroyed()) return;
      this.stopWalk(false);
      const [x, y] = this.win.getPosition();
      const p = onScreen({ x, y });
      this.moveTo(p.x, p.y);
      this.deps.savePosition(p);
    };
    screen.on("display-removed", onDisplays);
    screen.on("display-metrics-changed", onDisplays);
  }

  /** 설정에 따라 띄우거나 내린다. */
  setEnabled(on: boolean) {
    if (on && !this.win) {
      // 끈 뒤 다시 켜는 것은 "보여 달라" 는 뜻이다 — 걸어 둔 숨기기를 풀고 띄운다.
      this.snoozedUntil = 0;
      if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
      this.snoozeTimer = null;
      this.create();
    }
    else if (!on && this.win) {
      this.stopWalk(false);
      if (this.roamTimer) clearTimeout(this.roamTimer);
      this.roamTimer = null;
      this.win.destroy();
      this.win = null;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** 쉬는 동안 돌아다닐지, 얼마나 자주·빨리·멀리. 값이 바뀌면 기다리던 출발은 새 값으로 다시 잡는다. */
  setRoam(on: boolean, tuning: OtterRoamTuning) {
    const changed = tuning.pauseSec !== this.tuning.pauseSec;
    this.roam = on;
    this.tuning = tuning;
    if (changed && this.roamTimer) {
      clearTimeout(this.roamTimer);
      this.roamTimer = null;
    }
    if (!on) this.stopWalk(true);
    this.scheduleRoam();
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
      this.stopWalk(true);
      if (this.win.isVisible()) this.win.hide();
      return;
    }
    if (!this.win.isVisible()) this.win.showInactive();
    const s = this.deps.state();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = s.refreshAt ? setTimeout(() => this.refresh(), Math.max(0, s.refreshAt - Date.now()) + 50) : null;
    const view: OtterViewDto = { mood: s.mood, count: s.count, bubble: this.deps.bubble(s), dim: this.deps.appFocused() };
    // 할 일이 생기면(승인·끝남·오류·일하는 중) 그 자리에 멈춰서 알린다.
    this.mood = s.mood;
    if (s.mood !== "idle") this.stopWalk(true);
    this.win.webContents.send(OTTER_IPC.state, view);
    this.scheduleRoam();
  }

  private canRoam() {
    return this.roam && !!this.win && !this.win.isDestroyed() && this.win.isVisible() && this.mood === "idle" && !this.hovering && Date.now() >= this.snoozedUntil;
  }

  /** 걷는 중이 아니면 잠시 쉬었다가 출발하도록 걸어 둔다. 돌아다닐 수 없는 때면 걸어 둔 것도 푼다. */
  private scheduleRoam() {
    if (!this.canRoam()) {
      if (this.roamTimer) clearTimeout(this.roamTimer);
      this.roamTimer = null;
      return;
    }
    if (this.walking || this.roamTimer) return;
    this.roamTimer = setTimeout(() => {
      this.roamTimer = null;
      this.startWalk();
    }, roamPauseMs(this.tuning));
  }

  /** 지금 있는 화면 안에서 옆으로 걷거나 뛴다. 높이는 그대로다 — 사람이 놓아 둔 자리를 따라 걷는다. */
  private startWalk() {
    const win = this.win;
    if (!win || !this.canRoam()) return;
    const [x, y] = win.getPosition();
    const wa = screen.getDisplayNearestPoint({ x: Math.round(x + WIDTH / 2), y: Math.round(y + HEIGHT / 2) }).workArea;
    const { motion, toX } = nextRoam(x, wa.x, wa.x + wa.width - WIDTH, this.tuning);
    if (toX === x) return this.scheduleRoam();
    const dir = toX > x ? 1 : -1;
    win.webContents.send(OTTER_IPC.motion, { motion, facing: dir });
    // 매 틱 경과 시간만큼 옮긴다 — 타이머가 밀려도 속도는 그대로다.
    const timer = setInterval(() => {
      const w = this.walking;
      if (!w || !this.win || this.win.isDestroyed()) return this.stopWalk(false);
      const now = Date.now();
      // 절전에서 깨어나면 밀린 시간이 한 번에 들어와 목적지로 튄다 — 한 틱에 0.1초까지만 친다.
      w.x += w.dir * OTTER_ROAM.speed[w.motion] * (Math.min(now - w.at, 100) / 1000);
      w.at = now;
      const arrived = w.dir > 0 ? w.x >= w.toX : w.x <= w.toX;
      this.moveTo(arrived ? w.toX : w.x, w.y);
      if (arrived) this.stopWalk(true);
    }, 33);
    this.walking = { timer, motion, dir, toX, x, y, at: Date.now() };
  }

  /**
   * 창을 옮긴다. Windows 는 배율이 125%·150% 처럼 소수면 위치만 옮겨도 크기를 픽셀↔DIP 로 다시 계산하며
   * 반올림해, 테두리 없는 투명 창이 옮길 때마다 1px 씩 커졌다. 걷기는 초당 30번 옮겨 창이 금세 길어지고,
   * 수달은 창 아래에 붙어 있어 아래로 떨어져 화면 밖으로 나가는 것처럼 보였다. 크기까지 매번 지정한다.
   */
  private moveTo(x: number, y: number) {
    this.win?.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height: HEIGHT });
  }

  /** 멈춰 선다. save 면 선 자리를 저장한다(다음에 켤 때 거기서 시작). */
  private stopWalk(save: boolean) {
    const w = this.walking;
    if (!w) return;
    clearInterval(w.timer);
    this.walking = null;
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(OTTER_IPC.motion, null);
      if (save) {
        const [x, y] = this.win.getPosition();
        this.deps.savePosition({ x, y });
      }
    }
    this.scheduleRoam();
  }

  private create() {
    // 우클릭 메뉴로 끄면 pointerleave 없이 창이 사라진다 — 새 창은 마우스가 안 올라간 상태에서 시작한다.
    this.hovering = false;
    // 끄는 중에 창이 닫히면 dragEnd 가 오지 않는다 — 옛 끌기 위치로 튀지 않게 비운다
    this.dragAt = null;
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
      // macOS: 누르는 순간 Sudal 앱이 앞으로 나오지 않게 한다(non-activating 패널). focusable 만으로는 앱 활성화를
      // 막지 못해, 끌어 옮기려고 누르기만 해도 Sudal 창이 튀어나왔다. 앞으로 가져오는 건 클릭으로 판정됐을 때 main 이 한다.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
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

/**
 * 저장된 위치를 가장 가까운 화면의 작업 영역 안으로 끌어넣는다. 모니터를 빼거나 배치를 바꾸면 저장된 자리가 화면 밖일 수 있다.
 * 중심만 보면 안 된다 — 수달은 창 오른쪽 아래에 있어서 중심이 화면 안이어도 수달은 밖에 그려질 수 있다.
 */
function onScreen(p: { x: number; y: number }): { x: number; y: number } {
  const a = screen.getDisplayNearestPoint({ x: Math.round(p.x + WIDTH / 2), y: Math.round(p.y + HEIGHT / 2) }).workArea;
  return {
    x: Math.min(Math.max(p.x, a.x), a.x + a.width - WIDTH),
    y: Math.min(Math.max(p.y, a.y), a.y + a.height - HEIGHT),
  };
}
