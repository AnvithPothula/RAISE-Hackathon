import fs from "node:fs";
import type { AppConfig, ModelStats, ThinkMode } from "../shared/types.js";
import { isToolAllowedForScope, routeUserIntent } from "./intentRouter.js";
import {
  buildFunctionDeclarations,
  executeToolCall,
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
// Keep the model resident in memory between turns. Without this, Ollama unloads
// after ~5 min idle and every prompt eats a multi-second cold reload (the 20s+
// TTFT seen in demos). 30m covers a full demo/judging session.
const KEEP_ALIVE = process.env.PYTHOS_OLLAMA_KEEP_ALIVE || "30m";

// Resolution order: explicit env override > config.json > built-in default. The
// env override keeps CI/scripts flexible; config.json is what the app ships with.
function resolveOllamaUrl(config?: AppConfig): string {
  return (process.env.PYTHOS_OLLAMA_URL || config?.ollama?.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

export function resolveOllamaModel(config?: AppConfig): string {
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
  return installedModelOverride ?? resolveOllamaModel(config);
}

let installedModelOverride: string | null = null;

async function listPulledModelNames(config?: AppConfig): Promise<string[]> {
  try {
    const response = await fetch(`${resolveOllamaUrl(config)}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    return (payload.models ?? []).map((model) => model.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** Pick a pulled model, falling back from low-resource to the default when needed. */
export async function resolveInstalledOllamaModel(config?: AppConfig): Promise<string> {
  const preferred = resolveOllamaModel(config);
  const pulled = await listPulledModelNames(config);
  if (pulled.includes(preferred)) {
    installedModelOverride = preferred;
    return preferred;
  }
  const fallback = config?.ollama?.model || DEFAULT_OLLAMA_MODEL;
  if (preferred !== fallback && pulled.includes(fallback)) {
    installedModelOverride = fallback;
    return fallback;
  }
  const anyGemma = pulled.find((name) => name.startsWith("gemma4:"));
  if (anyGemma) {
    installedModelOverride = anyGemma;
    return anyGemma;
  }
  installedModelOverride = preferred;
  return preferred;
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
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  error?: string;
};

type ThinkDecision = { think: boolean; reason: string };

/**
 * Adaptive thinking: Gemma decides per request whether to spend tokens on an
 * internal reasoning pass. Simple operational asks (weather, alarms, playback)
 * stay on the fast path for voice latency; analytical or multi-step requests
 * turn thinking on. Users can pin it with ollama.think = "on" | "off" in config.
 */
export function decideThinking(prompt: string, mode: ThinkMode = "auto"): ThinkDecision {
  if (mode === "on") {
    return { think: true, reason: "pinned on in settings" };
  }
  if (mode === "off") {
    return { think: false, reason: "pinned off in settings" };
  }

  const text = ` ${prompt.toLowerCase()} `;
  const words = text.split(/\s+/).filter(Boolean).length;
  const operationalSignals = [
    "open ",
    "launch ",
    "start ",
    "pull up ",
    "bring up "
  ];
  const matchedOperational = operationalSignals.find((signal) => text.includes(signal));
  if (matchedOperational) {
    return { think: false, reason: `detected "${matchedOperational.trim()}"` };
  }

  const reasoningSignals = [
    "why ",
    "how do",
    "how would",
    "how should",
    "how can",
    "explain",
    "plan ",
    "analyze",
    "analyse",
    "compare",
    " versus ",
    " vs ",
    "difference between",
    "pros and cons",
    "trade-off",
    "tradeoff",
    "research",
    "investigate",
    "strategy",
    "design ",
    "debug",
    "prove ",
    "derive",
    "optimiz",
    "algorithm",
    "step by step",
    "should i ",
    "which is better",
    "evaluate",
    "estimate",
    "summarize the",
    "write code",
    "write a script",
    "write a program"
  ];
  const matched = reasoningSignals.find((signal) => text.includes(signal));
  if (matched) {
    return { think: true, reason: `detected "${matched.trim()}"` };
  }
  if (/\bsolve\b|\bequation\b|\bintegral\b|\bderivative\b|\d+\s*[*/^]\s*\d+/.test(text)) {
    return { think: true, reason: "math reasoning detected" };
  }
  if (words > 45) {
    return { think: true, reason: "long multi-part request" };
  }
  if (/\b(research|investigate|compare|analyze|implement|refactor|architect|debug|optimize)\b/.test(text)) {
    return { think: true, reason: "agentic task detected" };
  }
  return { think: false, reason: "simple request, fast path" };
}

export async function generateWithOllama(
  prompt: string,
  config: AppConfig,
  context: ToolContext = {}
): Promise<string> {
  context.prompt = prompt;
  if (!context.toolScope) {
    context.toolScope = routeUserIntent(prompt, {
      previousToolName: null,
      knownLocation: context.knownLocation
    }).llmToolScope;
  }
  const messages = buildMessages(prompt, context);
  const tools = buildTools(context);

  // Adaptive thinking: complex requests get an internal reasoning pass and a
  // larger tool-loop budget; simple ones stay on the low-latency voice path.
  const decision = decideThinking(prompt, config.ollama?.think ?? "auto");
  const maxSteps = decision.think ? 5 : 3;

  for (let step = 0; step < maxSteps; step += 1) {
    const message = await chat(messages, tools, config, { think: decision.think, thinkReason: decision.reason, context });
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

  const final = await chat(messages, undefined, config, { think: false, context });
  return cleanText(final.content) || "I did not get a response from the local model.";
}

// Dispatch a tool call locally. run_sub_agent and deep_research are handled by
// local Gemma loops so the assistant stays fully on-device; every other tool
// reuses the shared executor.
async function runToolCall(call: ToolFunctionCall, config: AppConfig, context: ToolContext) {
  const task = String((call.args as { task?: unknown } | undefined)?.task ?? context.prompt ?? "");
  if (call.name === "run_sub_agent") {
    const startedAt = Date.now();
    context.onToolEvent?.("start", { name: "sub_agent", text: "Running sub agent" });
    const text = await runLocalSubAgent(task, config, context);
    context.onToolEvent?.("end", { name: "sub_agent", text, durationMs: Date.now() - startedAt });
    return { call, result: { name: "sub_agent", text } };
  }
  if (call.name === "deep_research") {
    const startedAt = Date.now();
    context.onToolEvent?.("start", { name: "deep_research", text: `Researching: ${task.slice(0, 120)}` });
    const text = await runDeepResearch(task, config, context);
    context.onToolEvent?.("end", { name: "deep_research", text, durationMs: Date.now() - startedAt });
    return { call, result: { name: "deep_research", text } };
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
  const tools = buildTools(context).filter((tool) => !isLoopToolName((tool.function as { name?: string }).name));

  for (let step = 0; step < 4; step += 1) {
    const message = await chat(messages, tools, config, { context });
    const toolCalls = (message.tool_calls ?? []).filter(
      (toolCall) => !isLoopToolName(toolCall.function?.name)
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

  const final = await chat(messages, undefined, config, { context });
  return cleanText(final.content) || "Sub-agent finished its tool loop.";
}

// The model chooses its own iteration budget at the start of research mode.
// These bound that choice so a bad plan can neither under- nor over-commit.
const RESEARCH_MIN_ROUNDS = 2;
const RESEARCH_MAX_ROUNDS = 8; // upper bound the model may choose up front
const RESEARCH_DEFAULT_ROUNDS = 4; // fallback when the planning step fails
// Absolute ceiling on total rounds, including any extra rounds granted by the
// accidental-exit guard. Bounds worst-case model calls regardless of the plan.
const RESEARCH_HARD_CAP = 12;
// How many times the exit guard may override an early "I'm done" before the
// answer is accepted anyway, so completion checks cannot loop forever.
const RESEARCH_MAX_OVERRIDES = 3;
// Consecutive empty/failed rounds tolerated before the loop bails out. Keeps a
// flaky model or transport from spinning against the hard cap doing nothing.
const RESEARCH_MAX_EMPTY_STREAK = 2;

type ResearchPlan = { rounds: number; plan: string };

/**
 * Self-looping research / iteration agent, fully on the local model. Before any
 * work the model picks its own round budget (a plan step), then each round it
 * calls tools, studies results, and reflects on gaps. Two accidental-exit
 * guards keep it from bailing on a long task: (1) it may not stop before its
 * chosen budget unless a completion check confirms the task is genuinely done,
 * and (2) a thrown chat/tool error or an empty response retries instead of
 * ending the loop. An absolute hard cap bounds total model calls.
 */
async function runDeepResearch(task: string, config: AppConfig, context: ToolContext): Promise<string> {
  const { rounds, plan } = await planResearch(task, config, context);
  context.onToolEvent?.("start", {
    name: "deep_research",
    text: `Planned ${rounds} research round${rounds === 1 ? "" : "s"}${plan ? `: ${plan}` : ""}`
  });

  const researchSystem =
    `${readSystemPrompt(context.mcp)}\n\n` +
    "You are in deep research / iteration mode. " +
    `You have committed to a budget of ${rounds} rounds for this task${plan ? ` (plan: ${plan})` : ""}. ` +
    "Each round, call whatever tools you need — web_search with focused queries, run_code for computation, " +
    "or other available tools — and you may issue several tool calls in a single round. Study the results and " +
    "reflect on what is still missing. Do NOT stop or give a final answer until EVERY part of the task is " +
    "genuinely complete with evidence; partial progress is not a valid stopping point. When the whole task is " +
    "done, produce a final answer in plain spoken prose naming the key sources. Never invent sources.";
  const messages: OllamaMessage[] = [
    { role: "system", content: researchSystem },
    { role: "user", content: `Research task: ${task}` }
  ];
  const tools = buildTools(context).filter((tool) => !isLoopToolName((tool.function as { name?: string }).name));

  let overrides = 0;
  let emptyStreak = 0;
  let lastAnswer = "";

  for (let round = 0; round < RESEARCH_HARD_CAP; round += 1) {
    let message: { content?: string; tool_calls?: OllamaToolCall[] };
    try {
      message = await chat(messages, tools, config, {
        think: true,
        thinkReason: `deep research ${round + 1}/${rounds}`,
        context
      });
    } catch (error) {
      // Accidental-exit protection: a transient model/transport error must not
      // end a long research task. Retry a bounded number of times.
      emptyStreak += 1;
      if (emptyStreak > RESEARCH_MAX_EMPTY_STREAK) {
        break;
      }
      messages.push({
        role: "user",
        content: `A step failed (${String(error)}). Retry the previous action or continue the research.`
      });
      continue;
    }

    const toolCalls = message.tool_calls ?? [];

    if (!toolCalls.length) {
      const answer = cleanText(message.content);
      if (!answer) {
        // Empty response guard: nudge once or twice, then give up gracefully.
        emptyStreak += 1;
        if (emptyStreak > RESEARCH_MAX_EMPTY_STREAK) {
          break;
        }
        messages.push({
          role: "user",
          content: "Your response was empty. Continue researching with a tool call, or give the final sourced answer."
        });
        continue;
      }

      emptyStreak = 0;
      lastAnswer = answer;

      // Accidental-exit protection: while still inside the chosen budget, do not
      // accept an early finish unless a completion check confirms the task is
      // fully done. The override counter bounds how often this can force a loop.
      const withinBudget = round + 1 < Math.min(rounds, RESEARCH_HARD_CAP);
      if (withinBudget && overrides < RESEARCH_MAX_OVERRIDES) {
        const check = await verifyResearchComplete(task, answer, config, context);
        if (check.complete) {
          return answer;
        }
        overrides += 1;
        messages.push({
          role: "user",
          content:
            `The task is not complete yet. Still missing: ${check.reason} ` +
            "Do not stop — call another tool to fill that gap, then continue."
        });
        continue;
      }
      return answer;
    }

    emptyStreak = 0;
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
    // Explicit reflection: the model itself decides whether to loop again.
    messages.push({
      role: "user",
      content:
        `Reflection after round ${round + 1} of ${rounds}: list what you have learned so far in one sentence, ` +
        "then either call another tool to fill a specific gap, or — only if the whole task is done — give the final sourced answer."
    });
  }

  if (lastAnswer) {
    return lastAnswer;
  }
  const final = await chat(messages, undefined, config, { think: true, thinkReason: "research synthesis", context });
  return cleanText(final.content) || "Research loop ended without a conclusion.";
}

/**
 * Planning step run once at the start of research mode. The model estimates how
 * many rounds of tool use the task needs and returns a small JSON budget, which
 * is clamped to a safe range. This is the "as it chooses at the start" budget.
 */
async function planResearch(task: string, config: AppConfig, context: ToolContext): Promise<ResearchPlan> {
  const messages: OllamaMessage[] = [
    {
      role: "system",
      content:
        "You are about to start a multi-step research/iteration task. First choose an iteration budget: estimate " +
        "how many rounds of tool use (web searches, reads, calculations) the task realistically needs to be answered " +
        `thoroughly. Reply with ONLY compact JSON: {"rounds": <integer between ${RESEARCH_MIN_ROUNDS} and ${RESEARCH_MAX_ROUNDS}>, ` +
        '"plan": "<one short sentence describing your approach>"}. Choose more rounds for broad, comparative, or ' +
        "multi-part tasks, and fewer for narrow ones."
    },
    { role: "user", content: `Task: ${task}` }
  ];
  try {
    const message = await chat(messages, undefined, config, { think: false, thinkReason: "research plan", context });
    const parsed = parseResearchPlan(cleanText(message.content));
    if (parsed) {
      return { rounds: clampRounds(parsed.rounds), plan: parsed.plan ?? "" };
    }
  } catch {
    // Fall through to the default budget if planning fails.
  }
  return { rounds: RESEARCH_DEFAULT_ROUNDS, plan: "" };
}

/**
 * Strict completion auditor used by the accidental-exit guard. Given the task
 * and a proposed final answer, it returns whether the task is fully done and,
 * if not, what is still missing. If the audit call itself fails, the answer is
 * accepted so a broken auditor cannot trap the loop.
 */
async function verifyResearchComplete(
  task: string,
  answer: string,
  config: AppConfig,
  context: ToolContext
): Promise<{ complete: boolean; reason: string }> {
  const messages: OllamaMessage[] = [
    {
      role: "system",
      content:
        "You are a strict completion auditor. Given a TASK and a PROPOSED ANSWER, decide whether the answer fully " +
        "and accurately completes every part of the task with adequate evidence. Reply with ONLY 'COMPLETE' if it is " +
        "fully done, or 'CONTINUE: <specifically what is still missing>' if it is not."
    },
    { role: "user", content: `TASK:\n${task}\n\nPROPOSED ANSWER:\n${answer}` }
  ];
  try {
    const message = await chat(messages, undefined, config, { think: false, thinkReason: "completion check", context });
    const text = cleanText(message.content);
    if (/^\s*complete\b/i.test(text)) {
      return { complete: true, reason: "" };
    }
    const reason = text.replace(/^\s*continue\s*:?\s*/i, "").trim();
    return { complete: false, reason: reason || "some parts of the task are still unaddressed." };
  } catch {
    return { complete: true, reason: "" };
  }
}

export function parseResearchPlan(text: string): { rounds?: number; plan?: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const obj = JSON.parse(match[0]) as { rounds?: unknown; plan?: unknown };
    const rounds = typeof obj.rounds === "number" ? obj.rounds : Number(obj.rounds);
    return {
      rounds: Number.isFinite(rounds) ? rounds : undefined,
      plan: typeof obj.plan === "string" ? obj.plan : undefined
    };
  } catch {
    return null;
  }
}

export function clampRounds(rounds: number | undefined): number {
  if (!rounds || !Number.isFinite(rounds)) {
    return RESEARCH_DEFAULT_ROUNDS;
  }
  return Math.max(RESEARCH_MIN_ROUNDS, Math.min(RESEARCH_MAX_ROUNDS, Math.round(rounds)));
}

function isLoopToolName(name: string | undefined): boolean {
  return name === "run_sub_agent" || name === "deep_research";
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
    model: await resolveInstalledOllamaModel(config),
    stream: false,
    think: false,
    keep_alive: KEEP_ALIVE,
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

/**
 * Preload the model into memory so the first real prompt is fast. Ollama's
 * /api/generate with an empty prompt loads the weights and honors keep_alive
 * without generating any tokens. Best-effort: failures are swallowed.
 */
export async function warmUpModel(config?: AppConfig): Promise<boolean> {
  try {
    // Prime with the real system prompt + built-in tool schemas so Ollama caches
    // that (constant) prefix's KV. Real requests then skip re-evaluating it,
    // which is the dominant cost of first-token latency on larger models.
    const tools = buildFunctionDeclarations().map((declaration) => ({ type: "function", function: declaration }));
    const response = await fetch(`${resolveOllamaUrl(config)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: resolveOllamaModel(config),
        keep_alive: KEEP_ALIVE,
        think: false,
        stream: false,
        tools,
        messages: [
          { role: "system", content: readSystemPrompt() },
          { role: "user", content: "hi" }
        ],
        options: { num_predict: 1, temperature: 1.0, top_p: 0.95, top_k: 64 }
      })
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True if the local Ollama server is reachable and has a usable Gemma model pulled. */
export async function isOllamaReady(config?: AppConfig): Promise<boolean> {
  const pulled = await listPulledModelNames(config);
  if (!pulled.length) {
    return false;
  }
  const preferred = resolveOllamaModel(config);
  if (pulled.includes(preferred)) {
    return true;
  }
  const fallback = config?.ollama?.model || DEFAULT_OLLAMA_MODEL;
  return pulled.includes(fallback) || pulled.some((name) => name.startsWith("gemma4:"));
}

type ChatOptions = {
  think?: boolean;
  thinkReason?: string;
  context?: ToolContext;
};

async function chat(
  messages: OllamaMessage[],
  tools: OllamaTool[] | undefined,
  config?: AppConfig,
  opts: ChatOptions = {}
): Promise<{ content?: string; tool_calls?: OllamaToolCall[] }> {
  const url = resolveOllamaUrl(config);
  const model = await resolveInstalledOllamaModel(config);
  const think = opts.think ?? false;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    think,
    keep_alive: KEEP_ALIVE,
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
  reportStats(payload, model, think, opts);
  return payload.message ?? { content: "" };
}

// Surface Ollama's per-request timings as tok/s and TTFT for the on-screen
// performance HUD (judges see real numbers, plan task 14).
function reportStats(payload: OllamaChatResponse, model: string, think: boolean, opts: ChatOptions): void {
  const onStats = opts.context?.onModelStats;
  if (!onStats) {
    return;
  }
  const evalCount = payload.eval_count ?? 0;
  const evalSeconds = (payload.eval_duration ?? 0) / 1e9;
  const stats: ModelStats = {
    model,
    tokensPerSecond: evalSeconds > 0 ? Math.round((evalCount / evalSeconds) * 10) / 10 : 0,
    ttftSeconds:
      Math.round((((payload.load_duration ?? 0) + (payload.prompt_eval_duration ?? 0)) / 1e9) * 100) / 100,
    evalCount,
    totalSeconds: Math.round(((payload.total_duration ?? 0) / 1e9) * 100) / 100,
    thinking: think,
    thinkReason: opts.thinkReason,
    at: Date.now()
  };
  try {
    onStats(stats);
  } catch {
    // Stats reporting must never break inference.
  }
}

function buildTools(context: ToolContext): OllamaTool[] {
  const scope = context.toolScope ?? "full";
  const declarations = [
    ...buildFunctionDeclarations(scope),
    ...(scope === "minimal" ? [] : (context.mcp?.listToolDeclarations() ?? []))
  ].filter((declaration) => isToolAllowedForScope(String(declaration.name), scope));
  return declarations.map((declaration) => ({ type: "function", function: declaration }));
}

function buildMessages(prompt: string, context: ToolContext): OllamaMessage[] {
  const scope = context.toolScope ?? "full";
  const messages: OllamaMessage[] = [{ role: "system", content: readSystemPrompt(context.mcp, scope) }];

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
