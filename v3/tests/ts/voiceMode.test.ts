import { describe, expect, it } from "vitest";
import { describeVoiceMode, formatPerfLine } from "../../src/shared/voiceMode.js";
import type { VoiceModePayload } from "../../src/shared/types.js";

function mode(overrides: Partial<VoiceModePayload> = {}): VoiceModePayload {
  return {
    engine: "gradium",
    online: true,
    gradiumConfigured: true,
    stt: "gradium",
    tts: "gradium",
    reason: "test",
    ...overrides
  };
}

describe("describeVoiceMode", () => {
  it("reports the cloud voice when Gradium is serving", () => {
    const summary = describeVoiceMode(mode());
    expect(summary.label).toBe("Voice: Gradium (cloud)");
    expect(summary.tone).toBe("cloud");
  });

  it("reports local offline voice after a network drop", () => {
    const summary = describeVoiceMode(
      mode({ engine: "local", online: false, stt: "vosk", tts: "piper" })
    );
    expect(summary.label).toBe("Voice: Local (offline)");
    expect(summary.tone).toBe("local");
    expect(summary.detail).toContain("Vosk");
    expect(summary.detail).toContain("Piper");
  });

  it("reports local on-device voice when there is no API key but the network is up", () => {
    const summary = describeVoiceMode(
      mode({ engine: "local", online: true, gradiumConfigured: false, stt: "vosk", tts: "system" })
    );
    expect(summary.label).toBe("Voice: Local (on-device)");
    expect(summary.tone).toBe("local");
  });

  it("degrades to text-only when no offline engines are installed", () => {
    const summary = describeVoiceMode(
      mode({ engine: "local", online: false, stt: "unavailable", tts: "unavailable" })
    );
    expect(summary.label).toBe("Voice: text only");
    expect(summary.tone).toBe("degraded");
    expect(summary.detail).toContain("install-vosk-model");
  });

  it("shows a startup placeholder before the worker reports", () => {
    const summary = describeVoiceMode(null);
    expect(summary.label).toContain("starting");
  });
});

describe("formatPerfLine", () => {
  it("renders tok/s, TTFT, token count, model, and tool scope", () => {
    const line = formatPerfLine({
      tokensPerSecond: 48.2,
      ttftSeconds: 0.54,
      evalCount: 128,
      model: "gemma4:e2b",
      toolScope: "none"
    });
    expect(line).toBe("48.2 tok/s · TTFT 0.54s · 128 tok · gemma4:e2b · tools:none");
  });

  it("omits zeroed metrics but always names the model", () => {
    const line = formatPerfLine({
      tokensPerSecond: 0,
      ttftSeconds: 0,
      evalCount: 0,
      model: "gemma4:12b"
    });
    expect(line).toBe("gemma4:12b");
  });
});
