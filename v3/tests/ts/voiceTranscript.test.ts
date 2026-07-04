import { describe, expect, it } from "vitest";
import {
  cleanAppTarget,
  normalizeVoiceTranscript,
  tryParseTextualToolCall,
  tryRecoverOpenedClaim
} from "../../src/main/voiceTranscript.js";
import { resolveDirectLocalTool } from "../../src/main/localTools.js";

describe("normalizeVoiceTranscript", () => {
  it("corrects common Discord mishearings on open commands", () => {
    expect(normalizeVoiceTranscript("Open up the storm")).toBe("Open up discord");
    expect(normalizeVoiceTranscript("Open disk cord")).toBe("Open discord");
    expect(normalizeVoiceTranscript("Launch the storm")).toBe("Launch discord");
  });

  it("splits glued open verbs from STT", () => {
    expect(normalizeVoiceTranscript("OpenUp Discord the App")).toBe("open up Discord the App");
    expect(normalizeVoiceTranscript("openup chrome")).toBe("open up chrome");
  });

  it("recovers truncated open-app fragments", () => {
    expect(normalizeVoiceTranscript("up the storm.")).toBe("open up discord");
    expect(normalizeVoiceTranscript("discord the app")).toBe("open discord");
    expect(normalizeVoiceTranscript("the storm")).toBe("open discord");
  });

  it("leaves unrelated prompts unchanged", () => {
    expect(normalizeVoiceTranscript("What's the weather?")).toBe("What's the weather?");
    expect(normalizeVoiceTranscript("Tell me about storms")).toBe("Tell me about storms");
  });
});

describe("cleanAppTarget", () => {
  it("strips trailing app filler from voice phrasing", () => {
    expect(cleanAppTarget("Discord the app")).toBe("Discord");
    expect(cleanAppTarget("Discord the application")).toBe("Discord");
    expect(cleanAppTarget("chrome app")).toBe("chrome");
    expect(cleanAppTarget("the Discord")).toBe("Discord");
  });
});

describe("tryParseTextualToolCall", () => {
  it("parses textual open_app responses from the local model", () => {
    expect(tryParseTextualToolCall('open_app(app="Discord")')).toEqual({
      name: "open_app",
      args: { app: "Discord" }
    });
    expect(tryParseTextualToolCall('open_app("Chrome")')).toEqual({
      name: "open_app",
      args: { app: "Chrome" }
    });
  });
});

describe("voice open-app routing", () => {
  it("opens Discord after STT correction", () => {
    expect(resolveDirectLocalTool(normalizeVoiceTranscript("Open up the storm"))).toEqual({
      name: "open_app",
      args: { app: "Discord" }
    });
  });

  it("opens Discord from glued OpenUp phrasing", () => {
    expect(resolveDirectLocalTool(normalizeVoiceTranscript("OpenUp Discord the App"))).toEqual({
      name: "open_app",
      args: { app: "Discord" }
    });
  });

  it("opens Discord from truncated up-the-storm fragment", () => {
    expect(resolveDirectLocalTool(normalizeVoiceTranscript("up the storm."))).toEqual({
      name: "open_app",
      args: { app: "Discord" }
    });
  });

  it("opens Discord when user says 'the app' after the name", () => {
    expect(resolveDirectLocalTool("Open Discord the app")).toEqual({
      name: "open_app",
      args: { app: "Discord" }
    });
  });

  it("opens the GitHub website from casual phrasing", () => {
    expect(resolveDirectLocalTool(normalizeVoiceTranscript("Yo, open up GitHub."))).toEqual({
      name: "open_website",
      args: { url: "GitHub" }
    });
  });

  it("opens GitHub Desktop when the user asks for the app", () => {
    expect(resolveDirectLocalTool("Open GitHub desktop app")).toEqual({
      name: "open_app",
      args: { app: "GitHub Desktop" }
    });
  });
});

describe("tryRecoverOpenedClaim", () => {
  it("recovers a hallucinated opened claim as a website open for known sites", () => {
    expect(tryRecoverOpenedClaim("Opened GitHub.", "Yo, open up GitHub.")).toEqual({
      name: "open_website",
      args: { url: "github.com" }
    });
  });
});
