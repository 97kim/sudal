// 인앱 브라우저(<webview>, partition "persist:sudal-browser")의 실패한 요청을 모은다.
// webRequest 는 session 에 하나뿐이고 같은 이벤트에 마지막 리스너만 살아남는다 — 그래서 여기 한 곳에서만 건다.
// 어느 브라우저 탭의 요청인지는 details.webContentsId 로 갈라 담는다(탭마다 링 버퍼).
import { session, type Session } from "electron";
import { DIAG_MAX_NET, pushCapped, type NetFailure } from "@shared/browser-diagnostics";

export const BROWSER_PARTITION = "persist:sudal-browser";

/** webContentsId → 최근 실패. 탭이 사라지면 그 자리도 지운다(webContents 소멸을 못 보므로 상한으로 막는다). */
const byContents = new Map<number, NetFailure[]>();
/** 브라우저 탭이 이만큼 넘게 쌓이면 가장 오래 안 쓴 것부터 버린다. */
const MAX_CONTENTS = 24;
let attached: Session | null = null;

function put(id: number | undefined, f: NetFailure) {
  if (typeof id !== "number" || id < 0) return;
  const cur = byContents.get(id) ?? [];
  // 다시 넣으면서 맵의 삽입 순서를 갱신한다(오래된 탭을 버릴 때 기준)
  byContents.delete(id);
  byContents.set(id, pushCapped(cur, f, DIAG_MAX_NET));
  while (byContents.size > MAX_CONTENTS) {
    const oldest = byContents.keys().next();
    if (oldest.done) break;
    byContents.delete(oldest.value);
  }
}

/** 앱 시작 때 한 번. 같은 세션에 두 번 걸지 않는다. */
export function watchBrowserNetwork(): void {
  const s = session.fromPartition(BROWSER_PARTITION);
  if (attached === s) return;
  attached = s;
  // 통신 자체가 깨진 것 (DNS·연결 거부·중단 등)
  s.webRequest.onErrorOccurred((d) => {
    // 사용자가 페이지를 떠나며 취소된 요청은 오류가 아니다
    if (d.error === "net::ERR_ABORTED") return;
    put(d.webContentsId, {
      ts: Date.now(),
      url: d.url,
      method: d.method,
      error: d.error,
      status: 0,
      resourceType: d.resourceType,
    });
  });
  // 응답은 왔지만 4xx·5xx
  s.webRequest.onCompleted((d) => {
    if (d.statusCode < 400) return;
    put(d.webContentsId, {
      ts: Date.now(),
      url: d.url,
      method: d.method,
      error: null,
      status: d.statusCode,
      resourceType: d.resourceType,
    });
  });
}

/** 이 브라우저 탭(webContents)의 최근 실패. 없으면 빈 배열. */
export function browserNetFailures(webContentsId: number): NetFailure[] {
  return byContents.get(webContentsId) ?? [];
}

/** 진단을 붙인 뒤 다음 재현을 깨끗하게 보려면 비운다. */
export function clearBrowserNetFailures(webContentsId: number): void {
  byContents.delete(webContentsId);
}
