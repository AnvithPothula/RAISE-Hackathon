import { describe, expect, it } from "vitest";
import { routeUserIntent } from "../../src/main/intentRouter.js";
import { buildFunctionDeclarations } from "../../src/main/toolRuntime.js";

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

  it("uses no tools for general-knowledge chat", () => {
    const decision = routeUserIntent("tell me something interesting about Minnesota");
    expect(decision.difficulty).toBe("simple");
    expect(decision.invocation).toBeNull();
    expect(decision.llmToolScope).toBe("none");
  });

  it("uses no tools for factual history questions", () => {
    const decision = routeUserIntent("why do we celebrate the 4th of July");
    expect(decision.difficulty).toBe("simple");
    expect(decision.llmToolScope).toBe("none");
    expect(decision.invocation).toBeNull();
  });

  it("routes play requests instantly to Spotify", () => {
    const decision = routeUserIntent("Play something relaxing");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({
      name: "spotify",
      args: { action: "play", kind: "track", query: "something relaxing" }
    });
  });

  it("routes folder listing instantly", () => {
    const decision = routeUserIntent("What is in my download folder?");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "list_folder", args: { path: "download" } });
  });

  it("routes open app requests instantly", () => {
    const decision = routeUserIntent("Open Microsoft Paint");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "open_app", args: { app: "Microsoft Paint" } });
  });

  it("routes tabroom open requests instantly", () => {
    const decision = routeUserIntent("open Tabroom");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "open_app", args: { app: "Tabroom" } });
  });

  it("routes conversational open app requests instantly", () => {
    const decision = routeUserIntent("can you open spotify for me");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "open_app", args: { app: "spotify" } });
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

describe("buildFunctionDeclarations tool scopes", () => {
  it("returns zero declarations for none scope", () => {
    expect(buildFunctionDeclarations("none")).toEqual([]);
  });

  it("returns a trimmed set for minimal scope", () => {
    const names = buildFunctionDeclarations("minimal").map((tool) => tool.name);
    expect(names).toContain("get_weather");
    expect(names).not.toContain("deep_research");
  });
});
