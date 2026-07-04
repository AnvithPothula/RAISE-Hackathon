/**
 * Normalize voice transcripts before intent routing.
 * Fixes common Gradium STT mishearings and strips filler from app names.
 */

import type { LocalToolInvocation } from "./localTools.js";
import { websiteAliasForName } from "./localTools.js";

const OPEN_VERB =
  /^(?:please\s+)?(?:open\s+up|openup|open|launch|start|pull\s+up|bring\s+up|fire\s+up)\b/i;

/** Common open-app mishearings heard in live demos (whole-phrase replacements). */
const OPEN_APP_PHRASE_FIXES: Array<[RegExp, string]> = [
  [/\bthe storm\b/gi, "discord"],
  [/\b(?:disk|this|dis)\s+cord\b/gi, "discord"],
  [/\bopen\s+(?:up\s+)?(?:the\s+)?storm\b/gi, "open discord"],
  [/\blaunch\s+(?:the\s+)?storm\b/gi, "launch discord"],
  [/\bgoogle\s+crome\b/gi, "google chrome"]
];

/** Folder open mishearings from voice input. */
const OPEN_FOLDER_PHRASE_FIXES: Array<[RegExp, string]> = [
  [/^es\s+open\b/i, "open"],
  [/\bopen\s+(?:the\s+)?documents\s+further\b/gi, "open my documents folder"],
  [/\bopen\s+(?:the\s+)?downloads\s+further\b/gi, "open my downloads folder"],
  [/\b(documents|downloads|desktop|pictures|photos|music|movies)\s+further\b/gi, "$1 folder"]
];

/** Alarm command mishearings (Gradium often garbles "set an alarm"). */
const ALARM_PHRASE_FIXES: Array<[RegExp, string]> = [
  [/\bsignal\s+(?:an?\s+)?alarm\b/gi, "set an alarm"],
  [/\b(?:a\s+)?sudden\s+(?:an?\s+)?alarm\b/gi, "set an alarm"],
  [/\bset\s+in\s+(?:an?\s+)?alarm\b/gi, "set an alarm"],
  [/\bs(?:at|et)\s+in\s+(?:an?\s+)?alarm\b/gi, "set an alarm"],
  [/\bthat\s+in\s+alarm\b/gi, "set an alarm"]
];

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "").trim();
}

/** STT often glues words: "OpenUp" → "Open up". */
function splitGluedOpenVerbs(text: string): string {
  return text
    .replace(/\bopenup\b/gi, "open up")
    .replace(/\bpullup\b/gi, "pull up")
    .replace(/\bbringup\b/gi, "bring up")
    .replace(/\bfireup\b/gi, "fire up");
}

/**
 * Recover truncated open-app phrases when the wake word eats the first word
 * or VAD cuts the start of the utterance ("up the storm" = "open up discord").
 */
function expandOpenFragments(text: string): string {
  const trimmed = stripTrailingPunctuation(text);
  const lower = trimmed.toLowerCase();

  if (/^up\s+(?:the\s+)?storm$/i.test(lower)) {
    return "open up discord";
  }
  if (/^(?:the\s+)?storm(?:\s+app)?$/i.test(lower)) {
    return "open discord";
  }
  if (/^(?:the\s+)?(?:disk|dis)\s+cord(?:\s+(?:the\s+)?app)?$/i.test(lower)) {
    return "open discord";
  }
  if (/^discord(?:\s+the\s+app)?$/i.test(lower)) {
    return "open discord";
  }
  if (/^openup\b/i.test(trimmed)) {
    return splitGluedOpenVerbs(trimmed);
  }
  return text;
}

/**
 * Fix obvious STT errors on open-app commands before routing.
 * Safe to run on typed input too — only rewrites known mishearings.
 */
export function normalizeVoiceTranscript(text: string): string {
  let normalized = stripConversationalPrefix(String(text ?? "").trim());
  if (!normalized) {
    return normalized;
  }

  normalized = splitGluedOpenVerbs(normalized);
  normalized = expandOpenFragments(normalized);

  for (const [pattern, replacement] of ALARM_PHRASE_FIXES) {
    normalized = normalized.replace(pattern, replacement);
  }

  if (OPEN_VERB.test(normalized) || /\b(?:open|launch|start|pull up|bring up|fire up|openup)\b/i.test(normalized)) {
    for (const [pattern, replacement] of OPEN_FOLDER_PHRASE_FIXES) {
      normalized = normalized.replace(pattern, replacement);
    }
    for (const [pattern, replacement] of OPEN_APP_PHRASE_FIXES) {
      normalized = normalized.replace(pattern, replacement);
    }
  }
  return normalized;
}

/** Drop casual lead-ins so "Yo, open GitHub" still routes instantly. */
export function stripConversationalPrefix(text: string): string {
  return text
    .replace(/^(?:yo+|hey+|hi+|hello+|ok(?:ay)?|so|well|um+|uh+|ah+|listen)\s*[,!.\s-]+/i, "")
    .trim();
}

/**
 * Strip open-intent filler from an app or website target.
 * Handles voice phrasing like "Discord the app" → "Discord".
 */
export function cleanAppTarget(value: string): string {
  let cleaned = String(value ?? "").trim();
  for (let pass = 0; pass < 5; pass += 1) {
    const next = cleaned
      .replace(/^(openup|open\s+up|open|launch|start|go to|visit|browse to|pull up|bring up|fire up)\s+/i, "")
      .replace(/^(up|the|my|a|an)\s+/i, "")
      .replace(/\s+(for me|please|thanks|thank you)$/i, "")
      .replace(/\s+(the\s+)?(website|site|webpage|app|application|program)$/i, "")
      .replace(/\s+the$/i, "")
      .trim();
    if (next === cleaned) {
      break;
    }
    cleaned = next;
  }
  return cleaned;
}

/** When the model claims it opened something without calling a tool, recover and run it. */
export function tryRecoverOpenedClaim(text: string, prompt: string): LocalToolInvocation | null {
  const claim = stripTrailingPunctuation(String(text ?? "").trim()).match(/^opened\s+(.+)$/i);
  if (!claim) {
    return null;
  }
  if (!/\b(?:openup|open|launch|start|pull up|bring up|fire up)\b/i.test(prompt)) {
    return null;
  }
  const target = cleanAppTarget(claim[1]);
  if (!target) {
    return null;
  }
  const site = websiteAliasForName(target);
  if (site) {
    return { name: "open_website", args: { url: site } };
  }
  return { name: "open_app", args: { app: target } };
}

/** Short, likely-misheard transcripts — respond instantly instead of asking Gemma to guess. */
export function garbledTranscriptHint(prompt: string): string | null {
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed || trimmed.length > 48) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (
    /\b(what|why|how|when|where|who|open|launch|play|weather|time|remember|help|please|can you|pythos|skip|pause|stop|next)\b/.test(
      lower
    )
  ) {
    return null;
  }
  if (/[\d+\-*/=]/.test(trimmed)) {
    return null;
  }
  // Non-English characters in a short phrase usually mean STT misheard the user.
  if (/[^\u0000-\u007F]/.test(trimmed)) {
    return "I didn't catch that. Try again, for example: What is six plus seven?";
  }
  return null;
}

/** When the local model prints tool syntax as plain text, recover and run it. */
export function tryParseTextualToolCall(text: string): LocalToolInvocation | null {
  const trimmed = stripTrailingPunctuation(String(text ?? "").trim());
  if (!trimmed) {
    return null;
  }

  const positional = trimmed.match(/^open_app\s*\(\s*["']([^"']+)["']\s*\)$/i);
  if (positional) {
    return { name: "open_app", args: { app: positional[1] } };
  }

  const named = trimmed.match(/^open_app\s*\(\s*app\s*=\s*["']([^"']+)["']\s*\)$/i);
  if (named) {
    return { name: "open_app", args: { app: named[1] } };
  }

  const jsonArgs = trimmed.match(/^open_app\s*\(\s*(\{[\s\S]*\})\s*\)$/i);
  if (jsonArgs) {
    try {
      const parsed = JSON.parse(jsonArgs[1]) as { app?: string; query?: string };
      const app = parsed.app ?? parsed.query;
      if (app) {
        return { name: "open_app", args: { app } };
      }
    } catch {
      return null;
    }
  }

  return null;
}
