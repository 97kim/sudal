// 테스트는 Electron 이 아니라 Node 로 돈다. npm 의 electron 패키지는 실행 파일 경로만 내보내서
// ESM 에서 `import { session } from "electron"` 이 링크 단계에서 실패한다.
// 그래서 테스트에서만 electron 을 빈 값으로 바꿔 둔다. main 이 새 이름을 가져오면 여기에 더한다.
import { register } from "node:module";

const NAMES = [
  "app",
  "BrowserWindow",
  "dialog",
  "ipcMain",
  "Menu",
  "nativeTheme",
  "Notification",
  "powerMonitor",
  "safeStorage",
  "session",
  "shell",
  "webContents",
];

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const stub = dataUrl(`${NAMES.map((n) => `export const ${n} = undefined;`).join("\n")}\nexport default {};`);

register(
  dataUrl(`
export async function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: ${JSON.stringify(stub)}, shortCircuit: true };
  return next(specifier, context);
}`),
);
