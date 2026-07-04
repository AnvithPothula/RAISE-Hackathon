import { describe, expect, it } from "vitest";
import { multiPartAnswerNudge, routeUserIntent } from "../../src/main/intentRouter.js";
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

  it("captures the demo memory beat verbatim", () => {
    const decision = routeUserIntent("Remember that my girlfriend's birthday is March 3rd");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({
      name: "memory",
      args: { action: "add", text: "my girlfriend's birthday is March 3rd" }
    });
  });

  it("routes memory listing instantly (no model, works offline)", () => {
    const decision = routeUserIntent("what do you remember");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "memory", args: { action: "list" } });
  });

  it("answers memory recall questions with zero tools so offline Gemma uses injected memory", () => {
    const decision = routeUserIntent("when is my girlfriend's birthday");
    expect(decision.invocation).toBeNull();
    expect(decision.llmToolScope).toBe("none");
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

  it("opens known home folders instantly instead of sending them to the model", () => {
    const decision = routeUserIntent("Open my downloads folder");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({
      name: "list_folder",
      args: { path: "downloads", action: "open" }
    });
  });

  it("opens nested folders described in plain language", () => {
    const decision = routeUserIntent("Open my GitHub folder, which is in my documents folder");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({
      name: "list_folder",
      args: { path: "Documents/GitHub", action: "open" }
    });
  });

  it("opens github folders instead of treating them as apps", () => {
    const decision = routeUserIntent("Open my GitHub folder");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({
      name: "list_folder",
      args: { path: "GitHub", action: "open" }
    });
  });

  it("opens icloud drive as a folder instead of an app", () => {
    const decision = routeUserIntent("Open my iCloud Drive");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation?.name).toBe("list_folder");
    expect(decision.invocation?.args.action).toBe("open");
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

  it("routes compound search-and-weather prompts through the LLM tool loop", () => {
    const prompt =
      "Search finding cool things to do in Albuquerque, then tell me the current weather there.";
    const decision = routeUserIntent(prompt, { knownLocation: "Eagan, Minnesota" });
    expect(decision.difficulty).toBe("simple");
    expect(decision.invocation).toBeNull();
    expect(decision.llmToolScope).toBe("standard");
    expect(decision.reason).toBe("multi-tool-loop");
  });

  it("routes find-activities-and-weather prompts through the LLM tool loop", () => {
    const prompt = "Find me fun things to do in Albuquerque and tell me the current weather there.";
    const decision = routeUserIntent(prompt, { knownLocation: "Eagan, Minnesota" });
    expect(decision.difficulty).toBe("simple");
    expect(decision.invocation).toBeNull();
    expect(decision.llmToolScope).toBe("standard");
    expect(decision.reason).toBe("multi-tool-loop");
  });

  it("still routes simple weather instantly", () => {
    const decision = routeUserIntent("find me the weather in Albuquerque");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation?.name).toBe("weather");
    expect(decision.invocation?.args).toEqual({ location: "Albuquerque" });
  });

  it("routes current-events-and-weather prompts through the LLM tool loop", () => {
    const prompt =
      "What are current things happening in Albuquerque, New Mexico? And also what is the current weather there?";
    const decision = routeUserIntent(prompt, { knownLocation: "Eagan, Minnesota" });
    expect(decision.difficulty).toBe("simple");
    expect(decision.invocation).toBeNull();
    expect(decision.llmToolScope).toBe("standard");
    expect(decision.reason).toBe("multi-tool-loop");
  });
});

describe("multiPartAnswerNudge", () => {
  it("nudges when only weather was answered for a compound request", () => {
    const prompt = "Find fun things to do in Albuquerque and also tell me the current weather there.";
    const answer = "The current weather in Albuquerque is 97 degrees Fahrenheit, with partly cloudy conditions.";
    const nudge = multiPartAnswerNudge(prompt, answer, ["get_weather", "web_search"]);
    expect(nudge).toMatch(/fun things to do/i);
    expect(nudge).toMatch(/web_search/i);
  });

  it("returns null when every part was covered", () => {
    const prompt = "Find fun things to do in Albuquerque and also tell me the current weather there.";
    const answer =
      "Try the Sandia Peak Tramway and Old Town for activities. It is 97 degrees and partly cloudy right now.";
    expect(multiPartAnswerNudge(prompt, answer, ["get_weather", "web_search"])).toBeNull();
  });

  it("nudges when only weather was answered for a current-events compound request", () => {
    const prompt =
      "What are current things happening in Albuquerque, New Mexico? And also what is the current weather there?";
    const answer =
      "Current weather in Albuquerque, New Mexico: partly cloudy, 97 degrees Fahrenheit, feels like 95.";
    const nudge = multiPartAnswerNudge(prompt, answer, ["get_weather"]);
    expect(nudge).toMatch(/current local events/i);
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
