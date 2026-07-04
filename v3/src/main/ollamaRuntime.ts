import { spawn } from "node:child_process";

let startupAttempted = false;

export async function ensureOllamaRunning(baseUrl: string): Promise<void> {
  if (await isOllamaRunning(baseUrl)) {
    return;
  }

  if (!startupAttempted) {
    startupAttempted = true;
    try {
      const child = spawn("ollama", ["app"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
    } catch {
      // The caller reports the final connection failure if Ollama still does not answer.
    }
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isOllamaRunning(baseUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function isOllamaRunning(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}
