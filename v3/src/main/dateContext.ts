/** Human-readable current local date/time for model and tool context. */
export function formatCurrentDateTime(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(now));
}

/** Injected into every LLM turn so the model always knows "now". */
export function currentDateTimeContext(now = Date.now()): string {
  return (
    `Current local date and time: ${formatCurrentDateTime(now)}. ` +
    "Use this for alarms, scheduling, and relative phrases like today, tomorrow, or tonight. " +
    "Never ask the user for today's date or time."
  );
}

/** Normalize spoken alarm time text before parsing or routing. */
export function normalizeAlarmTimePhrase(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\ba\s*\.\s*m\.?\b/g, " am")
    .replace(/\bp\s*\.\s*m\.?\b/g, " pm")
    .replace(/[^\w\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
