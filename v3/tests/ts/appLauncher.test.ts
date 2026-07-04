import { describe, expect, it } from "vitest";
import { formatMacOpenFailure } from "../../src/main/appLauncher.js";

describe("formatMacOpenFailure", () => {
  it("explains when macOS cannot find the application", () => {
    const message = formatMacOpenFailure("Tabroom", "Unable to find application named Tabroom");
    expect(message).toContain("Tabroom");
    expect(message).toContain("not installed");
    expect(message).not.toMatch(/^Opened /i);
  });

  it("falls back to a generic unavailable message", () => {
    const message = formatMacOpenFailure("ExampleApp", "");
    expect(message).toContain("unavailable");
    expect(message).toContain("couldn't open");
  });
});
