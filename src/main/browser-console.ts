// 인앱 브라우저(<webview>)의 콘솔을 main 에서도 모은다 — 에이전트의 sudal browser console 용.
// 렌더러 BrowserPane 도 따로 모으지만(진단 첨부) 그건 화면 쪽 메모리라 main 이 읽을 수 없다.
// 메인 프레임이 다른 페이지로 가면 비운다 — 옛 페이지의 오류를 지금 페이지 것으로 오해하지 않게.
import { app, type WebContents } from "electron";
import { DIAG_MAX_CONSOLE, DIAG_MAX_LINE, pushCapped, type ConsoleLine } from "@shared/browser-diagnostics";
import { PICK_CANCEL_MARK, PICK_MARK } from "@shared/element-pick";

/** webContentsId → 최근 콘솔. webContents 가 사라지면 지운다. */
const byContents = new Map<number, ConsoleLine[]>();
let watching = false;

/** Electron 의 등급 이름 → ConsoleLine 의 숫자 등급(진단 첨부와 같은 규칙). */
const LEVEL: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };

function attach(wc: WebContents) {
  const id = wc.id;
  wc.on("console-message", (e) => {
    // 요소 선택 모드가 결과를 콘솔로 돌려보낸다 — 페이지 로그가 아니다
    if (e.message.startsWith(PICK_MARK) || e.message.startsWith(PICK_CANCEL_MARK)) return;
    const line: ConsoleLine = {
      ts: Date.now(),
      level: LEVEL[e.level] ?? 1,
      text: e.message.slice(0, DIAG_MAX_LINE),
      ...(e.sourceId ? { source: e.sourceId } : {}),
      ...(e.lineNumber ? { line: e.lineNumber } : {}),
    };
    byContents.set(id, pushCapped(byContents.get(id) ?? [], line, DIAG_MAX_CONSOLE));
  });
  wc.on("did-navigate", () => byContents.delete(id));
  wc.once("destroyed", () => byContents.delete(id));
}

/** 앱 시작 때 한 번. 이후 붙는 웹뷰마다 건다. */
export function watchBrowserConsole(): void {
  if (watching) return;
  watching = true;
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() === "webview") attach(contents);
  });
}

/** 이 브라우저 탭(webContents)의 최근 콘솔. 없으면 빈 배열. */
export function browserConsoleLines(webContentsId: number): ConsoleLine[] {
  return byContents.get(webContentsId) ?? [];
}
