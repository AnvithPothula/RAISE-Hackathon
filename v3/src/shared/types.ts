export type AssistantState =
  | "idle"
  | "loading"
  | "wakeword"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "shutdown";

export type WorkerEvent =
  | { type: "state"; payload: { value: AssistantState; lowResourceMode?: boolean } }
  | { type: "audio_level"; payload: { value: number } }
  | { type: "partial_transcript"; payload: { text: string } }
  | { type: "final_transcript"; payload: { text: string } }
  | { type: "tts_started"; payload: { text: string } }
  | { type: "tts_done"; payload: { cancelled?: boolean } }
  | { type: "tts_command"; payload: { command: string[] } }
  | { type: "error"; payload: { source: string; message: string; missing?: string[] } };

export type PiEvent = {
  type: string;
  payload: unknown;
};

export type PiStatus = {
  enabled: boolean;
  available: boolean;
  running: boolean;
  command: string | null;
  args: string[];
  reason: string | null;
};

export type ConversationItem = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp: number;
};

export type GeminiThinkLevel = "low" | "medium" | "high" | null;

export type AppConfig = {
  python?: { workerModule: string; lowResourceMode: boolean };
  models?: Record<string, string>;
  audio?: Record<string, unknown>;
  spotify?: { clientId?: string; redirectUri?: string; tokenCache?: string };
  gemini: { model: string; baseUrl?: string; apiKey?: string; think?: GeminiThinkLevel };
  pi: { enabled: boolean; command: string; args: string[]; cwd: string };
  gui: { visualizer: string; showPerformanceStats: boolean; maxTranscriptItems: number };
};
