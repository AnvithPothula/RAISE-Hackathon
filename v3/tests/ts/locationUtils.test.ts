import { describe, expect, it } from "vitest";
import { extractLocationFromPrompt } from "../../src/main/locationUtils.js";

describe("extractLocationFromPrompt", () => {
  it("resolves there to an earlier named place", () => {
    const prompt =
      "Search finding cool things to do in Albuquerque, then tell me the current weather there.";
    expect(extractLocationFromPrompt(prompt, "Eagan, Minnesota")).toBe("Albuquerque");
  });

  it("falls back to remembered location for there-only prompts", () => {
    expect(extractLocationFromPrompt("what is the weather there", "Eagan, Minnesota")).toBe("Eagan, Minnesota");
  });

  it("does not include trailing and-clauses in the location", () => {
    const prompt = "Find me fun things to do in Albuquerque and tell me the current weather there.";
    expect(extractLocationFromPrompt(prompt, "Eagan, Minnesota")).toBe("Albuquerque");
  });
});
