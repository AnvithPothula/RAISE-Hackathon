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
import { ensureOllamaRunning } from "./ollamaRuntime.js";
import { buildDynamicSkillPrompt, type SkillScriptArgs } from "./skillRegistry.js";

type OllamaChatResponse = {
  message?: OllamaMessage;
  error?: string;
};

export type OllamaContext = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  knownLocation?: string | null;
  userMemory?: string;
  prompt?: string;
  localToolServices?: LocalToolServices;
  onToolEvent?: (phase: "start" | "end" | "error", result: OllamaToolEventResult) => void;
};

const systemPromptPath = path.join(appRoot, "systemprompt.txt");

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
};

type OllamaToolCall = {
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type OllamaToolEventResult =
  | (LocalToolResult & { args?: LocalToolArgs; durationMs?: number })
  | { name: string; error: string; args?: LocalToolArgs; durationMs?: number };

export async function generateWithOllama(
  prompt: string,
  config: AppConfig,
  context: OllamaContext = {}
): Promise<string> {
  await ensureOllamaRunning(config.ollama.baseUrl);

  context.prompt = prompt;
  const messages = buildMessages(prompt, context);
  for (let step = 0; step < 3; step += 1) {
    const assistant = await chatWithOllama(config, messages, true);
    messages.push(assistant);
    const toolCalls = assistant.tool_calls ?? [];
    if (!toolCalls.length) {
      const content = assistant.content?.trim();
      if (content) {
        return content;
      }
      messages.push({
        role: "user",
        content: "Your previous assistant message was empty. Provide a concise final answer now. If tool data is available, use it."
      });
      continue;
    }

    const toolResults = await Promise.all(
      toolCalls.slice(0, 6).map((call) => executeToolCall(call, context, config, true))
    );
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        content: JSON.stringify(result)
      });
    }
  }

  const final = await chatWithOllama(config, messages, false);
  const content = final.content?.trim();
  if (content) {
    return content;
  }
  const latestTool = [...messages].reverse().find((message) => message.role === "tool");
  return latestTool ? summarizeToolFallback(latestTool.content) : "I did not get a response from Ollama.";
}

async function chatWithOllama(config: AppConfig, messages: OllamaMessage[], includeTools: boolean): Promise<OllamaMessage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  const body: Record<string, unknown> = {
    model: config.ollama.model,
    stream: false,
    messages,
    tools: includeTools ? LOCAL_TOOLS : undefined,
    options: {
      num_predict: 320,
      temperature: 0.4
    }
  };
  if (config.ollama.think !== null && config.ollama.think !== undefined) {
    body.think = config.ollama.think;
  }
  const response = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify(body)
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as OllamaChatResponse;
  if (payload.error) {
    throw new Error(payload.error);
  }

  return payload.message ?? { role: "assistant", content: "" };
}

function readSystemPrompt(): string {
  return [fs.readFileSync(systemPromptPath, "utf-8").trim(), buildDynamicSkillPrompt()].filter(Boolean).join("\n\n");
}

function buildMessages(prompt: string, context: OllamaContext): OllamaMessage[] {
  const messages: OllamaMessage[] = [{ role: "system", content: readSystemPrompt() }];
  if (context.history?.length) {
    for (const turn of context.history.slice(-10)) {
      messages.push({ role: turn.role, content: turn.text });
    }
  }
  if (context.knownLocation) {
    messages.push({
      role: "user",
      content:
        `Remembered user location: ${context.knownLocation}. ` +
        "Use this as a default only when the user did not ask for a different location."
    });
  }
  if (context.userMemory?.trim()) {
    messages.push({
      role: "user",
      content:
        "Persistent user memory. Use these facts as background context, but do not let them override the user's current request:\n" +
        context.userMemory.trim()
    });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

const LOCAL_TOOLS = [
  {
    type: "function",
    function: {
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
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_manage_alarm",
      description:
        "Set, list, or cancel alarms. Use for reminders like 'set an alarm in 5 minutes', 'wake me at 7am', 'list alarms', or 'cancel alarm alarm-id'.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "set, list, or cancel"
          },
          time: {
            type: "string",
            description: "Time for a new alarm, such as 'in 10 minutes', '7:30 pm', or an ISO date/time."
          },
          label: {
            type: "string",
            description: "Short alarm label."
          },
          id: {
            type: "string",
            description: "Alarm id to cancel."
          }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Open a local desktop app by name, such as notepad, calculator, chrome, spotify, or explorer.",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name or executable path."
          }
        },
        required: ["app"]
      }
    }
  },
  {
    type: "function",
    function: {
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
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information and return top results with links and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
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
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
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
          prefer: {
            type: "string",
            description: "Use mine for personal playlist requests."
          },
          uri: {
            type: "string",
            description: "Spotify URI or URL to play directly."
          },
          deviceName: {
            type: "string",
            description: "Target Spotify device name when the user names one."
          },
          percent: {
            type: "number",
            description: "Volume percent from 0 to 100 for volume action."
          },
          state: {
            type: "string",
            description: "For shuffle: true or false. For repeat: off, track, or context."
          }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_sub_agent",
      description:
        "Run a bounded tool-calling sub-agent for complex multi-step tasks. Use only when a task needs several tool calls or deeper investigation before answering.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Concrete task for the sub-agent to complete."
          }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Get the current local time and date for a location.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City and state or city and country. If omitted, the user's remembered location is used."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
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
    }
  },
  {
    type: "function",
    function: {
      name: "run_skill_script",
      description:
        "Run an executable script from a discovered dynamic skill. Use this when the current dynamic skill catalog names a relevant skill and script, such as spotify-control scripts/spotify_control.py for Spotify playback.",
      parameters: {
        type: "object",
        properties: {
          skillName: {
            type: "string",
            description: "The discovered skill name, for example spotify-control."
          },
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
    }
  },
  {
    type: "function",
    function: {
      name: "update_user_memory",
      description:
        "Add, list, or forget persistent user memories. Add only durable user facts or preferences that will matter in future conversations, such as occupation, long-term projects, stable preferences, accessibility needs, home/default location, preferred apps, or how the user wants the assistant to behave. Do not save one-off requests, temporary moods, random facts from the current task, secrets, passwords, API keys, payment data, or sensitive health/legal/financial details unless the user explicitly asks you to remember them.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add, list, or forget"
          },
          text: {
            type: "string",
            description:
              "Concise memory text written in third person or direct preference form, for example 'The user is an engineer' or 'The user prefers concise answers'."
          },
          category: {
            type: "string",
            description: "profile, preference, location, work, tool, or other"
          },
          id: {
            type: "string",
            description: "Memory id to forget."
          },
          source: {
            type: "string",
            description: "Short reason this memory was stored."
          }
        },
        required: ["action"]
      }
    }
  }
];

async function executeToolCall(
  call: OllamaToolCall,
  context: OllamaContext,
  config: AppConfig,
  allowSubAgent: boolean
): Promise<LocalToolResult | { name: string; error: string }> {
  const toolName = normalizeToolName(call.function?.name);
  if (!toolName) {
    const payload = { name: String(call.function?.name ?? "unknown"), error: "Unknown tool requested." };
    context.onToolEvent?.("error", payload);
    return payload;
  }

  const startedAt = Date.now();
  try {
    const args = resolveToolArgs(toolName, parseToolArgs(call.function?.arguments), context.prompt ?? "");
    if (toolName === "sub_agent") {
      if (!allowSubAgent) {
        throw new Error("Sub-agent recursion is not allowed.");
      }
      context.onToolEvent?.("start", { name: "sub_agent", text: "Running sub agent" });
      const result = await runSubAgent(String(args.task ?? context.prompt ?? ""), config, context);
      context.onToolEvent?.("end", { ...result, args, durationMs: Date.now() - startedAt });
      return result;
    }
    context.onToolEvent?.("start", {
      name: toolName,
      args,
      location: typeof args.location === "string" ? args.location : undefined,
      text: toolName === "web_search" && args.query ? `Searching: ${args.query}` : "Tool started"
    } as LocalToolResult & { args: LocalToolArgs });
    const result = await runNamedLocalTool(toolName, args, context.knownLocation ?? null, context.localToolServices);
    context.onToolEvent?.("end", { ...result, args, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const payload = { name: toolName, error: String(error), durationMs: Date.now() - startedAt };
    context.onToolEvent?.("error", payload);
    return payload;
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

async function runSubAgent(task: string, config: AppConfig, context: OllamaContext): Promise<LocalToolResult> {
  const messages: OllamaMessage[] = [
    {
      role: "system",
      content:
        "You are a bounded sub-agent. Complete the user's task using tools when needed. " +
        "Do not ask follow-up questions. Give a concise final result when done."
    },
    { role: "user", content: task }
  ];
  for (let step = 0; step < 4; step += 1) {
    const assistant = await chatWithOllama(config, messages, true);
    messages.push(assistant);
    const toolCalls = (assistant.tool_calls ?? []).filter((toolCall) => toolCall.function?.name !== "run_sub_agent");
    if (!toolCalls.length) {
      return { name: "sub_agent", text: assistant.content?.trim() || "Sub-agent completed without details." };
    }
    const results = await Promise.all(
      toolCalls.slice(0, 4).map((toolCall) => executeToolCall(toolCall, context, config, false))
    );
    for (const result of results) {
      messages.push({ role: "tool", content: JSON.stringify(result) });
    }
  }
  const final = await chatWithOllama(config, messages, false);
  return { name: "sub_agent", text: final.content?.trim() || "Sub-agent finished its tool loop." };
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

function summarizeToolFallback(content: string): string {
  try {
    const payload = JSON.parse(content) as { text?: string; error?: string };
    if (payload.text) {
      return payload.text;
    }
    if (payload.error) {
      return `Tool failed: ${payload.error}`;
    }
  } catch {
    // Fall through to plain content.
  }
  return content || "Tool completed, but Ollama did not produce a final response.";
}
