import { spawn } from "node:child_process";
import type { AppConfig } from "../shared/types.js";
import { isOllamaReady, resolveActiveModel } from "./ollamaClient.js";

const STARTUP_WAIT_MS = 45000;
const POLL_MS = 500;

/** Spawn `ollama serve` in the background when the daemon is not reachable. */
function spawnOllamaServe(): void {
  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type OllamaEnsureResult = {
  ready: boolean;
  model: string;
  message: string;
};

/**
 * Ensure the local Ollama daemon is running and the configured Gemma model is
 * pulled. Called once at app startup (plan P0 #5). Non-fatal: the app still
 * launches if Ollama is missing; the user gets a clear error on first prompt.
 */
export async function ensureOllamaReady(config: AppConfig): Promise<OllamaEnsureResult> {
  const model = resolveActiveModel(config);
  if (await isOllamaReady(config)) {
    return { ready: true, model, message: `Local Gemma ready (${model}).` };
  }

  try {
    spawnOllamaServe();
  } catch (error) {
    return {
      ready: false,
      model,
      message: `Ollama is not installed or could not be started. Install from https://ollama.com and run: ollama pull ${model}. ${String(error)}`
    };
  }

  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isOllamaReady(config)) {
      return { ready: true, model, message: `Started Ollama and loaded ${model}.` };
    }
    await sleep(POLL_MS);
  }

  return {
    ready: false,
    model,
    message:
      `Ollama did not become ready within ${STARTUP_WAIT_MS / 1000}s. ` +
      `Run \`ollama pull ${model}\` in a terminal, then try again.`
  };
}
