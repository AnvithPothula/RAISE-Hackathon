export type Logger = (message: string) => void;

export function createLogger(scope: string): Logger {
  return (message: string) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.error(`[pythos-main ${timestamp}] ${scope} ${message}`);
  };
}

export function truncateDebugValue(value: string | undefined, maxLength = 240): string {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function formatDebugFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(" ");
}

function formatDebugValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${truncateDebugValue(value)}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateDebugValue(JSON.stringify(value));
}

export function compactDebugDetails(details: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    compact[key] = typeof value === "string" ? truncateDebugValue(value, 260) : value;
  }
  return compact;
}
