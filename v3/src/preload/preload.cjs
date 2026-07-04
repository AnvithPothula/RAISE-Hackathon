const { contextBridge, ipcRenderer } = require("electron");

const api = {
  startListening: () => ipcRenderer.invoke("worker:startListening"),
  startWakeword: () => ipcRenderer.invoke("worker:startWakeword"),
  stopListening: () => ipcRenderer.invoke("worker:stopListening"),
  speak: (text, lengthScale) => ipcRenderer.invoke("worker:speak", text, lengthScale),
  stopSpeaking: () => ipcRenderer.invoke("worker:stopSpeaking"),
  promptPi: (message) => ipcRenderer.invoke("pi:prompt", message),
  abortPi: () => ipcRenderer.invoke("pi:abort"),
  getPiCommands: () => ipcRenderer.invoke("pi:getCommands"),
  getPiStatus: () => ipcRenderer.invoke("pi:getStatus"),
  getMcpStatus: () => ipcRenderer.invoke("mcp:getStatus"),
  promptAssistant: (message) => ipcRenderer.invoke("assistant:prompt", message),
  clearAssistantContext: () => ipcRenderer.invoke("assistant:clearContext"),
  getConfig: () => ipcRenderer.invoke("app:getConfig"),
  saveConfig: (config) => ipcRenderer.invoke("app:saveConfig", config),
  openSettings: () => ipcRenderer.invoke("app:openSettings"),
  onWorkerEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("worker:event", listener);
    return () => ipcRenderer.off("worker:event", listener);
  },
  onPiEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.off("pi:event", listener);
  },
  onPiStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("pi:status", listener);
    return () => ipcRenderer.off("pi:status", listener);
  },
  onMcpStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("mcp:status", listener);
    return () => ipcRenderer.off("mcp:status", listener);
  },
  onAssistantState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("assistant:state", listener);
    return () => ipcRenderer.off("assistant:state", listener);
  }
};

contextBridge.exposeInMainWorld("pythos", api);
