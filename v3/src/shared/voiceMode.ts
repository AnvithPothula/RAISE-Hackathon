import type { VoiceModePayload } from "./types.js";

/** Renderable summary of the live voice mode for the demo HUD. */
export type VoiceModeSummary = {
  /** Short badge text, e.g. "Voice: Local (offline)". */
  label: string;
  /** Longer tooltip/detail text naming the concrete engines. */
  detail: string;
  /** Visual tone for the badge. */
  tone: "cloud" | "local" | "degraded";
};

const TTS_ENGINE_NAMES: Record<VoiceModePayload["tts"], string> = {
  gradium: "Gradium studio voice",
  piper: "Piper (on-device)",
  system: "system voice (on-device)",
  unavailable: "no speech output"
};

const STT_ENGINE_NAMES: Record<VoiceModePayload["stt"], string> = {
  gradium: "Gradium streaming STT",
  vosk: "Vosk (on-device)",
  unavailable: "no speech input"
};

/**
 * Human-readable description of the current voice pipeline mode.
 *
 * The wording is demo-facing: judges should be able to read the state of the
 * hybrid voice stack at a glance while the brain badge separately asserts
 * that inference is always on-device.
 */
export function describeVoiceMode(mode: VoiceModePayload | null): VoiceModeSummary {
  if (!mode) {
    return {
      label: "Voice: starting…",
      detail: "The audio worker has not reported a voice mode yet.",
      tone: "local"
    };
  }

  if (mode.engine === "gradium") {
    return {
      label: "Voice: Gradium (cloud)",
      detail: "Streaming Gradium voice; falls back to the local engines the moment the network drops.",
      tone: "cloud"
    };
  }

  const sttName = STT_ENGINE_NAMES[mode.stt];
  const ttsName = TTS_ENGINE_NAMES[mode.tts];
  const textOnly = mode.stt === "unavailable" && mode.tts === "unavailable";
  if (textOnly) {
    return {
      label: "Voice: text only",
      detail:
        "No offline voice engines are installed (run scripts/install-vosk-model to add offline speech recognition). " +
        "Typed chat and the local Gemma brain still work fully offline.",
      tone: "degraded"
    };
  }

  const label = mode.online ? "Voice: Local (on-device)" : "Voice: Local (offline)";
  return {
    label,
    detail: `Speech in: ${sttName}. Speech out: ${ttsName}. The Gemma brain never left the machine.`,
    tone: "local"
  };
}

/** One-line performance readout for the HUD: tok/s, TTFT, and token count. */
export function formatPerfLine(stats: {
  tokensPerSecond: number;
  ttftSeconds: number;
  evalCount: number;
  model: string;
  toolScope?: string;
}): string {
  const parts: string[] = [];
  if (stats.tokensPerSecond > 0) {
    parts.push(`${stats.tokensPerSecond} tok/s`);
  }
  if (stats.ttftSeconds > 0) {
    parts.push(`TTFT ${stats.ttftSeconds}s`);
  }
  if (stats.evalCount > 0) {
    parts.push(`${stats.evalCount} tok`);
  }
  parts.push(stats.model);
  if (stats.toolScope) {
    parts.push(`tools:${stats.toolScope}`);
  }
  return parts.join(" · ");
}
