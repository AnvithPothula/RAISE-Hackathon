import { describe, expect, it } from "vitest";
import {
  extractMathExpression,
  looksLikeMathExpression,
  normalizeMathExpression
} from "../../src/main/mathExpression.js";
import { routeUserIntent } from "../../src/main/intentRouter.js";
import { garbledTranscriptHint } from "../../src/main/voiceTranscript.js";
import { resolveDirectLocalTool } from "../../src/main/localTools.js";

describe("mathExpression", () => {
  it("parses digit expressions", () => {
    expect(extractMathExpression("what is 6+7")).toBe("6+7");
    expect(extractMathExpression("What is 12 * 8?")).toBe("12*8");
  });

  it("parses spoken number expressions", () => {
    expect(extractMathExpression("What is six plus seven?")).toBe("6+7");
    expect(normalizeMathExpression("twelve times three")).toBe("12*3");
    expect(looksLikeMathExpression("6+7")).toBe(true);
  });
});

describe("routeUserIntent math", () => {
  it("routes spoken math instantly", () => {
    const decision = routeUserIntent("What is six plus seven?");
    expect(decision.difficulty).toBe("instant");
    expect(decision.invocation).toEqual({ name: "calculator", args: { expression: "6+7" } });
  });
});

describe("garbledTranscriptHint", () => {
  it("detects likely STT mishears", () => {
    expect(garbledTranscriptHint("Otra exposición.")).toMatch(/didn't catch that/i);
  });

  it("ignores real English questions", () => {
    expect(garbledTranscriptHint("What is six plus seven?")).toBeNull();
  });
});

describe("spoken math routing", () => {
  it("answers six plus seven via calculator without the LLM", () => {
    expect(resolveDirectLocalTool("What is six plus seven?")).toEqual({
      name: "calculator",
      args: { expression: "6+7" }
    });
  });
});
