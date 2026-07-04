import fs from "node:fs";
import path from "node:path";
import type { AppConfig, GeminiThinkLevel } from "../shared/types.js";
import { appRoot } from "./config.js";
import {
  extractLocationFromPrompt,
  type LocalToolArgs,
  runNamedLocalTool,
  type LocalToolName,
  type LocalToolResult,
  type LocalToolServices
} from "./localTools.js";
import { buildDynamicSkillPrompt } from "./skillRegistry.js";
import type { McpManager } from "./mcpManager.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiContext = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  knownLocation?: string | null;
  userMemory?: string;
  prompt?: string;
  localToolServices?: LocalToolServices;
  mcp?: McpManager;
  onToolEvent?: (phase: "start" | "end" | "error", result: GeminiToolEventResult) => void;
};

const systemPromptPath = path.join(appRoot, "systemprompt.txt");

type GeminiFunctionCall = {
  name?: string;
  args?: unknown;
  id?: string;
};

type GeminiPart = {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{ content?: GeminiContent }>;
  error?: { message?: string } | string;
};

type GeminiToolEventResult =
  | (LocalToolResult & { args?: LocalToolArgs; durationMs?: number })
  | { name: string; text: string; args?: LocalToolArgs; durationMs?: number }
  | { name: string; error: string; args?: LocalToolArgs; durationMs?: number };

type ToolCallResult = LocalToolResult | { name: string; text: string } | { name: string; error: string };

export function resolveGeminiApiKey(config: AppConfig): string {
  const key =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_AI_STUDIO_API_KEY?.trim() ||
    config.gemini.apiKey?.trim() ||
    "";
  if (!key) {
    throw new Error(
      "Missing Google AI Studio API key. Set GEMINI_API_KEY in v3/.env or your environment."
    );
  }
  return key;
}

function geminiBaseUrl(config: AppConfig): string {
  return (config.gemini.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export async function generateWithGemini(
  prompt: string,
  config: AppConfig,
  context: GeminiContext = {}
): Promise<string> {
  context.prompt = prompt;
  const contents = buildContents(prompt, context);
  for (let step = 0; step < 3; step += 1) {
    const assistant = await callGemini(config, contents, true, context.mcp);
    contents.push(assistant);
    const toolCalls = extractFunctionCalls(assistant);
    if (!toolCalls.length) {
      const content = extractText(assistant).trim();
      if (content) {
        return content;
      }
      contents.push({
        role: "user",
        parts: [
          {
            text: "Your previous message was empty. Provide a concise final answer now. If tool data is available, use it."
          }
        ]
      });
      continue;
    }

    const toolResults = await Promise.all(
      toolCalls.slice(0, 6).map((call) => executeToolCall(call, context, config, true))
    );
    contents.push({
      role: "user",
      parts: toolResults.map((entry) => ({
        functionResponse: {
          name: entry.call.name ?? "tool",
          id: entry.call.id,
          response: toResponseObject(entry.result)
        }
      }))
    });
  }

  const final = await callGemini(config, contents, false, context.mcp);
  const content = extractText(final).trim();
  if (content) {
    return content;
  }
  const latestTool = [...contents]
    .reverse()
    .flatMap((entry) => entry.parts)
    .find((part) => part.functionResponse);
  return latestTool?.functionResponse
    ? summarizeToolFallback(latestTool.functionResponse.response)
    : "I did not get a response from Gemini.";
}

async function callGemini(
  config: AppConfig,
  contents: GeminiContent[],
  includeTools: boolean,
  mcp?: McpManager
): Promise<GeminiContent> {
  const apiKey = resolveGeminiApiKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: readSystemPrompt(mcp) }] },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1024,
      ...thinkingConfig(config.gemini.model, config.gemini.think)
    }
  };
  if (includeTools) {
    const mcpDeclarations = mcp?.listToolDeclarations() ?? [];
    const functionDeclarations = mcpDeclarations.length
      ? [...FUNCTION_DECLARATIONS, ...mcpDeclarations]
      : FUNCTION_DECLARATIONS;
    body.tools = [{ functionDeclarations }];
  }

  const url = `${geminiBaseUrl(config)}/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: controller.signal,
    body: JSON.stringify(body)
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const detail = await safeErrorMessage(response);
    throw new Error(`Gemini returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const errorMessage = typeof payload.error === "string" ? payload.error : payload.error?.message;
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return payload.candidates?.[0]?.content ?? { role: "model", parts: [] };
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as GeminiResponse;
    if (typeof payload.error === "string") {
      return payload.error;
    }
    return payload.error?.message ?? "";
  } catch {
    return "";
  }
}

function thinkingConfig(model: string, think: GeminiThinkLevel | undefined): Record<string, unknown> {
  const supportsThinking = /2\.5|gemini-3|flash-thinking/i.test(model);
  if (!supportsThinking) {
    return {};
  }
  const budget: Record<string, number> = { null: 0, low: 0, medium: 2048, high: 8192 };
  const key = think ?? "null";
  return { thinkingConfig: { thinkingBudget: budget[key] ?? 0 } };
}

function readSystemPrompt(mcp?: McpManager): string {
  return [fs.readFileSync(systemPromptPath, "utf-8").trim(), buildDynamicSkillPrompt(), buildMcpPrompt(mcp)]
    .filter(Boolean)
    .join("\n\n");
}

function buildMcpPrompt(mcp?: McpManager): string {
  const declarations = mcp?.listToolDeclarations() ?? [];
  if (!declarations.length) {
    return "";
  }
  const lines = [
    "Connected Model Context Protocol (MCP) tools are available as callable functions:",
    ...declarations.map((declaration) => `- ${declaration.name}: ${declaration.description ?? "MCP tool."}`),
    "Call these functions by name with JSON arguments matching their parameters when the user's request maps to one."
  ];
  return lines.join("\n");
}

function buildContents(prompt: string, context: GeminiContext): GeminiContent[] {
  const contents: GeminiContent[] = [];
  if (context.history?.length) {
    for (const turn of context.history.slice(-10)) {
      contents.push({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.text }] });
    }
  }
  if (context.knownLocation) {
    contents.push({
      role: "user",
      parts: [
        {
          text:
            `Remembered user location: ${context.knownLocation}. ` +
            "Use this as a default only when the user did not ask for a different location."
        }
      ]
    });
  }
  if (context.userMemory?.trim()) {
    contents.push({
      role: "user",
      parts: [
        {
          text:
            "Persistent user memory. Use these facts as background context, but do not let them override the user's current request:\n" +
            context.userMemory.trim()
        }
      ]
    });
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });
  return contents;
}

function extractFunctionCalls(content: GeminiContent): GeminiFunctionCall[] {
  return content.parts.map((part) => part.functionCall).filter((call): call is GeminiFunctionCall => Boolean(call));
}

function extractText(content: GeminiContent): string {
  return content.parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join(" ");
}

function toResponseObject(result: ToolCallResult): Record<string, unknown> {
  return result as unknown as Record<string, unknown>;
}

const FUNCTION_DECLARATIONS = [
  {
    name: "get_weather",
    description:
      "Get current weather for a location. Returns condition, temperature, feels-like temperature, humidity, wind speed, and precipitation.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City and state or city and country. If omitted, the user's remembered location is used."
        }
      }
    }
  },
  {
    name: "set_manage_alarm",
    description:
      "Set, list, or cancel alarms. Use for reminders like 'set an alarm in 5 minutes', 'wake me at 7am', 'list alarms', or 'cancel alarm alarm-id'.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "set, list, or cancel" },
        time: {
          type: "string",
          description: "Time for a new alarm, such as 'in 10 minutes', '7:30 pm', or an ISO date/time."
        },
        label: { type: "string", description: "Short alarm label." },
        id: { type: "string", description: "Alarm id to cancel." }
      },
      required: ["action"]
    }
  },
  {
    name: "open_app",
    description: "Open a local desktop app by name, such as notepad, calculator, chrome, spotify, or explorer.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Application name or executable path." }
      },
      required: ["app"]
    }
  },
  {
    name: "open_website",
    description: "Open a website in the user's default browser. Only http and https URLs are supported.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Website URL or domain, for example https://example.com or example.com."
        }
      },
      required: ["url"]
    }
  },
  {
    name: "web_search",
    description: "Search the web for current information and return top results with links and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." }
      },
      required: ["query"]
    }
  },
  {
    name: "inspect_screen",
    description:
      "Capture the current screen when the user asks about what is on their screen. Returns a screenshot path and notes whether visual interpretation is available.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user's question about the screen, for example 'what is this on my screen?'"
        }
      }
    }
  },
  {
    name: "control_spotify",
    description:
      "Control Spotify playback. Use this for requests to play songs, tracks, albums, artists, playlists, podcasts, pause, resume, skip, change volume, shuffle, repeat, list devices, or check current playback. If the user says 'play the song X on Spotify', treat X as the track search query even if the title sounds like a question or sentence.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "play, pause, resume, next, previous, volume, shuffle, repeat, devices, status, or login"
        },
        query: {
          type: "string",
          description: "Search query for play requests, such as a song title plus optional artist."
        },
        kind: {
          type: "string",
          description: "track, playlist, album, artist, show, or episode. Use track for song requests."
        },
        prefer: { type: "string", description: "Use mine for personal playlist requests." },
        uri: { type: "string", description: "Spotify URI or URL to play directly." },
        deviceName: { type: "string", description: "Target Spotify device name when the user names one." },
        percent: { type: "number", description: "Volume percent from 0 to 100 for volume action." },
        state: {
          type: "string",
          description: "For shuffle: true or false. For repeat: off, track, or context."
        }
      },
      required: ["action"]
    }
  },
  {
    name: "run_sub_agent",
    description:
      "Run a bounded tool-calling sub-agent for complex multi-step tasks. Use only when a task needs several tool calls or deeper investigation before answering.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Concrete task for the sub-agent to complete." }
      },
      required: ["task"]
    }
  },
  {
    name: "get_time",
    description: "Get the current local time and date for a location.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City and state or city and country. If omitted, the user's remembered location is used."
        }
      }
    }
  },
  {
    name: "calculate",
    description:
      "Evaluate a simple arithmetic expression. Use for math, conversions requested as arithmetic, totals, differences, percentages, and comparisons.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Arithmetic expression using numbers, parentheses, +, -, *, /, %, and decimals."
        }
      },
      required: ["expression"]
    }
  },
  {
    name: "run_skill_script",
    description:
      "Run an executable script from a discovered dynamic skill. Use this when the current dynamic skill catalog names a relevant skill and script, such as spotify-control scripts/spotify_control.py for Spotify playback.",
    parameters: {
      type: "object",
      properties: {
        skillName: { type: "string", description: "The discovered skill name, for example spotify-control." },
        script: {
          type: "string",
          description: "The script path listed in the dynamic skill catalog, for example scripts/spotify_control.py."
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command-line arguments derived semantically from the user's request."
        }
      },
      required: ["skillName", "script", "args"]
    }
  },
  {
    name: "update_user_memory",
    description:
      "Add, list, or forget persistent user memories. Add only durable user facts or preferences that will matter in future conversations, such as occupation, long-term projects, stable preferences, accessibility needs, home/default location, preferred apps, or how the user wants the assistant to behave. Do not save one-off requests, temporary moods, random facts from the current task, secrets, passwords, API keys, payment data, or sensitive health/legal/financial details unless the user explicitly asks you to remember them.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "add, list, or forget" },
        text: {
          type: "string",
          description:
            "Concise memory text written in third person or direct preference form, for example 'The user is an engineer' or 'The user prefers concise answers'."
        },
        category: { type: "string", description: "profile, preference, location, work, tool, or other" },
        id: { type: "string", description: "Memory id to forget." },
        source: { type: "string", description: "Short reason this memory was stored." }
      },
      required: ["action"]
    }
  }
];

type ToolCallOutcome = {
  call: GeminiFunctionCall;
  result: ToolCallResult;
};

async function executeToolCall(
  call: GeminiFunctionCall,
  context: GeminiContext,
  config: AppConfig,
  allowSubAgent: boolean
): Promise<ToolCallOutcome> {
  if (context.mcp?.isMcpTool(call.name)) {
    return executeMcpToolCall(call, context);
  }

  const toolName = normalizeToolName(call.name);
  if (!toolName) {
    const payload = { name: String(call.name ?? "unknown"), error: "Unknown tool requested." };
    context.onToolEvent?.("error", payload);
    return { call, result: payload };
  }

  const startedAt = Date.now();
  try {
    const args = resolveToolArgs(toolName, parseToolArgs(call.args), context.prompt ?? "");
    if (toolName === "sub_agent") {
      if (!allowSubAgent) {
        throw new Error("Sub-agent recursion is not allowed.");
      }
      context.onToolEvent?.("start", { name: "sub_agent", text: "Running sub agent" });
      const result = await runSubAgent(String(args.task ?? context.prompt ?? ""), config, context);
      context.onToolEvent?.("end", { ...result, args, durationMs: Date.now() - startedAt });
      return { call, result };
    }
    context.onToolEvent?.("start", {
      name: toolName,
      args,
      location: typeof args.location === "string" ? args.location : undefined,
      text: toolName === "web_search" && args.query ? `Searching: ${args.query}` : "Tool started"
    } as LocalToolResult & { args: LocalToolArgs });
    const result = await runNamedLocalTool(toolName, args, context.knownLocation ?? null, context.localToolServices);
    context.onToolEvent?.("end", { ...result, args, durationMs: Date.now() - startedAt });
    return { call, result };
  } catch (error) {
    const payload = { name: toolName, error: String(error), durationMs: Date.now() - startedAt };
    context.onToolEvent?.("error", payload);
    return { call, result: { name: toolName, error: String(error) } };
  }
}

async function executeMcpToolCall(call: GeminiFunctionCall, context: GeminiContext): Promise<ToolCallOutcome> {
  const name = String(call.name ?? "mcp_tool");
  const args = parseToolArgs(call.args) as Record<string, unknown>;
  const startedAt = Date.now();
  context.onToolEvent?.("start", { name, args: args as LocalToolArgs, text: "MCP tool started" });
  try {
    const result = await context.mcp!.callTool(name, args);
    if (result.isError) {
      const payload = { name, error: result.text, args: args as LocalToolArgs, durationMs: Date.now() - startedAt };
      context.onToolEvent?.("error", payload);
      return { call, result: { name, error: result.text } };
    }
    context.onToolEvent?.("end", {
      name,
      text: result.text,
      args: args as LocalToolArgs,
      durationMs: Date.now() - startedAt
    });
    return { call, result: { name, text: result.text } };
  } catch (error) {
    const payload = { name, error: String(error), args: args as LocalToolArgs, durationMs: Date.now() - startedAt };
    context.onToolEvent?.("error", payload);
    return { call, result: { name, error: String(error) } };
  }
}

function resolveToolArgs(
  toolName: LocalToolName | "sub_agent",
  args: LocalToolArgs,
  prompt: string
): LocalToolArgs {
  if ((toolName === "weather" || toolName === "time") && !args.location) {
    return { ...args, location: extractLocationFromPrompt(prompt) };
  }
  if (toolName === "screen" && !args.query) {
    return { ...args, query: prompt };
  }
  return args;
}

async function runSubAgent(task: string, config: AppConfig, context: GeminiContext): Promise<LocalToolResult> {
  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: `Task: ${task}` }] }
  ];
  for (let step = 0; step < 4; step += 1) {
    const assistant = await callGemini(config, contents, true, context.mcp);
    contents.push(assistant);
    const toolCalls = extractFunctionCalls(assistant).filter((call) => call.name !== "run_sub_agent");
    if (!toolCalls.length) {
      return { name: "sub_agent", text: extractText(assistant).trim() || "Sub-agent completed without details." };
    }
    const results = await Promise.all(
      toolCalls.slice(0, 4).map((call) => executeToolCall(call, context, config, false))
    );
    contents.push({
      role: "user",
      parts: results.map((entry) => ({
        functionResponse: {
          name: entry.call.name ?? "tool",
          id: entry.call.id,
          response: toResponseObject(entry.result)
        }
      }))
    });
  }
  const final = await callGemini(config, contents, false, context.mcp);
  return { name: "sub_agent", text: extractText(final).trim() || "Sub-agent finished its tool loop." };
}

function normalizeToolName(name: string | undefined): LocalToolName | "sub_agent" | null {
  if (name === "get_weather") {
    return "weather";
  }
  if (name === "get_time") {
    return "time";
  }
  if (name === "calculate") {
    return "calculator";
  }
  if (name === "run_skill_script") {
    return "skill_script";
  }
  if (name === "set_manage_alarm") {
    return "alarm";
  }
  if (name === "open_app") {
    return "open_app";
  }
  if (name === "open_website") {
    return "open_website";
  }
  if (name === "web_search") {
    return "web_search";
  }
  if (name === "inspect_screen") {
    return "screen";
  }
  if (name === "control_spotify") {
    return "spotify";
  }
  if (name === "run_sub_agent") {
    return "sub_agent";
  }
  if (name === "update_user_memory") {
    return "memory";
  }
  return null;
}

function parseToolArgs(args: unknown): LocalToolArgs {
  if (!args) {
    return {};
  }
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as LocalToolArgs;
    } catch {
      return {};
    }
  }
  if (typeof args === "object") {
    return args as LocalToolArgs;
  }
  return {};
}

function summarizeToolFallback(response: Record<string, unknown>): string {
  const text = response.text;
  if (typeof text === "string" && text.trim()) {
    return text;
  }
  const error = response.error;
  if (typeof error === "string" && error.trim()) {
    return `Tool failed: ${error}`;
  }
  return "Tool completed, but Gemini did not produce a final response.";
}
