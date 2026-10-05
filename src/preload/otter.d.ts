import type { OtterApi } from "@shared/ipc";

declare global {
  interface Window {
    /** 수달 창(otter.html)에서만 있다. */
    otter: OtterApi;
  }
}

export {};
