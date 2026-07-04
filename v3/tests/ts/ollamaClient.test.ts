import { describe, expect, it } from "vitest";
import { decideThinking } from "../../src/main/ollamaClient.js";
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
