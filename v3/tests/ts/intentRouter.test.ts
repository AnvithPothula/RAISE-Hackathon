import { describe, expect, it } from "vitest";
import { routeUserIntent } from "../../src/main/intentRouter.js";

describe("routeUserIntent", () => {
  it("routes easy weather without the LLM", () => {
    const decision = routeUserIntent("How is the weather in Eagan, MN?");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "weather", args: { location: "Eagan, MN" } });
  });

  it("routes math instantly", () => {
    const decision = routeUserIntent("what is 12 * 8");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation?.name).toBe("calculator");
  });

  it("routes remember requests instantly", () => {
    const decision = routeUserIntent("remember that I prefer short answers");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation?.name).toBe("memory");
  });

  it("uses minimal tools for simple conversational prompts", () => {
    const decision = routeUserIntent("tell me something interesting about Minnesota");
    expect(decision.difficulty).toBe("simple");
    expect(decision.invocation).toBeNull();
    expect(decision.llmToolScope).toBe("minimal");
  });

  it("uses full tools for research prompts", () => {
    const decision = routeUserIntent("research and compare the best laptops under 1500 dollars");
    expect(decision.difficulty).toBe("complex");
    expect(decision.llmToolScope).toBe("full");
  });

  it("handles weather follow-ups with remembered location", () => {
    const decision = routeUserIntent("what about there", {
      previousToolName: "weather",
      knownLocation: "Eagan, Minnesota"
    });
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({
      name: "weather",
      args: { location: "Eagan, Minnesota" }
    });
  });
});
