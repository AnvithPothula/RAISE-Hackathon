import type { AppConfig, ModelStats } from "../shared/types.js";
import type { ToolContext } from "./toolRuntime.js";

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
const REQUEST_TIMEOUT_MS = 120000;

export type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: Record<string, unknown> | string };
  }>;
  tool_name?: string;
  tool_call_id?: string;
};

export type OpenRouterTool = { type: "function"; function: unknown };

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
};

export function resolveOpenRouterApiKey(config?: AppConfig): string {
  return (process.env.OPENROUTER_API_KEY || config?.openrouter?.apiKey || "").trim();
}

export function resolveOpenRouterModel(config?: AppConfig): string {
  return (process.env.OPENROUTER_MODEL || config?.openrouter?.model || DEFAULT_OPENROUTER_MODEL).trim();
}

export function resolveOpenRouterBaseUrl(config?: AppConfig): string {
  return (process.env.OPENROUTER_BASE_URL || config?.openrouter?.baseUrl || DEFAULT_OPENROUTER_URL).replace(/\/+$/, "");
}

export function useOpenRouter(config?: AppConfig): boolean {
  return Boolean(config?.openrouter?.enabled && resolveOpenRouterApiKey(config));
}

export function isOpenRouterConfigured(config?: AppConfig): boolean {
  return Boolean(resolveOpenRouterApiKey(config));
}

export async function ensureOpenRouterReady(config: AppConfig): Promise<{ ready: boolean; model: string; message: string }> {
  const model = resolveOpenRouterModel(config);
  const apiKey = resolveOpenRouterApiKey(config);
  if (!config.openrouter?.enabled) {
    return { ready: false, model, message: "OpenRouter is disabled. Enable it in Settings to use cloud Gemma." };
  }
  if (!apiKey) {
    return {
      ready: false,
      model,
      message: "Add your OpenRouter API key in Settings (stored locally on this device)."
    };
  }
  return { ready: true, model, message: `OpenRouter ready (${model}).` };
}

function toOpenAiMessages(messages: OpenRouterChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id ?? message.tool_name ?? "tool",
        content: message.content
      };
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id ?? `call_${call.function?.name ?? "tool"}`,
          type: "function",
          function: {
            name: call.function?.name ?? "tool",
            arguments:
              typeof call.function?.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {})
          }
        }))
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toOpenAiTools(tools: OpenRouterTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: tool.function
  }));
}

function reportOpenRouterStats(
  payload: OpenRouterChatResponse,
  model: string,
  elapsedMs: number,
  opts: { thinkReason?: string; context?: ToolContext }
): void {
  const onStats = opts.context?.onModelStats;
  if (!onStats) {
    return;
  }
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const stats: ModelStats = {
    model: `openrouter:${model}`,
    tokensPerSecond:
      completionTokens > 0 ? Math.round((completionTokens / elapsedSeconds) * 10) / 10 : 0,
    ttftSeconds: Math.round(elapsedSeconds * 100) / 100,
    evalCount: completionTokens,
    totalSeconds: Math.round(elapsedSeconds * 100) / 100,
    thinking: false,
    thinkReason: opts.thinkReason,
    toolScope: opts.context?.toolScope,
    at: Date.now()
  };
  try {
    onStats(stats);
  } catch {
    // Stats reporting must never break inference.
  }
}

export async function openRouterChat(
  messages: OpenRouterChatMessage[],
  tools: OpenRouterTool[] | undefined,
  config: AppConfig | undefined,
  opts: { thinkReason?: string; context?: ToolContext } = {}
): Promise<{ content?: string; tool_calls?: OpenRouterChatMessage["tool_calls"] }> {
  const apiKey = resolveOpenRouterApiKey(config);
  if (!apiKey) {
    throw new Error("OpenRouter API key is not set. Add it in Settings.");
  }

  const model = resolveOpenRouterModel(config);
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(messages),
    temperature: 1.0,
    top_p: 0.95
  };
  const openAiTools = toOpenAiTools(tools);
  if (openAiTools?.length) {
    body.tools = openAiTools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${resolveOpenRouterBaseUrl(config)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/AnvithPothula/RAISE-Hackathon",
        "X-Title": "Pythos"
      },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`Could not reach OpenRouter. Check your network and API key. ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await response.json()) as OpenRouterChatResponse;
  if (!response.ok) {
    const detail = payload.error?.message || JSON.stringify(payload).slice(0, 240);
    throw new Error(`OpenRouter returned HTTP ${response.status}: ${detail}`);
  }

  reportOpenRouterStats(payload, model, Date.now() - startedAt, opts);
  const message = payload.choices?.[0]?.message;
  const toolCalls = message?.tool_calls?.map((call) => ({
    id: call.id,
    function: {
      name: call.function?.name,
      arguments: parseToolArguments(call.function?.arguments)
    }
  }));

  return {
    content: message?.content ?? "",
    tool_calls: toolCalls
  };
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
