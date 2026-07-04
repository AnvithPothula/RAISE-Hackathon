import { EventEmitter } from "node:events";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { appRoot } from "./config.js";
import type {
  McpConfig,
  McpServerConfig,
  McpServerStatus,
  McpStatus,
  McpTransportKind
} from "../shared/types.js";

const CLIENT_INFO = { name: "pythos-v3", version: "0.1.0" };
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 60000;
const MAX_TOOL_TEXT_LENGTH = 8000;

/** A Gemini-compatible function declaration derived from an MCP tool. */
export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type McpToolResult = {
  text: string;
  isError: boolean;
  structuredContent?: unknown;
};

type McpToolDescriptor = {
  server: string;
  tool: string;
  declaration: GeminiFunctionDeclaration;
};

type ServerRuntime = {
  config: McpServerConfig;
  client: Client | null;
  transport: Transport | null;
  connected: boolean;
  toolNames: string[];
  error: string | null;
};

/**
 * Connects to configured Model Context Protocol servers, exposes their tools as
 * Gemini function declarations, and routes tool calls back to the owning server.
 *
 * Tool names are namespaced as `mcp_<server>_<tool>` so they never collide with
 * the built-in local tools and can be reversed to the correct server at call time.
 */
export class McpManager extends EventEmitter {
  private config: McpConfig;
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly toolIndex = new Map<string, McpToolDescriptor>();

  constructor(config: McpConfig | undefined) {
    super();
    this.config = normalizeConfig(config);
  }

  async init(): Promise<void> {
    if (!this.config.enabled) {
      debug("MCP disabled in config; skipping connections");
      return;
    }
    const enabledServers = this.config.servers.filter((server) => server.enabled !== false);
    if (!enabledServers.length) {
      debug("MCP enabled but no servers configured");
      return;
    }
    await Promise.all(enabledServers.map((server) => this.connectServer(server)));
    this.emit("status", this.getStatus());
  }

  /** Declarations for every connected MCP tool, ready to merge into Gemini's tool list. */
  listToolDeclarations(): GeminiFunctionDeclaration[] {
    return [...this.toolIndex.values()].map((descriptor) => descriptor.declaration);
  }

  hasTools(): boolean {
    return this.toolIndex.size > 0;
  }

  isMcpTool(name: string | undefined): boolean {
    return Boolean(name && this.toolIndex.has(name));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const descriptor = this.toolIndex.get(name);
    if (!descriptor) {
      throw new Error(`Unknown MCP tool: ${name}`);
    }
    const runtime = this.runtimes.get(descriptor.server);
    if (!runtime?.client || !runtime.connected) {
      throw new Error(`MCP server "${descriptor.server}" is not connected.`);
    }

    const response = await runtime.client.callTool(
      { name: descriptor.tool, arguments: args ?? {} },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );
    return normalizeToolResult(response);
  }

  getStatus(): McpStatus {
    return {
      enabled: this.config.enabled,
      servers: [...this.runtimes.values()].map((runtime) => toServerStatus(runtime))
    };
  }

  async updateConfig(config: McpConfig | undefined): Promise<void> {
    await this.shutdown();
    this.config = normalizeConfig(config);
    await this.init();
  }

  async shutdown(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.toolIndex.clear();
    await Promise.all(
      runtimes.map(async (runtime) => {
        try {
          await runtime.client?.close();
        } catch (error) {
          debug(`error closing server "${runtime.config.name}": ${String(error)}`);
        }
      })
    );
  }

  private async connectServer(config: McpServerConfig): Promise<void> {
    const runtime: ServerRuntime = {
      config,
      client: null,
      transport: null,
      connected: false,
      toolNames: [],
      error: null
    };
    this.runtimes.set(config.name, runtime);

    try {
      const transport = createTransport(config);
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      runtime.transport = transport;
      runtime.client = client;

      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `Timed out connecting to MCP server "${config.name}"`
      );

      const listed = await withTimeout(
        client.listTools(),
        CONNECT_TIMEOUT_MS,
        `Timed out listing tools for MCP server "${config.name}"`
      );

      const registered = this.registerTools(config.name, listed.tools ?? []);
      runtime.connected = true;
      runtime.toolNames = registered;
      runtime.error = null;
      debug(`connected server "${config.name}" tools=${registered.length}`);
    } catch (error) {
      runtime.connected = false;
      runtime.error = errorMessage(error);
      debug(`failed to connect server "${config.name}": ${runtime.error}`);
      try {
        await runtime.client?.close();
      } catch {
        // Ignore secondary close failures during error handling.
      }
      runtime.client = null;
      runtime.transport = null;
    }
  }

  private registerTools(
    serverName: string,
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  ): string[] {
    const registered: string[] = [];
    for (const tool of tools) {
      if (!tool?.name) {
        continue;
      }
      const geminiName = this.uniqueToolName(serverName, tool.name);
      this.toolIndex.set(geminiName, {
        server: serverName,
        tool: tool.name,
        declaration: {
          name: geminiName,
          description: buildToolDescription(serverName, tool.name, tool.description),
          parameters: sanitizeJsonSchema(tool.inputSchema)
        }
      });
      registered.push(geminiName);
    }
    return registered;
  }

  private uniqueToolName(serverName: string, toolName: string): string {
    const base = buildMcpToolName(serverName, toolName);
    if (!this.toolIndex.has(base)) {
      return base;
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base.slice(0, 60)}_${suffix}`;
      if (!this.toolIndex.has(candidate)) {
        return candidate;
      }
    }
    return `${base.slice(0, 58)}_${Date.now().toString(36).slice(-4)}`;
  }
}

/** Build the namespaced Gemini function name for an MCP tool (exported for tests). */
export function buildMcpToolName(serverName: string, toolName: string): string {
  const parts = ["mcp", sanitizeNamePart(serverName), sanitizeNamePart(toolName)].filter(Boolean);
  const slug = (parts.length > 1 ? parts.join("_") : "mcp_tool").slice(0, 64).replace(/_+$/g, "");
  return slug || "mcp_tool";
}

function sanitizeNamePart(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function buildToolDescription(serverName: string, toolName: string, description?: string): string {
  const summary = String(description ?? "").replace(/\s+/g, " ").trim();
  const prefix = `[MCP server: ${serverName}] ${toolName}.`;
  const combined = summary ? `${prefix} ${summary}` : prefix;
  return combined.slice(0, 1024);
}

function normalizeConfig(config: McpConfig | undefined): McpConfig {
  if (!config || typeof config !== "object") {
    return { enabled: false, servers: [] };
  }
  const servers = Array.isArray(config.servers) ? config.servers : [];
  const seen = new Set<string>();
  const normalized: McpServerConfig[] = [];
  for (const server of servers) {
    const name = String(server?.name ?? "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push({ ...server, name });
  }
  return { enabled: Boolean(config.enabled), servers: normalized };
}

function createTransport(config: McpServerConfig): Transport {
  const transport = resolveTransportKind(config);
  if (transport === "http") {
    const url = String(config.url ?? "").trim();
    if (!url) {
      throw new Error(`MCP server "${config.name}" is http but has no url.`);
    }
    const requestInit = config.headers ? { headers: config.headers } : undefined;
    return new StreamableHTTPClientTransport(new URL(url), { requestInit });
  }

  const command = String(config.command ?? "").trim();
  if (!command) {
    throw new Error(`MCP server "${config.name}" is stdio but has no command.`);
  }
  return new StdioClientTransport({
    command,
    args: config.args ?? [],
    env: mergeStdioEnv(config.env),
    cwd: resolveStdioCwd(config.cwd),
    stderr: "pipe"
  });
}

function resolveTransportKind(config: McpServerConfig): McpTransportKind {
  if (config.transport === "http" || config.transport === "stdio") {
    return config.transport;
  }
  return config.url ? "http" : "stdio";
}

function resolveStdioCwd(cwd: string | undefined): string {
  const value = String(cwd ?? "").trim();
  if (!value) {
    return appRoot;
  }
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

function mergeStdioEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env || !Object.keys(env).length) {
    return undefined;
  }
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return { ...base, ...env };
}

function normalizeToolResult(response: unknown): McpToolResult {
  const payload = (response ?? {}) as {
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  for (const item of payload.content ?? []) {
    const type = String(item?.type ?? "");
    if (type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (type === "resource" && item.resource && typeof item.resource === "object") {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        parts.push(resource.text);
      } else if (typeof resource.uri === "string") {
        parts.push(`[resource ${resource.uri}]`);
      }
    } else if (type) {
      parts.push(`[${type} content]`);
    }
  }

  let text = parts.join("\n").trim();
  if (!text && payload.structuredContent !== undefined) {
    text = safeJson(payload.structuredContent);
  }
  if (!text) {
    text = payload.isError ? "MCP tool reported an error with no message." : "MCP tool returned no content.";
  }
  return {
    text: text.slice(0, MAX_TOOL_TEXT_LENGTH),
    isError: Boolean(payload.isError),
    structuredContent: payload.structuredContent
  };
}

/**
 * Reduce an MCP tool's JSON Schema to the OpenAPI subset that the Gemini
 * function-calling API accepts. Unsupported keywords (`$schema`, `$ref`,
 * `additionalProperties`, `oneOf`, etc.) are dropped so the request is not
 * rejected. Returns undefined when no usable schema is present.
 */
export function sanitizeJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const cleaned = cleanSchemaNode(schema) ?? {};
  if (!cleaned.type) {
    cleaned.type = "object";
  }
  if (cleaned.type === "object" && !cleaned.properties) {
    cleaned.properties = {};
  }
  return cleaned;
}

const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "enum",
  "format",
  "nullable",
  "items",
  "properties",
  "required"
]);

function cleanSchemaNode(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return undefined;
  }
  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of ALLOWED_SCHEMA_KEYS) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (key === "type") {
      const type = normalizeSchemaType(value);
      if (type) {
        result.type = type;
      }
    } else if (key === "properties" && value && typeof value === "object") {
      const properties: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        const cleanedProp = cleanSchemaNode(propSchema);
        if (cleanedProp) {
          properties[propName] = cleanedProp;
        }
      }
      if (Object.keys(properties).length) {
        result.properties = properties;
      }
    } else if (key === "items") {
      const cleanedItems = cleanSchemaNode(value);
      if (cleanedItems) {
        result.items = cleanedItems;
      }
    } else if (key === "required" && Array.isArray(value)) {
      const required = value.filter((entry): entry is string => typeof entry === "string");
      if (required.length) {
        result.required = required;
      }
    } else if (key === "enum" && Array.isArray(value)) {
      result.enum = value;
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  if (result.type === "object" && !result.properties) {
    result.properties = {};
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeSchemaType(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  // JSON Schema allows an array of types (e.g. ["string", "null"]); Gemini needs one.
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string" && entry !== "null");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function toServerStatus(runtime: ServerRuntime): McpServerStatus {
  return {
    name: runtime.config.name,
    enabled: runtime.config.enabled !== false,
    transport: resolveTransportKind(runtime.config),
    connected: runtime.connected,
    toolCount: runtime.toolNames.length,
    tools: runtime.toolNames,
    error: runtime.error
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function debug(message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.error(`[pythos-main ${timestamp}] mcp ${message}`);
}
