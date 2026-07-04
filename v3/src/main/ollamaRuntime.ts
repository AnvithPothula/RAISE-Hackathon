import { spawn } from "node:child_process";
import type { AppConfig } from "../shared/types.js";
import { isOllamaReady, resolveInstalledOllamaModel, resolveOllamaModel, warmUpModel } from "./ollamaClient.js";
import { ensureOpenRouterReady, useOpenRouter } from "./openRouterClient.js";

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
  if (useOpenRouter(config)) {
    return ensureOpenRouterReady(config);
  }

  const model = await resolveInstalledOllamaModel(config);
  if (await isOllamaReady(config)) {
    // Preload weights in the background so the first prompt isn't a cold start.
    void warmUpModel(config);
    const preferred = resolveOllamaModel(config);
    const message =
      model === preferred
        ? `Local Gemma ready (${model}).`
        : `Local Gemma ready (${model}). Low-resource model '${preferred}' is not pulled; using ${model} instead. Run: ollama pull ${preferred}`;
    return { ready: true, model, message };
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
      const installed = await resolveInstalledOllamaModel(config);
      void warmUpModel(config);
      return { ready: true, model: installed, message: `Started Ollama and loaded ${installed}.` };
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
