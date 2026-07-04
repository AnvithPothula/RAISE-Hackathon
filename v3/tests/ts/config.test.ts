import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appRoot, readConfig, userSettingsPath, writeConfig } from "../../src/main/config";

const tmpSettings = path.join(os.tmpdir(), `pythos-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const configJson = path.join(appRoot, "config.json");

beforeEach(() => {
  process.env.PYTHOS_SETTINGS_PATH = tmpSettings;
  fs.rmSync(tmpSettings, { force: true });
});

afterEach(() => {
  fs.rmSync(tmpSettings, { force: true });
  delete process.env.PYTHOS_SETTINGS_PATH;
});

describe("per-user settings", () => {
  it("points the settings path outside the repo by default", () => {
    delete process.env.PYTHOS_SETTINGS_PATH;
    const resolved = userSettingsPath();
    expect(resolved.startsWith(appRoot)).toBe(false);
    expect(resolved.endsWith("user-settings.json")).toBe(true);
  });

  it("reads shared defaults when the user has no settings file yet", () => {
    expect(fs.existsSync(tmpSettings)).toBe(false);
    const cfg = readConfig();
    expect(cfg.ollama.model).toBeTruthy();
  });

  it("saves only the user's delta and never rewrites the shared config.json", () => {
    const configBefore = fs.readFileSync(configJson, "utf-8");
    const defaults = readConfig();

    const next = structuredClone(defaults);
    next.ollama.think = defaults.ollama.think === "high" ? "low" : "high";
    writeConfig(next);

    // Shared, committed config is untouched.
    expect(fs.readFileSync(configJson, "utf-8")).toBe(configBefore);

    // The per-user file holds ONLY the changed leaf, not the whole config.
    const saved = JSON.parse(fs.readFileSync(tmpSettings, "utf-8"));
    expect(saved).toEqual({ ollama: { think: next.ollama.think } });
  });

  it("merges the user's delta over defaults on the next read (survives restart)", () => {
    const defaults = readConfig();
    const next = structuredClone(defaults);
    next.python.lowResourceMode = !defaults.python.lowResourceMode;
    writeConfig(next);

    // A fresh read (as if the app restarted) reflects the user's choice…
    const reloaded = readConfig();
    expect(reloaded.python.lowResourceMode).toBe(next.python.lowResourceMode);
    // …while everything they did not change still comes from shared defaults.
    expect(reloaded.ollama.model).toBe(defaults.ollama.model);
  });
});
