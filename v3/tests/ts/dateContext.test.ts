import { describe, expect, it } from "vitest";
import { currentDateTimeContext, formatCurrentDateTime, normalizeAlarmTimePhrase } from "../../src/main/dateContext.js";

describe("dateContext", () => {
  it("formats a stable current date/time string", () => {
    const text = formatCurrentDateTime(Date.parse("2026-07-04T16:22:00-05:00"));
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/4:22/);
  });

  it("tells the model never to ask for today's date", () => {
    expect(currentDateTimeContext(Date.parse("2026-07-04T16:22:00-05:00"))).toMatch(/Never ask the user for today's date/i);
  });

  it("normalizes dotted a m and p m", () => {
    expect(normalizeAlarmTimePhrase("5 A.M. tomorrow")).toBe("5 am tomorrow");
  });
});
