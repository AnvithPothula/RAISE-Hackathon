export function sanitizeAssistantText(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/°\s*F/gi, " degrees Fahrenheit")
    .replace(/°\s*C/gi, " degrees Celsius")
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[\u200D\u20E3]/gu, "")
    .replace(/[^\u0009\u000A\u000D\u0020-\u007E\u00A0-\u024F]/gu, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\*+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

export function extractAssistantText(payload: Record<string, unknown>): string {
  const candidates = [payload.text, payload.content, payload.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.text === "string" && nested.text.trim()) {
        return nested.text;
      }
      if (typeof nested.content === "string" && nested.content.trim()) {
        return nested.content;
      }
    }
  }
  return "";
}

export function extractLastAssistantText(payload: Record<string, unknown>): string {
  const data = payload.data as Record<string, unknown> | undefined;
  const text = data?.text;
  return typeof text === "string" ? text.trim() : "";
}

export function extractPiError(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "";
  }
  const candidates = [payload.error, payload.errorMessage, payload.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.errorMessage === "string" && nested.errorMessage.trim()) {
        return nested.errorMessage;
      }
      if (typeof nested.error === "string" && nested.error.trim()) {
        return nested.error;
      }
    }
  }
  return "";
}

export function isUnsupportedToolModelError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("does not support tools") || normalized.includes("tools are not supported");
}
