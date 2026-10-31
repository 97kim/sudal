/** 사용자 화면에는 IPC 경로와 오류 클래스 이름 대신 원래 안내·오류 내용을 표시한다. */
export function userErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (;;) {
    const next = message
      .replace(/^Error invoking remote method (?:'[^']*'|"[^"]*"):\s*/, "")
      .replace(/^(?:(?:Error|MsgError):\s*)+/, "");
    if (next === message) return message;
    message = next;
  }
}
