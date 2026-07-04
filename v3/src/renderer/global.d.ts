import type { AppConfig, McpStatus, PiEvent, PiStatus, WorkerEvent } from "../shared/types";

declare global {
  interface Window {
    pythos: {
      startListening: () => Promise<void>;
      startWakeword: () => Promise<void>;
      stopListening: () => Promise<void>;
      speak: (text: string, lengthScale?: number) => Promise<void>;
      stopSpeaking: () => Promise<void>;
      promptPi: (message: string) => Promise<void>;
      abortPi: () => Promise<void>;
      getPiCommands: () => Promise<void>;
      getPiStatus: () => Promise<PiStatus>;
      getMcpStatus: () => Promise<McpStatus>;
      promptAssistant: (message: string) => Promise<boolean>;
      clearAssistantContext: () => Promise<boolean>;
      getConfig: () => Promise<AppConfig>;
      saveConfig: (config: AppConfig) => Promise<AppConfig>;
      openSettings: () => Promise<void>;
      onWorkerEvent: (callback: (event: WorkerEvent) => void) => () => void;
      onPiEvent: (callback: (event: PiEvent) => void) => () => void;
      onPiStatus: (callback: (status: PiStatus) => void) => () => void;
      onMcpStatus: (callback: (status: McpStatus) => void) => () => void;
      onAssistantState: (callback: (state: string) => void) => () => void;
    };
  }
}

export {};
