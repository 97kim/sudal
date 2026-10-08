// Windows 앱 업데이트. macOS 는 brew 로 갈아 끼우지만(app-update.ts) Windows 는 설치 프로그램(NSIS, 사용자 단위 설치)이
// 관리자 권한 없이 덮어쓸 수 있어 electron-updater 로 앱 안에서 받는다. 릴리즈의 latest.yml 을 읽는다(scripts/release.sh 가 올린다).
// 서명이 없어 app-update.yml 에 publisherName 이 없고, 그러면 electron-updater 는 서명 검증을 건너뛴다.
//
// 저절로 받지는 않는다 — 사용자가 업데이트를 누를 때 받고, 다시 시작을 누르면 조용히 설치하고 새 버전을 띄운다.
// 받아 둔 채 그냥 끄면 끌 때 설치한다(autoInstallOnAppQuit 기본값).

import type { AppUpdater } from "electron-updater";
import type { UpdateProgress } from "./app-update";
import { mt } from "./i18n";

let updater: Promise<AppUpdater> | null = null;
let downloaded = false;

/** macOS 에서는 불러오지도 않게 처음 쓸 때 가져온다. */
function getUpdater(): Promise<AppUpdater> {
  updater ??= import("electron-updater").then((m) => {
    // CJS 라 autoUpdater 가 getter 로 붙어 있어 ESM 이름 가져오기로는 안 보일 수 있다
    const u = (m.autoUpdater ?? (m as unknown as { default: typeof m }).default.autoUpdater) as AppUpdater;
    u.autoDownload = false;
    return u;
  });
  return updater;
}

/** target 버전을 받는다. 다 받으면 installed 로 보고, 설치는 quitAndInstall 에서 한다. */
export async function winDownloadUpdate(
  target: string,
  onProgress: (p: UpdateProgress) => void,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const u = await getUpdater();
    onProgress({ phase: "checking" });
    // downloadUpdate 는 직전 checkForUpdates 가 찾은 것을 받는다
    const r = await u.checkForUpdates();
    const version = r?.updateInfo.version;
    // GitHub 의 최신 릴리즈(확인에 쓴 것)보다 Windows 용 latest.yml 이 늦게 올라온 구간
    if (!r || !version || !r.isUpdateAvailable)
      return { ok: false, error: mt("main.update.notYetForWindows", { target, available: version ?? mt("main.update.unknownVersion") }) };
    onProgress({ phase: "downloading", percent: 0 });
    let last = -1;
    const onDownload = (p: { percent: number }) => {
      // 다 받고 확인하는 사이에 100 을 보이지 않게 99 에서 멈춘다(macOS 쪽과 같다)
      const percent = Math.max(0, Math.min(99, Math.floor(p.percent)));
      if (percent === last) return;
      last = percent;
      onProgress({ phase: "downloading", percent });
    };
    u.on("download-progress", onDownload);
    try {
      await u.downloadUpdate();
    } finally {
      u.off("download-progress", onDownload);
    }
    downloaded = true;
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 받아 둔 업데이트가 있으면 조용히 설치하고 새 버전을 띄운다. 없으면 false — 그때는 그냥 다시 시작한다. */
export async function winQuitAndInstall(): Promise<boolean> {
  if (!downloaded) return false;
  (await getUpdater()).quitAndInstall(true, true);
  return true;
}
