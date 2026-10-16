import type { NotificationConstructorOptions } from "electron";

/** 태그/객체 수명과 별개로 Windows 알림 자체에 이동할 탭을 보관한다. */
export function notificationOptions(title: string, body: string, tabId: string | undefined, platform: string): NotificationConstructorOptions {
  const options: NotificationConstructorOptions = { title, body: body.slice(0, 200), silent: false };
  if (platform !== "win32") return options;
  const args = new URLSearchParams({ type: "click", sudal: "1" });
  if (tabId) args.set("tab", tabId);
  options.toastXml = `<toast launch="${xml(args.toString())}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(options.body!)}</text></binding></visual></toast>`;
  return options;
}

/** 다른 알림·버튼 동작은 무시한다. null은 탭 없는 Sudal 알림이다. */
export function notificationTarget(details: { type: string; arguments: string }): string | null | undefined {
  if (details.type !== "click" || details.arguments.length > 4096) return undefined;
  const args = new URLSearchParams(details.arguments);
  if (args.get("sudal") !== "1" || args.get("type") !== "click") return undefined;
  return args.get("tab") || null;
}

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
