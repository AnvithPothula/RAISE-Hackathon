import { describe, expect, it } from "vitest";
import { isRetryPrompt } from "../../src/main/toolRetry";

describe("isRetryPrompt", () => {
  it("matches short retry requests", () => {
    expect(isRetryPrompt("try again")).toBe(true);
    expect(isRetryPrompt("Retry!")).toBe(true);
    expect(isRetryPrompt("run it again")).toBe(true);
  });

  it("does not match unrelated prompts containing again", () => {
    expect(isRetryPrompt("play prom queen again")).toBe(false);
    expect(isRetryPrompt("search again for spotify setup")).toBe(false);
  });
});
