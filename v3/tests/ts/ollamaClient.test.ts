import { describe, expect, it } from "vitest";
import { clampRounds, decideThinking, parseResearchPlan } from "../../src/main/ollamaClient.js";
import { buildFunctionDeclarations } from "../../src/main/toolRuntime.js";

describe("decideThinking", () => {
  it("uses fast path for simple operational requests", () => {
    const result = decideThinking("What's the weather in Boston?", "auto");
    expect(result.think).toBe(false);
    expect(result.reason).toContain("fast path");
  });

  it("enables thinking for research-style prompts", () => {
    const result = decideThinking("Research the best laptops under $1500 and compare them", "auto");
    expect(result.think).toBe(true);
  });

  it("enables thinking for coding prompts", () => {
    const result = decideThinking("Write code to sort a list of dates", "auto");
    expect(result.think).toBe(true);
  });

  it("respects pinned-on mode", () => {
    expect(decideThinking("hello", "on").think).toBe(true);
  });

  it("respects pinned-off mode", () => {
    expect(decideThinking("explain quantum entanglement step by step", "off").think).toBe(false);
  });
});

describe("buildFunctionDeclarations", () => {
  it("includes core agentic tools", () => {
    const names = buildFunctionDeclarations().map((tool) => tool.name);
    expect(names).toContain("deep_research");
    expect(names).toContain("run_code");
    expect(names).toContain("run_sub_agent");
  });
});

describe("clampRounds", () => {
  it("keeps a sensible self-chosen budget unchanged", () => {
    expect(clampRounds(5)).toBe(5);
  });

  it("clamps an over-eager budget down to the max", () => {
    expect(clampRounds(50)).toBe(8);
  });

  it("clamps a too-small budget up to the min", () => {
    expect(clampRounds(1)).toBe(2);
  });

  it("falls back to the default for missing or invalid values", () => {
    expect(clampRounds(undefined)).toBe(4);
    expect(clampRounds(Number.NaN)).toBe(4);
  });

  it("rounds fractional budgets", () => {
    expect(clampRounds(3.6)).toBe(4);
  });
});

describe("parseResearchPlan", () => {
  it("parses a clean JSON budget", () => {
    expect(parseResearchPlan('{"rounds": 6, "plan": "compare options"}')).toEqual({
      rounds: 6,
      plan: "compare options"
    });
  });

  it("extracts JSON embedded in surrounding prose or fences", () => {
    const parsed = parseResearchPlan('Here is my plan:\n```json\n{"rounds": 3, "plan": "search"}\n```');
    expect(parsed?.rounds).toBe(3);
    expect(parsed?.plan).toBe("search");
  });

  it("returns null when no JSON object is present", () => {
    expect(parseResearchPlan("I will just answer directly.")).toBeNull();
  });

  it("coerces a stringified rounds value to a number", () => {
    expect(parseResearchPlan('{"rounds": "5"}')?.rounds).toBe(5);
  });
});
