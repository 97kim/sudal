// 수달 창(otter.html) 전용 preload. 메인 창의 API 는 열지 않고, 수달이 하는 일만 연다.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OtterApi, OtterViewDto } from "@shared/ipc";
import { OTTER_IPC } from "@shared/otter";

const api: OtterApi = {
  onState(listener: (v: OtterViewDto) => void): () => void {
    const h = (_e: IpcRendererEvent, v: OtterViewDto) => listener(v);
    ipcRenderer.on(OTTER_IPC.state, h);
    return () => ipcRenderer.removeListener(OTTER_IPC.state, h);
  },
  ready: () => ipcRenderer.send(OTTER_IPC.ready),
  /** 마우스가 수달 위에 있을 때만 클릭을 받는다 — 나머지는 아래 창으로 지나간다. */
  setInteractive: (on: boolean) => ipcRenderer.send(OTTER_IPC.interactive, on),
  click: () => ipcRenderer.send(OTTER_IPC.click),
  drag: (dx: number, dy: number) => ipcRenderer.send(OTTER_IPC.drag, dx, dy),
  dragEnd: () => ipcRenderer.send(OTTER_IPC.dragEnd),
  menu: () => ipcRenderer.send(OTTER_IPC.menu),
};

contextBridge.exposeInMainWorld("otter", api);
