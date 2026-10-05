import type { SudalApi } from "@shared/ipc";

declare global {
  interface Window {
    sudal: SudalApi;
  }
}

export {};
