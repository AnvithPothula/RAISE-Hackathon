export type AssistantState =
  | "idle"
  | "loading"
  | "wakeword"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "shutdown";

/** The voice engine currently serving STT/TTS turns. */
export type VoiceEngine = "gradium" | "local";

/**
 * Live voice-pipeline mode reported by the Python worker whenever the
 * network-state detector changes the effective engine. Drives the demo HUD
 * ("Voice: Gradium (cloud)" / "Voice: Local (offline)").
 */
export type VoiceModePayload = {
  engine: VoiceEngine;
  /** Result of the last reachability probe. */
  online: boolean;
  /** Whether a Gradium API key is configured at all. */
  gradiumConfigured: boolean;
  /** Engine serving speech recognition: cloud, offline model, or none. */
  stt: "gradium" | "vosk" | "unavailable";
  /** Engine serving speech synthesis: cloud, Piper, OS voice, or none. */
  tts: "gradium" | "piper" | "system" | "unavailable";
  /** Human-readable cause of the last mode evaluation. */
  reason?: string;
};

export type WorkerEvent =
  | { type: "state"; payload: { value: AssistantState; lowResourceMode?: boolean } }
  | { type: "audio_level"; payload: { value: number } }
  | { type: "partial_transcript"; payload: { text: string } }
  | { type: "final_transcript"; payload: { text: string } }
  | { type: "tts_started"; payload: { text: string; engine?: VoiceEngine } }
  | { type: "tts_done"; payload: { cancelled?: boolean } }
  | { type: "tts_command"; payload: { command: string[] } }
  | { type: "voice_mode"; payload: VoiceModePayload }
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

/** How the local model chooses its thinking level. */
export type ThinkMode = "auto" | "on" | "off";

/** Explicit reasoning depth for supported Ollama models. */
export type ThinkLevel = "none" | "low" | "medium" | "high";

/**
 * Which build of the local Gemma weights Ollama should serve.
 * "mlx" requests the Apple-Silicon MLX variant (e.g. gemma4:12b-mlx) for
 * higher token throughput; it silently falls back to the standard build on
 * unsupported hosts or when the MLX tag is not pulled.
 */
export type EngineVariant = "standard" | "mlx";

/** Per-request inference metrics reported by the local Ollama runtime. */
export type ModelStats = {
  model: string;
  /** Generation speed in tokens per second. */
  tokensPerSecond: number;
  /** Time to first token (prompt eval + load) in seconds. */
  ttftSeconds: number;
  evalCount: number;
  totalSeconds: number;
  thinking: boolean;
  thinkReason?: string;
  /** Intent router tool scope for this request (none/minimal/standard/full). */
  toolScope?: string;
  at: number;
};

export type McpTransportKind = "stdio" | "http";

export type McpServerConfig = {
  /** Unique, stable identifier used to namespace this server's tools. */
  name: string;
  /** When false, the server is skipped at startup. Defaults to true. */
  enabled?: boolean;
  /** Transport used to reach the server. Defaults to "stdio". */
  transport?: McpTransportKind;
  /** stdio: executable to launch (e.g. "npx", "node", "python"). */
  command?: string;
  /** stdio: arguments passed to the command. */
  args?: string[];
  /** stdio: extra environment variables for the spawned server. */
  env?: Record<string, string>;
  /** stdio: working directory for the spawned server. */
  cwd?: string;
  /** http: base URL of a streamable HTTP MCP server. */
  url?: string;
  /** http: extra HTTP headers (e.g. Authorization) sent to the server. */
  headers?: Record<string, string>;
};

export type McpConfig = {
  enabled: boolean;
  servers: McpServerConfig[];
};

export type McpServerStatus = {
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error: string | null;
};

export type McpStatus = {
  enabled: boolean;
  servers: McpServerStatus[];
};

export type AppConfig = {
  python?: { workerModule: string; lowResourceMode: boolean };
  models?: Record<string, string>;
  audio?: Record<string, unknown>;
  spotify?: { clientId?: string; redirectUri?: string; tokenCache?: string };
  ollama: {
    model: string;
    baseUrl?: string;
    lowResourceModel?: string;
    think?: ThinkMode;
    thinkLevel?: ThinkLevel;
    engineVariant?: EngineVariant;
  };
  openrouter?: {
    enabled?: boolean;
    model?: string;
    baseUrl?: string;
    /** Stored in per-user settings only — never commit this to config.json. */
    apiKey?: string;
  };
  pi: { enabled: boolean; command: string; args: string[]; cwd: string };
  mcp?: McpConfig;
  gui: { visualizer: string; showPerformanceStats: boolean; maxTranscriptItems: number };
};
