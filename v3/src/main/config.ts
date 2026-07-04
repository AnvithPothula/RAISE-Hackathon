import { execFileSync } from "node:child_process";
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

  return config;
}

export function writeConfig(config: AppConfig): RawConfig {
  const nextConfig = structuredClone(config) as AppConfig;
  nextConfig.pi.args = nextConfig.pi.args.filter((arg) => arg !== "--no-tools");
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
  return readConfig();
}

export function resolveWorkerPython(): string {
  const venvPython =
    process.platform === "win32"
      ? path.join(appRoot, ".venv", "Scripts", "python.exe")
      : path.join(appRoot, ".venv", "bin", "python");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

let cachedCaBundle: string | null | undefined;

/**
 * Absolute path to certifi's CA bundle, or null if unavailable.
 *
 * macOS Python.framework builds ship without a usable system CA store, so the
 * Python worker's TLS handshake to api.gradium.ai fails with
 * CERTIFICATE_VERIFY_FAILED. Exposing this bundle as SSL_CERT_FILE in the
 * worker's spawn env fixes it. Resolved once via the venv Python and cached.
 */
export function resolveCaBundle(): string | null {
  if (cachedCaBundle !== undefined) {
    return cachedCaBundle;
  }
  try {
    const output = execFileSync(
      resolveWorkerPython(),
      ["-c", "import certifi,sys;sys.stdout.write(certifi.where())"],
      { encoding: "utf-8", timeout: 10_000 }
    ).trim();
    cachedCaBundle = output.length > 0 ? output : null;
  } catch {
    cachedCaBundle = null;
  }
  return cachedCaBundle;
}

/** Spawn env additions that make the Python worker's TLS trust certifi's CA bundle. */
export function caBundleEnv(): Record<string, string> {
  if (process.env.SSL_CERT_FILE) {
    return {}; // respect an explicit override (e.g. from .env)
  }
  const bundle = resolveCaBundle();
  return bundle ? { SSL_CERT_FILE: bundle } : {};
}
