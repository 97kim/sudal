import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const shared = resolve(__dirname, "src/shared");

// 저장소는 ESM 이다(package.json 의 "type": "module"). 두 AI SDK 가 ESM 전용이라 형식을 맞춘 것이다.
// preload 만 CJS(out/preload/index.cjs)로 번들한다 — 샌드박스(sandbox: true)의 preload 는 ESM 으로 읽히지 않는다.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      rollupOptions: {
        // 메인 창과 화면에 떠 있는 수달 창. 수달 창에는 메인 창의 API 를 열지 않는다.
        input: { index: resolve(__dirname, "src/preload/index.ts"), otter: resolve(__dirname, "src/preload/otter.ts") },
        output: { format: "cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html"), otter: resolve(__dirname, "src/renderer/otter.html") },
      },
    },
    resolve: {
      alias: {
        "@shared": shared,
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
