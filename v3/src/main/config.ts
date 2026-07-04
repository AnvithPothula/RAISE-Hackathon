import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../shared/types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(dirname, "../..");
const configPath = path.join(appRoot, "config.json");

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
  if (process.env.PYTHOS_OLLAMA_MODEL) {
    config.ollama.model = process.env.PYTHOS_OLLAMA_MODEL;
  }

  return config;
}

export function writeConfig(config: AppConfig): RawConfig {
  const nextConfig = structuredClone(config) as AppConfig;
  nextConfig.pi.args = nextConfig.pi.args.filter((arg) => arg !== "--no-tools");
  const modelArgIndex = nextConfig.pi.args.findIndex((arg) => arg === "--model");
  if (modelArgIndex >= 0 && nextConfig.pi.args[modelArgIndex + 1]) {
    nextConfig.pi.args[modelArgIndex + 1] = `ollama/${nextConfig.ollama.model}`;
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
