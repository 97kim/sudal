// 웹뷰의 did-fail-load 오류(Chromium 의 ERR_*)를 사용자가 할 일로 묶는다. 이름·안내는 사전(`panel.browser.error.<kind>`)에서.
export type BrowserErrorKind = "refused" | "notFound" | "offline" | "timeout" | "cert" | "blocked" | "generic";

export function browserErrorKind(description: string): BrowserErrorKind {
  const d = description.toUpperCase();
  // 개발 서버가 꺼져 있을 때 가장 흔하다 — localhost 는 거의 이것.
  if (d.includes("CONNECTION_REFUSED") || d.includes("ADDRESS_UNREACHABLE")) return "refused";
  if (d.includes("NAME_NOT_RESOLVED") || d.includes("NAME_RESOLUTION_FAILED")) return "notFound";
  if (d.includes("INTERNET_DISCONNECTED") || d.includes("NETWORK_CHANGED")) return "offline";
  if (d.includes("TIMED_OUT")) return "timeout";
  if (d.includes("CERT_") || d.includes("SSL_")) return "cert";
  // 브라우저가 스스로 막는 경우 — 다시 시도해도 같은 결과라 다시 시도 버튼을 주지 않는다.
  if (d.includes("UNSAFE_PORT") || d.includes("BLOCKED_BY")) return "blocked";
  return "generic";
}
