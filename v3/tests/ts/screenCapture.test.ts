import { describe, expect, it } from "vitest";
import { formatScreenCaptureError } from "../../src/main/screenCapture.js";

describe("formatScreenCaptureError", () => {
  it("explains macOS screen recording permission failures", () => {
    const message = formatScreenCaptureError(new Error("Failed to get sources."));
    expect(message).toContain("Screen Recording");
    expect(message).not.toMatch(/^Tool failed:/i);
  });
});
