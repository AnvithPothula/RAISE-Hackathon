export function isRetryPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  return /^(try again|retry|again|do it again|rerun|run it again|one more time|attempt it again)$/.test(normalized);
}
