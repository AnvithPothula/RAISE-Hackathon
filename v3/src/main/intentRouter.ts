import type { LocalToolInvocation, LocalToolName } from "./localTools.js";
import { looksLikeFolderOpenRequest, looksLikeFolderPath, parseFolderTarget } from "./filesystemAccess.js";
import { extractMathExpression, looksLikeMathQuestion } from "./mathExpression.js";
import { extractLocationFromPrompt } from "./locationUtils.js";
import { cleanAppTarget, stripConversationalPrefix } from "./voiceTranscript.js";

/** instant = run a local tool with zero LLM; simple/complex = Gemma with trimmed/full tools. */
export type TaskDifficulty = "instant" | "simple" | "complex";

/** How many tools the local model sees when a prompt still needs inference. */
export type LlmToolScope = "none" | "minimal" | "standard" | "full";

export type IntentRoutingContext = {
  previousToolName?: LocalToolName | null;
  knownLocation?: string | null;
};

export type IntentDecision = {
  difficulty: TaskDifficulty;
  invocation: LocalToolInvocation | null;
  llmToolScope: LlmToolScope;
  reason: string;
};

const COMPLEX_SIGNALS = [
  "research",
  "investigate",
  "compare",
  "versus",
  " vs ",
  "pros and cons",
  "trade-off",
  "tradeoff",
  "step by step",
  "explain why",
  "explain how",
  "write code",
  "write a script",
  "write a program",
  "debug",
  "refactor",
  "architect",
  "implement",
  "design ",
  "analyze",
  "analyse",
  "deep dive",
  "comprehensive",
  "detailed report",
  "multiple sources",
  "sub agent",
  "delegate"
];

const MINIMAL_LLM_TOOLS = new Set([
  "get_weather",
  "get_time",
  "calculate",
  "set_manage_alarm",
  "open_app",
  "open_website",
  "web_search",
  "control_spotify",
  "update_user_memory"
]);

const HEAVY_LLM_TOOLS = new Set([
  "run_sub_agent",
  "deep_research",
  "delegate_coding_task",
  "run_code",
  "run_skill_script",
  "inspect_screen"
]);

/**
 * Decide whether a prompt can be satisfied instantly, and how much tool surface the
 * local model needs when inference is still required.
 */
export function routeUserIntent(prompt: string, context: IntentRoutingContext = {}): IntentDecision {
  const cleanPrompt = cleanDirectPrompt(prompt);
  const normalized = normalizeCommandText(cleanPrompt);

  if (needsMultiToolLoop(cleanPrompt, normalized)) {
    return {
      difficulty: "simple",
      invocation: null,
      llmToolScope: "standard",
      reason: "multi-tool-loop"
    };
  }

  const contextual = resolveContextualIntent(cleanPrompt, normalized, context);
  if (contextual) {
    return contextual;
  }

  const instant =
    resolveCapabilitiesIntent(cleanPrompt) ??
    resolveClipboardIntent(cleanPrompt, normalized) ??
    resolveScreenIntent(cleanPrompt, normalized) ??
    resolveOpenFolderIntent(cleanPrompt, normalized) ??
    resolveDirectoryIntent(cleanPrompt, normalized) ??
    resolveCalculatorIntent(cleanPrompt, normalized) ??
    resolveAlarmIntent(cleanPrompt, normalized) ??
    resolveMemoryIntent(cleanPrompt, normalized) ??
    resolveWebSearchIntent(cleanPrompt, normalized) ??
    resolveGoToWebsiteIntent(cleanPrompt, normalized) ??
    resolveWeatherIntent(cleanPrompt, normalized, context.knownLocation) ??
    resolveTimeIntent(cleanPrompt, normalized, context.knownLocation) ??
    resolveOpenIntent(cleanPrompt) ??
    resolveSpotifyPlayIntent(cleanPrompt);

  if (instant) {
    return {
      difficulty: "instant",
      invocation: instant,
      llmToolScope: "minimal",
      reason: `instant:${instant.name}`
    };
  }

  const llmToolScope = classifyLlmToolScope(cleanPrompt, normalized);
  return {
    difficulty: llmToolScope === "full" ? "complex" : "simple",
    invocation: null,
    llmToolScope,
    reason: llmToolScope === "full" ? "complex-llm" : "simple-llm"
  };
}

export function resolveContextualLocalTool(
  prompt: string,
  previousToolName: LocalToolName | null | undefined,
  knownLocation?: string | null
): LocalToolInvocation | null {
  const decision = routeUserIntent(prompt, { previousToolName, knownLocation });
  return decision.reason.startsWith("contextual:") ? decision.invocation : null;
}

export function isToolAllowedForScope(toolName: string | undefined, scope: LlmToolScope): boolean {
  const name = String(toolName ?? "");
  if (!name) {
    return false;
  }
  if (scope === "none") {
    return false;
  }
  if (scope === "full") {
    return true;
  }
  if (name.startsWith("mcp_")) {
    return scope === "standard";
  }
  if (HEAVY_LLM_TOOLS.has(name)) {
    return scope === "standard";
  }
  if (scope === "minimal") {
    return MINIMAL_LLM_TOOLS.has(name);
  }
  return true;
}

function classifyLlmToolScope(cleanPrompt: string, normalized: string): LlmToolScope {
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const text = ` ${normalized} `;

  if (needsMultiToolLoop(cleanPrompt, normalized)) {
    return "standard";
  }
  if (COMPLEX_SIGNALS.some((signal) => text.includes(signal))) {
    return "full";
  }
  if (words > 35) {
    return "full";
  }
  if (/\?.*\?/.test(cleanPrompt)) {
    return "full";
  }
  if (/\b(screen|clipboard|note|file|folder|directory|system stats|battery)\b/.test(normalized)) {
    return "standard";
  }
  if (looksLikeGeneralKnowledge(normalized)) {
    return "none";
  }
  return "minimal";
}

function looksLikeGeneralKnowledge(normalized: string): boolean {
  if (looksLikeMathQuestion(normalized)) {
    return false;
  }
  if (
    /\b(weather|forecast|open|launch|start|play|spotify|alarm|clipboard|screen|folder|directory|download|search|google|remember|forget|calculate|inspect|code|research|delegate|sub agent)\b/.test(
      normalized
    )
  ) {
    return false;
  }
  return (
    /^(?:what|why|when|where|who|how|is|are|was|were|does|do|did|can|could|would|should|tell me|explain|describe)\b/.test(
      normalized
    ) || normalized.endsWith("?")
  );
}

function resolveContextualIntent(
  cleanPrompt: string,
  normalized: string,
  context: IntentRoutingContext
): IntentDecision | null {
  const previous = context.previousToolName;
  if (!previous) {
    return null;
  }

  if (previous === "spotify") {
    const spotify = resolveSpotifyFollowUp(cleanPrompt, normalized);
    if (spotify) {
      return instantDecision(spotify, "contextual:spotify");
    }
  }

  if (previous === "weather" || previous === "time") {
    if (/\b(there|here|same place|that place|that city)\b/.test(normalized) && context.knownLocation) {
      const name = previous === "weather" ? "weather" : "time";
      return instantDecision(
        { name, args: { location: context.knownLocation } },
        `contextual:${name}-there`
      );
    }
    const location = extractLocationFromPrompt(cleanPrompt, context.knownLocation);
    if (location && /\b(what about|how about|instead|now)\b/.test(normalized)) {
      const name = /\b(time|date|day|clock)\b/.test(normalized) && !/\bweather\b/.test(normalized) ? "time" : "weather";
      return instantDecision({ name, args: { location } }, `contextual:${name}-followup`);
    }
    if (previous === "weather" && /\b(just the temp|temperature only|how hot|how cold)\b/.test(normalized)) {
      const loc = extractLocationFromPrompt(cleanPrompt, context.knownLocation) ?? context.knownLocation;
      return instantDecision(
        { name: "weather", args: loc ? { location: loc } : {} },
        "contextual:weather-temp"
      );
    }
  }

  return null;
}

function resolveCapabilitiesIntent(cleanPrompt: string): LocalToolInvocation | null {
  if (
    /^(?:so\s+)?(?:what|which)\s+(?:can|could|do)\s+you\s+(?:do|help|assist)/i.test(cleanPrompt) ||
    /^what\s+are\s+you\s+(?:capable|able)\b/i.test(cleanPrompt) ||
    /^(?:what\s+can\s+i\s+(?:ask|say)|list\s+(?:your\s+)?(?:commands|capabilities|features))/i.test(cleanPrompt)
  ) {
    return { name: "capabilities", args: {} };
  }
  return null;
}

function resolveClipboardIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  if (
    /\bclipboard\b/.test(normalized) &&
    (/\b(my|the)\s+clipboard\b/.test(normalized) ||
      /\b(read|check|show|get|grab|paste)\b/.test(normalized)) &&
    !/\bwhat\s+(?:is|are)\s+(?:a|an|the)\b/.test(normalized)
  ) {
    return { name: "clipboard", args: {} };
  }
  return null;
}

function resolveDirectoryIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  if (/\bweather\b/.test(normalized)) {
    return null;
  }
  const patterns = [
    /^(?:what(?:'s| is)?\s+(?:in|inside)|(?:list|show)\s+(?:me\s+)?(?:the\s+)?(?:files\s+in|contents\s+of))\s+(?:my\s+)?(.+?)(?:\s+folder)?$/i,
    /^what(?:'s| is)?\s+in\s+(?:my\s+)?(.+?)(?:\s+folder)?$/i
  ];
  for (const pattern of patterns) {
    const match = cleanPrompt.match(pattern);
    if (match?.[1]?.trim()) {
      return { name: "list_folder", args: { path: match[1].trim() } };
    }
  }
  return null;
}


function resolveOpenFolderIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  const simpleHomeFolder = cleanPrompt.match(
    /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:just\s+want\s+(?:you\s+to\s+)?)?(?:open|show|go to|view|reveal)\s+(?:the\s+|my\s+)?(documents|downloads|desktop|pictures|photos|music|movies)(?:\s+(?:folder|directory|further))?$/i
  );
  if (simpleHomeFolder?.[1]) {
    return { name: "list_folder", args: { path: simpleHomeFolder[1], action: "open" } };
  }

  const patterns = [
    /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:open|show|go to|view|reveal)\s+(?:my\s+)?(.+?)(?:\s+(?:folder|directory|further))?$/i,
    /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:open|show)\s+(?:the\s+)?(.+?)\s+(?:folder|directory|further)$/i
  ];
  for (const pattern of patterns) {
    const match = cleanPrompt.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) {
      continue;
    }
    if (!looksLikeFolderOpenRequest(cleanPrompt, raw)) {
      continue;
    }
    const [pathArg] = parseFolderTarget(raw);
    return { name: "list_folder", args: { path: pathArg ?? raw, action: "open" } };
  }
  return null;
}

function resolveSpotifyPlayIntent(cleanPrompt: string): LocalToolInvocation | null {
  const playMatch = cleanPrompt.match(/^(?:please\s+)?play\s+(?:me\s+|some\s+|a\s+|an\s+)?(.+)$/i);
  if (!playMatch) {
    return null;
  }
  const query = playMatch[1].replace(/\b(on|in|through|via)\s+spotify\b/i, "").replace(/\s+for me$/i, "").trim();
  if (!query || /^(the\s+)?(game|video|movie|film|episode|show)\b/i.test(query)) {
    return null;
  }
  return { name: "spotify", args: { action: "play", kind: "track", query } };
}

function resolveScreenIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  if (
    /\b(on|reading|read|see|look at|analyz|describe|what'?s on)\b.*\b(screen|display|monitor)\b/.test(
      normalized
    ) ||
    /\b(screen|display|monitor)\b.*\b(say|show|about|content|showing)\b/.test(normalized) ||
    /^what am i (?:looking at|seeing)\b/.test(normalized)
  ) {
    return { name: "screen", args: { query: cleanPrompt } };
  }
  return null;
}

function resolveCalculatorIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  const expression = extractMathExpression(cleanPrompt);
  if (expression) {
    return { name: "calculator", args: { expression } };
  }
  return null;
}

function resolveAlarmIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  if (/\b(list|show)\s+(?:my\s+|all\s+)?alarms?\b/.test(normalized)) {
    return { name: "alarm", args: { action: "list" } };
  }
  const cancelId = cleanPrompt.match(/\b(?:cancel|delete|remove|stop)\s+(?:the\s+)?alarm\s+(alarm-[a-z0-9]+)\b/i);
  if (cancelId) {
    return { name: "alarm", args: { action: "cancel", id: cancelId[1] } };
  }
  if (!/\b(alarm|wake me|remind me)\b/.test(normalized)) {
    return null;
  }
  const time = extractAlarmTimeFromPrompt(cleanPrompt);
  if (!time) {
    return null;
  }
  const labelMatch = cleanPrompt.match(/\b(?:called|labeled|named)\s+(.+?)(?:\s+(?:in|at|for)\b|$)/i);
  return {
    name: "alarm",
    args: {
      action: "set",
      time,
      label: labelMatch?.[1]?.trim() || "Alarm"
    }
  };
}

function resolveMemoryIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  if (/\b(what do you remember|list (?:my )?memories|show (?:my )?memories)\b/.test(normalized)) {
    return { name: "memory", args: { action: "list" } };
  }
  const rememberMatch = cleanPrompt.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i);
  if (rememberMatch) {
    return { name: "memory", args: { action: "add", text: rememberMatch[1].trim() } };
  }
  const forgetMatch = cleanPrompt.match(/^(?:please\s+)?forget(?:\s+that)?\s+(.+)$/i);
  if (forgetMatch) {
    return { name: "memory", args: { action: "forget", text: forgetMatch[1].trim() } };
  }
  return null;
}

function resolveWebSearchIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  const match = cleanPrompt.match(/^(?:please\s+)?(?:search(?:\s+(?:the\s+)?web)?\s+for|google|look up|find info(?:rmation)? on)\s+(.+)$/i);
  if (match) {
    const query = match[1].trim();
    if (query && !looksLikeWebsiteName(query)) {
      return { name: "web_search", args: { query } };
    }
  }
  if (/^(?:please\s+)?who is\s+(.+)$/i.test(cleanPrompt) && !/\b(me|you|pythos)\b/i.test(normalized)) {
    const query = cleanPrompt.replace(/^(?:please\s+)?who is\s+/i, "").trim();
    return { name: "web_search", args: { query: `who is ${query}` } };
  }
  return null;
}

function resolveGoToWebsiteIntent(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  const match = cleanPrompt.match(/^(?:please\s+)?(?:go to|visit|browse to)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const target = match[1].trim();
  if (looksLikeWebsiteName(target)) {
    return { name: "open_website", args: { url: target } };
  }
  return null;
}

function resolveWeatherIntent(cleanPrompt: string, normalized: string, knownLocation?: string | null): LocalToolInvocation | null {
  if (!/\b(weather|forecast|temperature|temp|rain|snow|wind|humidity|sunny|cloudy)\b/.test(normalized)) {
    return null;
  }
  const location = extractLocationFromPrompt(cleanPrompt, knownLocation);
  return { name: "weather", args: location ? { location } : {} };
}

function resolveTimeIntent(cleanPrompt: string, normalized: string, knownLocation?: string | null): LocalToolInvocation | null {
  if (/\b(weather|forecast|temperature|temp|rain|snow|wind)\b/.test(normalized)) {
    return null;
  }
  const asksTime =
    /\b(what time|what s the time|whats the time|current time|time is it|what date|what s the date|what day)\b/.test(
      normalized
    ) ||
    (/\b(time|date|day)\b/.test(normalized) && /\b(what|current|now|today|tonight|tomorrow)\b/.test(normalized));
  if (!asksTime) {
    return null;
  }
  const location = extractLocationFromPrompt(cleanPrompt, knownLocation);
  return { name: "time", args: location ? { location } : {} };
}

export function resolveOpenAppIntent(prompt: string): LocalToolInvocation | null {
  return resolveOpenIntent(cleanDirectPrompt(prompt));
}

/**
 * Collect every instant local-tool invocation parseable from a compound prompt
 * (e.g. weather + open app, or open Settings and Calendar).
 */
export function collectInstantInvocations(
  prompt: string,
  context: IntentRoutingContext = {}
): LocalToolInvocation[] {
  const cleanPrompt = cleanDirectPrompt(prompt);
  const normalized = normalizeCommandText(cleanPrompt);
  const invocations: LocalToolInvocation[] = [];
  const seen = new Set<string>();

  const add = (invocation: LocalToolInvocation | null): void => {
    if (!invocation) {
      return;
    }
    const key = `${invocation.name}:${JSON.stringify(invocation.args)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    invocations.push(invocation);
  };

  if (isOpenOnlyPrompt(cleanPrompt, normalized)) {
    const multiOpen = resolveMultipleOpenIntents(cleanPrompt);
    if (multiOpen.length >= 2) {
      multiOpen.forEach(add);
      return invocations;
    }
  }

  add(resolveWeatherIntent(cleanPrompt, normalized, context.knownLocation));
  add(resolveTimeIntent(cleanPrompt, normalized, context.knownLocation));
  add(resolveCalculatorIntent(cleanPrompt, normalized));
  add(resolveClipboardIntent(cleanPrompt, normalized));
  add(resolveTrailingOpenIntent(cleanPrompt));

  return invocations;
}

function isOpenOnlyPrompt(cleanPrompt: string, normalized: string): boolean {
  if (
    !/^(?:please\s+)?(?:can you\s+)?(?:openup|open|launch|start|pull|bring)(?:\s+up|\s+open)?\b/i.test(
      cleanPrompt
    )
  ) {
    return false;
  }
  return !/\b(weather|forecast|temperature|what is|what s|why|how|remember|search|play|alarm|clipboard|screen|calculate)\b/.test(
    normalized
  );
}

function splitCompoundTargets(text: string): string[] {
  return text
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => cleanAppTarget(part.replace(/^(?:and\s+)+/i, "")))
    .filter(Boolean);
}

function resolveMultipleOpenIntents(cleanPrompt: string): LocalToolInvocation[] {
  const prefix =
    /^(?:please\s+)?(?:can you\s+)?(?:openup|open|launch|start|pull|bring)(?:\s+up|\s+open)?\s+(?:the\s+|my\s+|a\s+|an\s+)?/i;
  const match = cleanPrompt.match(prefix);
  if (!match) {
    return [];
  }
  const remainder = cleanPrompt.slice(match[0].length).trim();
  if (!/\s+and\s+|\s*,\s*/i.test(remainder)) {
    return [];
  }

  const targets = splitCompoundTargets(remainder);
  if (targets.length < 2) {
    return [];
  }

  const invocations: LocalToolInvocation[] = [];
  for (const target of targets) {
    const invocation = resolveOpenIntentFromTarget(target);
    if (!invocation) {
      return [];
    }
    invocations.push(invocation);
  }
  return invocations;
}

function resolveTrailingOpenIntent(cleanPrompt: string): LocalToolInvocation | null {
  const embedded = cleanPrompt.match(
    /\band\s+(?:also\s+)?(?:please\s+)?(?:openup|open|launch|start|pull|bring|fire)(?:\s+up|\s+open)?\s+(?:the\s+|my\s+|a\s+|an\s+)?(.+)$/i
  );
  if (embedded) {
    return resolveOpenIntentFromTarget(embedded[1]);
  }
  if (/\b(?:weather|forecast|temperature|time|what|how|why|calculate|clipboard)\b/i.test(cleanPrompt)) {
    return resolveOpenIntent(cleanPrompt);
  }
  return null;
}

function resolveOpenIntentFromTarget(rawTarget: string, cleanPrompt?: string): LocalToolInvocation | null {
  const target = cleanAppTarget(rawTarget);
  if (!target) {
    return null;
  }
  const normalized = target.toLowerCase().replace(/\s+/g, " ").trim();
  const wantsDesktopApp =
    Boolean(cleanPrompt) &&
    (/\b(desktop|application|app)\b/i.test(rawTarget) ||
      /\b(?:desktop|application)\s+(?:app\s+)?$/i.test(cleanPrompt ?? ""));

  if (wantsDesktopApp) {
    const appTarget = normalized === "github" ? "GitHub Desktop" : target;
    if (isDirectAppLaunchTarget(appTarget.toLowerCase(), appTarget)) {
      return { name: "open_app", args: { app: appTarget } };
    }
  }
  if (isWebsiteTarget(normalized, target)) {
    return { name: "open_website", args: { url: target } };
  }
  if (looksLikeFolderOpenRequest(cleanPrompt, rawTarget)) {
    return null;
  }
  if (isDirectAppLaunchTarget(normalized, target)) {
    return { name: "open_app", args: { app: target } };
  }

  return null;
}

function resolveOpenIntent(cleanPrompt: string): LocalToolInvocation | null {
  const match = cleanPrompt.match(
    /\b(?:please\s+)?(?:openup|open|launch|start|pull|bring|fire)(?:\s+up|\s+open)?\s+(?:the\s+|my\s+|a\s+|an\s+)?(.+)$/i
  );
  if (!match) {
    return null;
  }
  return resolveOpenIntentFromTarget(match[1], cleanPrompt);
}

function resolveSpotifyFollowUp(cleanPrompt: string, normalized: string): LocalToolInvocation | null {
  if (/\b(skip|next)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "next" } };
  }
  if (/\b(pause|stop)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "pause" } };
  }
  if (/\b(resume|continue|unpause)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "resume" } };
  }
  if (/\b(what(?:'s| is)? playing|what song)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "status" } };
  }
  const playMatch = cleanPrompt.match(/^(?:please\s+)?play\s+(.+)$/i);
  if (playMatch) {
    return { name: "spotify", args: { action: "play", kind: "track", query: playMatch[1].trim() } };
  }
  return null;
}

function instantDecision(invocation: LocalToolInvocation, reason: string): IntentDecision {
  return {
    difficulty: "instant",
    invocation,
    llmToolScope: "minimal",
    reason
  };
}

/** True when the user asked for more than one tool-backed action in a single turn. */
export function needsMultiToolLoop(cleanPrompt: string, normalized: string): boolean {
  const text = ` ${normalized} `;
  const categories = new Set<string>();

  if (looksLikeWebSearchIntent(normalized)) {
    categories.add("search");
  }
  if (/\b(weather|forecast|temperature|temp|rain|snow|wind|humidity)\b/.test(normalized)) {
    categories.add("weather");
  }
  if (
    /\b(what time|what s the time|current time|what date|what day)\b/.test(normalized) ||
    (/\b(time|date|day)\b/.test(normalized) && /\b(what|current|now)\b/.test(normalized))
  ) {
    categories.add("time");
  }
  if (/\b(open|launch|start|pull up|bring up)\b/.test(normalized)) {
    categories.add("open");
  }
  const openingSpotify = /\b(open|launch|start|pull up|bring up)\b.*\bspotify\b/.test(normalized);
  if (
    !openingSpotify &&
    (/\b(play|pause|skip|resume|shuffle|repeat|volume)\b/.test(normalized) ||
      (/\bspotify\b/.test(normalized) && !/\b(open|launch|start)\b/.test(normalized)))
  ) {
    categories.add("spotify");
  }
  if (/\b(remember|forget|memories)\b/.test(normalized)) {
    categories.add("memory");
  }
  if (/\b(alarm|wake me|remind me)\b/.test(normalized)) {
    categories.add("alarm");
  }
  if (/\b(screen|clipboard)\b/.test(normalized)) {
    categories.add("device");
  }
  if (
    /\b(folder|directory)\b/.test(normalized) &&
    !/\b(open|launch|start|show|go to|view|list|what(?:'s| is)\s+in)\b/.test(normalized)
  ) {
    categories.add("device");
  }

  if (categories.size >= 2) {
    return true;
  }

  const hasSequencer = /\b(then|and also|after that|afterwards|before that|first,|next,|finally)\b/.test(text);
  const hasCompoundAnd =
    /\band\b/.test(normalized) &&
    /\b(weather|time|tell me|show me|give me|current|forecast)\b/.test(normalized);
  if (!hasSequencer && !hasCompoundAnd) {
    return false;
  }

  const hasSearchVerb =
    looksLikeWebSearchIntent(normalized) ||
    /\bsearch\b/.test(normalized) ||
    /\b(find|look up)\b/.test(normalized);
  const hasFollowUpAsk =
    /\b(then|and also|and)\b.*\b(weather|time|tell me|show me|give me|current|forecast)\b/.test(normalized);
  return hasSearchVerb && hasFollowUpAsk;
}

function looksLikeWebSearchIntent(normalized: string): boolean {
  if (/\bfind(?:\s+me)?\s+(?:the\s+)?(?:weather|forecast|temperature|time|date)\b/.test(normalized)) {
    return false;
  }
  return (
    /\b(search|google|look up|find info|find information)\b/.test(normalized) ||
    /^search\b/.test(normalized) ||
    /\b(things to do|fun things|what to do|cool things|places to visit|places to go|activities|attractions|restaurants)\b/.test(
      normalized
    ) ||
    /\b(things happening|what s happening|going on|current events|local news|news in|happening in|happening there)\b/.test(
      normalized
    ) ||
    /\bwhat are\b.*\b(happening|going on|events|news)\b/.test(normalized) ||
    /\bfind(?:\s+me)?\s+(?:fun|cool|good|interesting|some)\b/.test(normalized)
  );
}

function looksLikeCurrentEventsSearch(normalized: string): boolean {
  return (
    /\b(things happening|what s happening|going on|current events|local news|news in|happening in|happening there)\b/.test(
      normalized
    ) || /\bwhat are\b.*\b(happening|going on|events|news)\b/.test(normalized)
  );
}

function webSearchPartLabel(normalized: string): string {
  return looksLikeCurrentEventsSearch(normalized) ? "current local events" : "fun things to do";
}

export function promptNeedsMultiToolLoop(prompt: string): boolean {
  const cleanPrompt = cleanDirectPrompt(prompt);
  return needsMultiToolLoop(cleanPrompt, normalizeCommandText(cleanPrompt));
}

const MULTI_PART_COVERAGE: Record<string, RegExp> = {
  "fun things to do":
    /\b(things to do|attraction|museum|park|hike|restaurant|event|visit|activity|activities|festival|zoo|gallery|balloon|trail|downtown|old town|explore|check out|sandia|biopark|nob hill)\b/i,
  "current local events":
    /\b(event|events|festival|concert|happening|news|exhibit|opening|fair|market|rally|show|game|tonight|this weekend|annual|parade|conference|protest|celebration|schedule)\b/i,
  "current weather":
    /\b(degree|degrees|fahrenheit|celsius|cloud|rain|sunny|humidity|wind|forecast|weather|partly|clear|snow|hot|cold)\b/i,
  "current time": /\b(\d{1,2}:\d{2}|am|pm|o'clock|time is|date is|today is|tonight|morning|afternoon|evening)\b/i
};

/** Human-readable parts the user asked for in a compound tool-using request. */
export function getMultiPartRequestLabels(prompt: string): string[] {
  const normalized = normalizeCommandText(cleanDirectPrompt(prompt));
  const labels: string[] = [];
  if (looksLikeWebSearchIntent(normalized)) {
    labels.push(webSearchPartLabel(normalized));
  }
  if (/\b(weather|forecast|temperature|temp)\b/.test(normalized)) {
    labels.push("current weather");
  }
  if (
    /\b(what time|what s the time|current time|what date|what day)\b/.test(normalized) ||
    (/\b(time|date|day)\b/.test(normalized) && /\b(what|current|now)\b/.test(normalized))
  ) {
    labels.push("current time");
  }
  return labels;
}

/** When a compound request was only partly answered, return a nudge for the model loop. */
export function multiPartAnswerNudge(prompt: string, answer: string, toolsUsed: string[] = []): string | null {
  if (!promptNeedsMultiToolLoop(prompt)) {
    return null;
  }
  const labels = getMultiPartRequestLabels(prompt);
  if (labels.length < 2) {
    return null;
  }
  const missing = labels.filter((label) => !MULTI_PART_COVERAGE[label]?.test(answer));
  if (!missing.length) {
    return null;
  }
  const usedSearch = toolsUsed.some((name) => name === "web_search" || name === "deep_research");
  const needsSearchSummary = missing.some((label) => label === "fun things to do" || label === "current local events");
  const searchNote = usedSearch && needsSearchSummary
    ? " Summarize the key findings from the web_search results."
    : "";
  return (
    `Your answer only covered part of the request. The user also asked for: ${missing.join(" and ")}.` +
    `${searchNote} Give one concise spoken answer that addresses every part using the tool results already above.`
  );
}

function cleanDirectPrompt(prompt: string): string {
  return stripConversationalPrefix(
    String(prompt ?? "")
      .trim()
      .replace(/[.!?]+$/g, "")
      .replace(/^(?:hey\s+)?pythos[,:\s]+/i, "")
      .trim()
  );
}

function normalizeCommandText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s'%+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAlarmTimeFromPrompt(prompt: string): string | null {
  const normalized = prompt.toLowerCase();
  const duration = normalized.match(/\b(?:in\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/);
  if (duration) {
    return `in ${duration[1]} ${duration[2]}`;
  }
  const atTime = normalized.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (atTime) {
    return `${atTime[1]}:${atTime[2] ?? "00"} ${atTime[3]}`;
  }
  const twentyFour = normalized.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  if (twentyFour) {
    return `${twentyFour[1]}:${twentyFour[2]}`;
  }
  return null;
}

function looksLikeWebsiteName(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^https?:\/\//i.test(trimmed) ||
    /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(trimmed) ||
    Boolean(WEBSITE_ALIASES[trimmed.toLowerCase()])
  );
}

const WEBSITE_ALIASES: Record<string, string> = {
  google: "google.com",
  youtube: "youtube.com",
  gmail: "mail.google.com",
  maps: "maps.google.com",
  reddit: "reddit.com",
  github: "github.com",
  amazon: "amazon.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  x: "x.com",
  twitter: "x.com"
};

function isWebsiteTarget(normalized: string, target: string): boolean {
  const trimmed = target.trim();
  return (
    Boolean(WEBSITE_ALIASES[normalized]) ||
    /^https?:\/\//i.test(trimmed) ||
    /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(trimmed)
  );
}

function isDirectAppLaunchTarget(normalized: string, target: string): boolean {
  if (/\.exe$/i.test(target.trim())) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target.trim()) && !/^https?:/i.test(target.trim())) {
    return true;
  }
  const stripped = normalized.replace(/^(the|my|a|an)\s+/, "").trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2) {
    return false;
  }
  const blocked = new Set([
    "pod",
    "bay",
    "doors",
    "source",
    "software",
    "file",
    "files",
    "folder",
    "document",
    "drive",
    "further",
    "window",
    "tab",
    "page",
    "link",
    "url"
  ]);
  if (words.some((word) => blocked.has(word))) {
    return false;
  }
  return /^[a-z0-9][a-z0-9\s.-]*$/i.test(stripped);
}
