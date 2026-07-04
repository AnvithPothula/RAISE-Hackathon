export function cleanLocation(value: string): string | null {
  let location = value
    .replace(/\s+\b(?:and|or|plus|but)\b(?:\s+(?:also|then))?\s+(?:tell|show|give|get|check|let)\b.*$/i, "")
    .replace(/\s+\b(?:and|or|plus|but)\b.*$/i, "")
    .replace(/\b(today|right now|currently|now|please|thanks|thank you)\b/gi, "")
    .replace(/[?.!]+$/g, "")
    .trim();
  return location.length >= 3 ? location : null;
}

const LOCATION_TAIL =
  /(?=\s*[,;]|\s+then\b|\s+and\b|\s+or\b|\s+plus\b|\s+but\b|\s+and\s+also\b|\s+before\b|\s+after\b|\s+while\b|[?.!]|$)/i;

/**
 * Pull a place name from the user's words. Handles compound requests ("search … in
 * Albuquerque, then weather there") by preferring an explicit place over pronouns and
 * the remembered default location.
 */
export function extractLocationFromPrompt(prompt: string, knownLocation?: string | null): string | null {
  const embedded = prompt.match(
    /\b(?:weather|forecast|temperature|temp|time|date)\b[^?.!]*\b(?:in|for|near|at)\s+([a-zA-Z][a-zA-Z\s,.-]{2,})/i
  );
  if (embedded) {
    const place = cleanLocation(embedded[1]);
    if (place) {
      return place;
    }
  }

  const inlineMatches = [
    ...prompt.matchAll(
      new RegExp(`\\b(?:in|for|near|at)\\s+([a-zA-Z][a-zA-Z\\s,.-]{2,}?)${LOCATION_TAIL.source}`, "gi")
    )
  ];
  const inlinePlaces = inlineMatches
    .map((match) => cleanLocation(match[1]))
    .filter((place): place is string => Boolean(place));
  if (inlinePlaces.length) {
    if (/\b(there|that place|that city|same place)\b/i.test(prompt)) {
      return inlinePlaces[inlinePlaces.length - 1];
    }
    return inlinePlaces[0];
  }

  const trailing = prompt.match(/\b(?:in|for|near|at)\s+([a-zA-Z][a-zA-Z\s,.-]{2,})(?:[?.!]+)?$/i);
  if (trailing) {
    const place = cleanLocation(trailing[1]);
    if (place) {
      return place;
    }
  }

  if (/\b(there|that place|that city|same place|here)\b/i.test(prompt) && knownLocation) {
    return knownLocation;
  }

  return null;
}
