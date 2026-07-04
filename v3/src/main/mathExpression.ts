const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  hundred: "100"
};

/** Turn spoken numbers into digits so "six plus seven" becomes 6+7. */
export function replaceNumberWords(value: string): string {
  let text = value.toLowerCase();
  const words = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length);
  for (const word of words) {
    text = text.replace(new RegExp(`\\b${word}\\b`, "g"), NUMBER_WORDS[word]);
  }
  return text;
}

export function normalizeMathExpression(value: string): string {
  return replaceNumberWords(value)
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .replace(/\btimes\b/gi, "*")
    .replace(/\bmultiplied by\b/gi, "*")
    .replace(/\bdivided by\b/gi, "/")
    .replace(/\bover\b/gi, "/")
    .replace(/\b(add|added to)\b/gi, "+")
    .replace(/\b(subtract|subtracted from)\b/gi, "-")
    .replace(/[×x]/gi, "*")
    .replace(/[÷]/g, "/")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

export function looksLikeMathExpression(value: string): boolean {
  return /^[\d+\-*/%.()]+$/.test(value) && /\d/.test(value) && /[+\-*/%]/.test(value);
}

/** Pull a math question out of natural phrasing like "what is 6+7" or "what is six plus seven". */
export function extractMathExpression(prompt: string): string | null {
  const clean = String(prompt ?? "").trim().replace(/[.!?]+$/g, "");
  const match = clean.match(/\b(?:what(?:'s| is)|how much is|calculate|compute|solve|evaluate)\s+(.+)$/i);
  if (match?.[1]) {
    const expression = normalizeMathExpression(match[1]);
    if (expression && looksLikeMathExpression(expression)) {
      return expression;
    }
  }
  if (/^[\d\s+\-*/%.()]+$/.test(clean) && /[\d]/.test(clean) && /[+\-*/%]/.test(clean)) {
    return normalizeMathExpression(clean);
  }
  return null;
}

export function looksLikeMathQuestion(normalized: string): boolean {
  return (
    /\b(plus|minus|times|multiplied|divided|add|subtract)\b/.test(normalized) ||
    /\d+\s*[+\-*/]\s*\d+/.test(normalized) ||
    /\bwhat(?:'s| is)\s+(?:\d|[a-z]+\s+(?:plus|minus|times|divided))/i.test(normalized)
  );
}
