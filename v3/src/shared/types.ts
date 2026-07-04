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

/** How the local model chooses its thinking level. */
export type ThinkMode = "auto" | "on" | "off";

/** Explicit reasoning depth for supported Ollama models. */
export type ThinkLevel = "none" | "low" | "medium" | "high";

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
  ollama: { model: string; baseUrl?: string; lowResourceModel?: string; think?: ThinkMode; thinkLevel?: ThinkLevel };
  pi: { enabled: boolean; command: string; args: string[]; cwd: string };
  mcp?: McpConfig;
  gui: { visualizer: string; showPerformanceStats: boolean; maxTranscriptItems: number };
};
