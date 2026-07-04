import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../shared/types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(dirname, "../..");

// config.json is the SHARED, committed defaults for the whole team. The app never
// writes it. Each user's personal changes are stored as a delta in their own OS
// user-data directory (below), so settings persist across restarts without ever
// clobbering the shared file or showing up in git.
const configPath = path.join(appRoot, "config.json");

loadEnvFile(path.join(appRoot, ".env"));

/** Per-user settings file location (outside the repo). Override with PYTHOS_SETTINGS_PATH. */
export function userSettingsPath(): string {
  const explicit = process.env.PYTHOS_SETTINGS_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const home = os.homedir();
  let base: string;
  if (process.platform === "win32") {
    base = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  }
  return path.join(base, "Pythos", "user-settings.json");
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively layer `override` onto `base`. Objects merge; arrays and scalars replace. */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = (base as Record<string, unknown>)[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

/** The part of `next` that differs from `base` (recursively). undefined when equal. */
function deepDiff(base: unknown, next: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(next)) {
    const diff: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      const sub = deepDiff((base as Record<string, unknown>)[key], value);
      if (sub !== undefined) {
        diff[key] = sub;
      }
    }
    return Object.keys(diff).length ? diff : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
}

function readDefaults(): RawConfig {
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as RawConfig;
}

function readUserOverrides(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(userSettingsPath(), "utf-8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // No per-user settings yet (or unreadable) — fall back to shared defaults.
    return {};
  }
}

export function readConfig(): RawConfig {
  const config = deepMerge(readDefaults(), readUserOverrides());

  if (process.env.PYTHOS_PI_COMMAND) {
    config.pi.command = process.env.PYTHOS_PI_COMMAND;
  }

  return config;
}

export function writeConfig(config: AppConfig): RawConfig {
  const nextConfig = structuredClone(config) as AppConfig;
  nextConfig.pi.args = nextConfig.pi.args.filter((arg) => arg !== "--no-tools");

  // Persist ONLY this user's delta from the shared defaults, in their own
  // user-data file. The committed config.json is never modified.
  const overrides = deepDiff(readDefaults(), nextConfig) ?? {};
  const target = userSettingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(overrides, null, 2)}\n`, "utf-8");

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

/** Shared spawn environment for Python worker subprocesses. */
export function workerPythonEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...caBundleEnv(),
    PYTHONPATH: path.join(appRoot, "src"),
    PYTHOS_CONFIG: path.join(appRoot, "config.json"),
    ...extra
  };
}
