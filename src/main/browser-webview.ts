// 인앱 브라우저 웹뷰가 스스로 일으키는 일(새 창·우클릭·다운로드)을 main 에서 받는다.
// 웹뷰에는 preload 가 없어 렌더러가 직접 들을 수 없다 — 그 웹뷰를 품은 창(hostWebContents)에 browser:event 로 알린다.
import { app, BrowserWindow, clipboard, Menu, session, shell, type MenuItemConstructorOptions, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { join, parse } from "node:path";
import { IPC, type BrowserEventDto } from "@shared/ipc";
import { mt } from "./i18n";
import { BROWSER_PARTITION } from "./browser-net";

const isWeb = (u: string) => /^https?:\/\//i.test(u);

function notify(contents: WebContents, ev: BrowserEventDto): boolean {
  const host = contents.hostWebContents;
  if (!host || host.isDestroyed()) return false;
  host.send(IPC.browserEvent, ev);
  return true;
}

/** 링크를 새 브라우저 탭으로. 받을 창이 없으면 예전처럼 같은 웹뷰에서 연다. */
function openInTab(contents: WebContents, url: string) {
  if (!isWeb(url)) return;
  if (!notify(contents, { webContentsId: contents.id, kind: "open-tab", url })) void contents.loadURL(url);
}

/** 웹뷰가 붙을 때마다 hardenWebviews 가 부른다. */
export function attachWebviewHandlers(contents: WebContents): void {
  // target=_blank·window.open — 지금 페이지를 덮지 않고 새 탭으로 연다.
  contents.setWindowOpenHandler(({ url }) => {
    openInTab(contents, url);
    return { action: "deny" };
  });
  contents.on("context-menu", (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    const sep = () => {
      if (items.length && items[items.length - 1].type !== "separator") items.push({ type: "separator" });
    };
    if (p.linkURL && isWeb(p.linkURL)) {
      items.push(
        { label: mt("main.browser.menu.openLinkInTab"), click: () => openInTab(contents, p.linkURL) },
        { label: mt("main.browser.menu.openLinkExternal"), click: () => void shell.openExternal(p.linkURL) },
        { label: mt("main.browser.menu.copyLink"), click: () => clipboard.writeText(p.linkURL) },
      );
      sep();
    }
    if (p.mediaType === "image" && isWeb(p.srcURL)) {
      items.push(
        { label: mt("main.browser.menu.copyImage"), click: () => contents.copyImageAt(p.x, p.y) },
        { label: mt("main.browser.menu.copyImageUrl"), click: () => clipboard.writeText(p.srcURL) },
        { label: mt("main.browser.menu.saveImage"), click: () => contents.downloadURL(p.srcURL) },
      );
      sep();
    }
    const selected = p.selectionText.trim();
    if (p.isEditable) {
      items.push(
        { label: mt("main.browser.menu.undo"), enabled: p.editFlags.canUndo, click: () => contents.undo() },
        { label: mt("main.browser.menu.redo"), enabled: p.editFlags.canRedo, click: () => contents.redo() },
        { type: "separator" },
        { label: mt("main.browser.menu.cut"), enabled: p.editFlags.canCut, click: () => contents.cut() },
        { label: mt("main.browser.menu.copy"), enabled: p.editFlags.canCopy, click: () => contents.copy() },
        { label: mt("main.browser.menu.paste"), enabled: p.editFlags.canPaste, click: () => contents.paste() },
        { label: mt("main.browser.menu.selectAll"), click: () => contents.selectAll() },
      );
      sep();
    } else if (selected) {
      const short = selected.length > 24 ? `${selected.slice(0, 24)}…` : selected;
      items.push(
        { label: mt("main.browser.menu.copy"), click: () => contents.copy() },
        {
          label: mt("main.browser.menu.search", { text: short }),
          click: () => openInTab(contents, `https://duckduckgo.com/?q=${encodeURIComponent(selected)}`),
        },
      );
      sep();
    }
    // 링크·이미지·글 위가 아닌 빈 곳이면 이동 메뉴를 준다(크롬과 같다).
    if (items.length === 0) {
      const h = contents.navigationHistory;
      items.push(
        { label: mt("main.browser.menu.back"), enabled: h.canGoBack(), click: () => h.goBack() },
        { label: mt("main.browser.menu.forward"), enabled: h.canGoForward(), click: () => h.goForward() },
        { label: mt("main.browser.menu.reload"), click: () => contents.reload() },
        { type: "separator" },
        { label: mt("main.browser.menu.copyPageUrl"), click: () => clipboard.writeText(contents.getURL()) },
        { type: "separator" },
      );
    }
    items.push({ label: mt("main.browser.menu.inspect"), click: () => contents.inspectElement(p.x, p.y) });
    const host = contents.hostWebContents;
    const win = host ? BrowserWindow.fromWebContents(host) : null;
    Menu.buildFromTemplate(items).popup(win ? { window: win } : {});
  });
}

/** 받은 파일 id → 저장 경로. 렌더러는 id 만 보내고, 연 적 있는 파일만 열거나 보여 준다. */
const downloads = new Map<string, string>();
let downloadSeq = 0;

/** 같은 이름이 있으면 "이름 (1).확장자" 처럼 비킨다. */
function uniquePath(dir: string, name: string): string {
  const { name: base, ext } = parse(name || "download");
  let p = join(dir, `${base}${ext}`);
  for (let n = 1; existsSync(p); n++) p = join(dir, `${base} (${n})${ext}`);
  return p;
}

/** 앱 시작 때 한 번. 묻지 않고 다운로드 폴더에 받고, 진행·결과를 그 브라우저 탭에 알린다. */
export function watchBrowserDownloads(): void {
  session.fromPartition(BROWSER_PARTITION).on("will-download", (_e, item, contents) => {
    if (!contents || contents.getType() !== "webview") return; // 웹뷰가 아니면 Electron 기본(저장 창)에 맡긴다
    const id = `d${++downloadSeq}`;
    const path = uniquePath(app.getPath("downloads"), item.getFilename());
    item.setSavePath(path);
    downloads.set(id, path);
    const name = parse(path).base;
    const send = (state: Extract<BrowserEventDto, { kind: "download" }>["state"]) =>
      notify(contents, {
        webContentsId: contents.id,
        kind: "download",
        id,
        name,
        state,
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
      });
    send("progressing");
    // updated 는 아주 자주 온다 — 진행 표시는 0.5초에 한 번이면 충분하다.
    let last = 0;
    item.on("updated", () => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      send("progressing");
    });
    item.once("done", (_ev, state) => send(state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed"));
  });
}

/** 받은 파일을 연다(open) 또는 폴더에서 보여 준다(reveal). 모르는 id 면 false. */
export function showDownload(id: string, how: "open" | "reveal"): boolean {
  const path = downloads.get(id);
  if (!path || !existsSync(path)) return false;
  if (how === "open") void shell.openPath(path);
  else shell.showItemInFolder(path);
  return true;
}
