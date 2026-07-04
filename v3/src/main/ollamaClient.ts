import fs from "node:fs";
import type { AppConfig } from "../shared/types.js";
import {
  executeToolCall,
  FUNCTION_DECLARATIONS,
  type ToolContext,
  type ToolFunctionCall,
  readSystemPrompt
} from "./toolRuntime.js";

// Local Gemma 4 served by Ollama. Everything below runs on-device; no request
// ever leaves the machine. Tool dispatch is delegated to the shared tool runtime,
// so tool behavior is identical no matter which model client drives the loop.
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "gemma4:12b";
const REQUEST_TIMEOUT_MS = 120000;

// Resolution order: explicit env override > config.json > built-in default. The
// env override keeps CI/scripts flexible; config.json is what the app ships with.
function resolveOllamaUrl(config?: AppConfig): string {
  return (process.env.PYTHOS_OLLAMA_URL || config?.ollama?.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

function resolveOllamaModel(config?: AppConfig): string {
  if (process.env.PYTHOS_OLLAMA_MODEL) {
    return process.env.PYTHOS_OLLAMA_MODEL;
  }
  // Low-resource mode swaps the dense 12B for the small E2B model so Pythos runs
  // on modest hardware. Requires the low-resource model to be pulled first
  // (`ollama pull gemma4:e2b`).
  if (config?.python?.lowResourceMode && config.ollama?.lowResourceModel) {
    return config.ollama.lowResourceModel;
  }
  return config?.ollama?.model || DEFAULT_OLLAMA_MODEL;
}

/** The Gemma model that will actually serve requests for this config (honors low-resource mode). */
export function resolveActiveModel(config?: AppConfig): string {
  return resolveOllamaModel(config);
}

type OllamaToolCall = {
  function?: { name?: string; arguments?: Record<string, unknown> };
};

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

type OllamaTool = { type: "function"; function: unknown };

type OllamaChatResponse = {
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  eval_count?: number;
  eval_duration?: number;
  error?: string;
};

export async function generateWithOllama(
  prompt: string,
  config: AppConfig,
  context: ToolContext = {}
): Promise<string> {
  context.prompt = prompt;
  const messages = buildMessages(prompt, context);
  const tools = buildTools(context);

  for (let step = 0; step < 3; step += 1) {
    const message = await chat(messages, tools, config);
    const toolCalls = message.tool_calls ?? [];

    if (!toolCalls.length) {
      const content = cleanText(message.content);
      if (content) {
        return content;
      }
      messages.push({
        role: "user",
        content: "Your previous message was empty. Provide a concise final answer now. If tool data is available, use it."
      });
      continue;
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

    const outcomes = await Promise.all(
      toolCalls.slice(0, 6).map((toolCall) => runToolCall(toOutcomeCall(toolCall), config, context))
    );
    for (const outcome of outcomes) {
      messages.push({
        role: "tool",
        tool_name: outcome.call.name ?? "tool",
        content: JSON.stringify(outcome.result)
      });
    }
  }

  const final = await chat(messages, undefined, config);
  return cleanText(final.content) || "I did not get a response from the local model.";
}

// Dispatch a tool call locally. run_sub_agent is handled by a local Gemma loop so
// the assistant stays fully on-device; every other tool reuses the shared executor.
async function runToolCall(call: ToolFunctionCall, config: AppConfig, context: ToolContext) {
  if (call.name === "run_sub_agent") {
    const startedAt = Date.now();
    const task = String((call.args as { task?: unknown } | undefined)?.task ?? context.prompt ?? "");
    context.onToolEvent?.("start", { name: "sub_agent", text: "Running sub agent" });
    const text = await runLocalSubAgent(task, config, context);
    context.onToolEvent?.("end", { name: "sub_agent", text, durationMs: Date.now() - startedAt });
    return { call, result: { name: "sub_agent", text } };
  }
  return executeToolCall(call, context);
}

// A bounded tool-calling sub-agent that runs entirely on the local model. Nested
// sub-agent calls are stripped so it cannot recurse.
async function runLocalSubAgent(task: string, config: AppConfig, context: ToolContext): Promise<string> {
  const messages: OllamaMessage[] = [
    { role: "system", content: readSystemPrompt(context.mcp) },
    { role: "user", content: `Task: ${task}` }
  ];
  const tools = buildTools(context).filter(
    (tool) => (tool.function as { name?: string }).name !== "run_sub_agent"
  );

  for (let step = 0; step < 4; step += 1) {
    const message = await chat(messages, tools, config);
    const toolCalls = (message.tool_calls ?? []).filter(
      (toolCall) => toolCall.function?.name !== "run_sub_agent"
    );
    if (!toolCalls.length) {
      return cleanText(message.content) || "Sub-agent completed without details.";
    }
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });
    const outcomes = await Promise.all(
      toolCalls.slice(0, 4).map((toolCall) => executeToolCall(toOutcomeCall(toolCall), context))
    );
    for (const outcome of outcomes) {
      messages.push({
        role: "tool",
        tool_name: outcome.call.name ?? "tool",
        content: JSON.stringify(outcome.result)
      });
    }
  }

  const final = await chat(messages, undefined, config);
  return cleanText(final.content) || "Sub-agent finished its tool loop.";
}

/**
 * Local screen understanding with Gemma 4 vision. The screenshot is base64-encoded
 * and sent to Ollama's /api/chat with an `images` field — the image never leaves
 * the machine. Returns a graceful message on any failure rather than throwing so
 * the "what's on my screen?" tool degrades to just the capture path.
 */
export async function analyzeImageWithOllama(
  imagePath: string,
  prompt: string,
  config?: AppConfig
): Promise<string> {
  let base64: string;
  try {
    base64 = fs.readFileSync(imagePath).toString("base64");
  } catch (error) {
    return `I captured the screen, but could not read the screenshot file: ${String(error)}.`;
  }

  const body = {
    model: resolveOllamaModel(config),
    stream: false,
    think: false,
    messages: [
      {
        role: "user",
        content: prompt?.trim() || "Describe what is on this screen.",
        images: [base64]
      }
    ],
    options: { temperature: 0.4, top_p: 0.95, top_k: 64 }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${resolveOllamaUrl(config)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return `I captured the screen, but local Gemma vision returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`;
    }
    const payload = (await response.json()) as OllamaChatResponse;
    if (payload.error) {
      return `I captured the screen, but local Gemma vision failed: ${payload.error}.`;
    }
    return cleanText(payload.message?.content) || "I captured the screen, but the local vision response was empty.";
  } catch (error) {
    return `I captured the screen, but local Gemma vision failed: ${String(error)}.`;
  } finally {
    clearTimeout(timeout);
  }
}

/** True if the local Ollama server is reachable and has the configured model pulled. */
export async function isOllamaReady(config?: AppConfig): Promise<boolean> {
  try {
    const response = await fetch(`${resolveOllamaUrl(config)}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const base = resolveOllamaModel(config).split(":")[0];
    return (payload.models ?? []).some((model) => (model.name ?? "").startsWith(base));
  } catch {
    return false;
  }
}

async function chat(
  messages: OllamaMessage[],
  tools: OllamaTool[] | undefined,
  config?: AppConfig
): Promise<{ content?: string; tool_calls?: OllamaToolCall[] }> {
  const url = resolveOllamaUrl(config);
  const model = resolveOllamaModel(config);
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    think: false,
    // Gemma 4 recommended sampling.
    options: { temperature: 1.0, top_p: 0.95, top_k: 64 }
  };
  if (tools?.length) {
    body.tools = tools;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(
      `Could not reach local Gemma at ${url}. Is Ollama running and is '${model}' pulled? ${String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const payload = (await response.json()) as OllamaChatResponse;
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload.message ?? { content: "" };
}

function buildTools(context: ToolContext): OllamaTool[] {
  const declarations = [...FUNCTION_DECLARATIONS, ...(context.mcp?.listToolDeclarations() ?? [])];
  return declarations.map((declaration) => ({ type: "function", function: declaration }));
}

function buildMessages(prompt: string, context: ToolContext): OllamaMessage[] {
  const messages: OllamaMessage[] = [{ role: "system", content: readSystemPrompt(context.mcp) }];

  if (context.history?.length) {
    for (const turn of context.history.slice(-10)) {
      messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.text });
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

function toOutcomeCall(toolCall: OllamaToolCall): ToolFunctionCall {
  return { name: toolCall.function?.name, args: toolCall.function?.arguments ?? {} };
}

function cleanText(text: string | undefined): string {
  return (text ?? "").trim();
}
