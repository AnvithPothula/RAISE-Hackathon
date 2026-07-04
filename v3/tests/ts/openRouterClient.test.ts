import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/shared/types.js";
import {
  DEFAULT_OPENROUTER_MODEL,
  ensureOpenRouterReady,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
  useOpenRouter
} from "../../src/main/openRouterClient.js";

const baseConfig = (): AppConfig => ({
  ollama: { model: "gemma4:12b" },
  openrouter: {
    enabled: false,
    model: DEFAULT_OPENROUTER_MODEL,
    baseUrl: "https://openrouter.ai/api/v1"
  },
  pi: { enabled: false, command: "pi", args: [], cwd: "." },
  gui: { visualizer: "compact", showPerformanceStats: true, maxTranscriptItems: 50 }
});

describe("openRouterClient", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  it("defaults to the free Gemma 4 31B model", () => {
    expect(resolveOpenRouterModel(baseConfig())).toBe("google/gemma-4-31b-it:free");
  });

  it("reads the API key from env or user settings", () => {
    const cfg = baseConfig();
    cfg.openrouter!.apiKey = "user-key";
    expect(resolveOpenRouterApiKey(cfg)).toBe("user-key");

    process.env.OPENROUTER_API_KEY = "env-key";
    expect(resolveOpenRouterApiKey(cfg)).toBe("env-key");
  });

  it("uses OpenRouter only when enabled and a key is present", () => {
    const cfg = baseConfig();
    expect(useOpenRouter(cfg)).toBe(false);

    cfg.openrouter!.enabled = true;
    expect(useOpenRouter(cfg)).toBe(false);

    cfg.openrouter!.apiKey = "sk-test";
    expect(useOpenRouter(cfg)).toBe(true);
  });

  it("reports readiness based on enable flag and key", async () => {
    const cfg = baseConfig();
    expect((await ensureOpenRouterReady(cfg)).ready).toBe(false);

    cfg.openrouter!.enabled = true;
    expect((await ensureOpenRouterReady(cfg)).message).toMatch(/API key/i);

    cfg.openrouter!.apiKey = "sk-test";
    const ready = await ensureOpenRouterReady(cfg);
    expect(ready.ready).toBe(true);
    expect(ready.model).toBe("google/gemma-4-31b-it:free");
  });
});
