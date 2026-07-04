import { contextBridge, ipcRenderer } from "electron";
import type { AppConfig, McpStatus, PiEvent, PiStatus, WorkerEvent } from "../shared/types.js";

const api = {
  startListening: () => ipcRenderer.invoke("worker:startListening") as Promise<void>,
  startWakeword: () => ipcRenderer.invoke("worker:startWakeword") as Promise<void>,
  stopListening: () => ipcRenderer.invoke("worker:stopListening") as Promise<void>,
  speak: (text: string, lengthScale?: number) =>
    ipcRenderer.invoke("worker:speak", text, lengthScale) as Promise<void>,
  stopSpeaking: () => ipcRenderer.invoke("worker:stopSpeaking") as Promise<void>,
  promptPi: (message: string) => ipcRenderer.invoke("pi:prompt", message) as Promise<void>,
  abortPi: () => ipcRenderer.invoke("pi:abort") as Promise<void>,
  getPiCommands: () => ipcRenderer.invoke("pi:getCommands") as Promise<void>,
  getPiStatus: () => ipcRenderer.invoke("pi:getStatus") as Promise<PiStatus>,
  getMcpStatus: () => ipcRenderer.invoke("mcp:getStatus") as Promise<McpStatus>,
  promptAssistant: (message: string) => ipcRenderer.invoke("assistant:prompt", message) as Promise<boolean>,
  clearAssistantContext: () => ipcRenderer.invoke("assistant:clearContext") as Promise<boolean>,
  getConfig: () => ipcRenderer.invoke("app:getConfig") as Promise<AppConfig>,
  saveConfig: (config: AppConfig) => ipcRenderer.invoke("app:saveConfig", config) as Promise<AppConfig>,
  openSettings: () => ipcRenderer.invoke("app:openSettings") as Promise<void>,
  onWorkerEvent: (callback: (event: WorkerEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: WorkerEvent) => callback(event);
    ipcRenderer.on("worker:event", listener);
    return () => ipcRenderer.off("worker:event", listener);
  },
  onPiEvent: (callback: (event: PiEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: PiEvent) => callback(event);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.off("pi:event", listener);
  },
  onPiStatus: (callback: (status: PiStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: PiStatus) => callback(status);
    ipcRenderer.on("pi:status", listener);
    return () => ipcRenderer.off("pi:status", listener);
  },
  onMcpStatus: (callback: (status: McpStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: McpStatus) => callback(status);
    ipcRenderer.on("mcp:status", listener);
    return () => ipcRenderer.off("mcp:status", listener);
  },
  onAssistantState: (callback: (state: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: string) => callback(state);
    ipcRenderer.on("assistant:state", listener);
    return () => ipcRenderer.off("assistant:state", listener);
  }
};

contextBridge.exposeInMainWorld("pythos", api);

declare global {
  interface Window {
    pythos: typeof api;
  }
}
