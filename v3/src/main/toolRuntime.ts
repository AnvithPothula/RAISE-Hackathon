import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../shared/types.js";
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

// Transport-agnostic tool runtime shared by the local Gemma (Ollama) client.
// It owns the function/tool declarations, the system prompt, and the dispatch
// of tool calls to local tools or MCP servers. It performs no model inference
// itself and makes no network calls to any hosted LLM — the local model client
// drives the conversation loop and delegates individual tool calls here.

const systemPromptPath = path.join(appRoot, "systemprompt.txt");

/** Context threaded through a single assistant turn and its tool calls. */
export type ToolContext = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  knownLocation?: string | null;
  userMemory?: string;
  prompt?: string;
  localToolServices?: LocalToolServices;
  mcp?: McpManager;
  onToolEvent?: (phase: "start" | "end" | "error", result: ToolEventResult) => void;
};

/** A tool call requested by the model, normalized across transports. */
export type ToolFunctionCall = {
  name?: string;
  args?: unknown;
  id?: string;
};

type ToolEventResult =
  | (LocalToolResult & { args?: LocalToolArgs; durationMs?: number })
  | { name: string; text: string; args?: LocalToolArgs; durationMs?: number }
  | { name: string; error: string; args?: LocalToolArgs; durationMs?: number };

type ToolCallResult = LocalToolResult | { name: string; text: string } | { name: string; error: string };

type ToolCallOutcome = {
  call: ToolFunctionCall;
  result: ToolCallResult;
};

/** Compose the full system prompt: base prompt + dynamic skills + MCP tool list. */
export function readSystemPrompt(mcp?: McpManager): string {
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

export const FUNCTION_DECLARATIONS = [
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

/**
 * Execute a single tool call. MCP tools are dispatched to the connected server;
 * everything else maps to a local on-device tool. The `run_sub_agent` tool is
 * handled by the model client (which owns the conversation loop), so it never
 * reaches here.
 */
export async function executeToolCall(call: ToolFunctionCall, context: ToolContext): Promise<ToolCallOutcome> {
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

async function executeMcpToolCall(call: ToolFunctionCall, context: ToolContext): Promise<ToolCallOutcome> {
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

function resolveToolArgs(toolName: LocalToolName, args: LocalToolArgs, prompt: string): LocalToolArgs {
  if ((toolName === "weather" || toolName === "time") && !args.location) {
    return { ...args, location: extractLocationFromPrompt(prompt) };
  }
  if (toolName === "screen" && !args.query) {
    return { ...args, query: prompt };
  }
  return args;
}

function normalizeToolName(name: string | undefined): LocalToolName | null {
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
