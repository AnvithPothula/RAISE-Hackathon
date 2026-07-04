import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../shared/types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(dirname, "../..");
const configPath = path.join(appRoot, "config.json");

loadEnvFile(path.join(appRoot, ".env"));

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    return;
  }
  try {
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // A malformed .env file must not crash startup; environment variables still apply.
  }
}

type RawConfig = AppConfig & {
  python: { workerModule: string; lowResourceMode: boolean };
  models: Record<string, string>;
  audio: Record<string, unknown>;
};

export function readConfig(): RawConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as RawConfig;

  if (process.env.PYTHOS_PI_COMMAND) {
    config.pi.command = process.env.PYTHOS_PI_COMMAND;
  }
  if (process.env.PYTHOS_GEMINI_MODEL) {
    config.gemini.model = process.env.PYTHOS_GEMINI_MODEL;
  }

  return config;
}

export function writeConfig(config: AppConfig): RawConfig {
  const nextConfig = structuredClone(config) as AppConfig;
  nextConfig.pi.args = nextConfig.pi.args.filter((arg) => arg !== "--no-tools");
  const modelArgIndex = nextConfig.pi.args.findIndex((arg) => arg === "--model");
  if (modelArgIndex >= 0 && nextConfig.pi.args[modelArgIndex + 1]) {
    nextConfig.pi.args[modelArgIndex + 1] = `gemini/${nextConfig.gemini.model}`;
  }
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
  return readConfig();
}

export function resolveWorkerPython(): string {
  const venvPython = path.join(appRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return "python";
}
