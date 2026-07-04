import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, desktopCapturer, nativeImage, screen, type BrowserWindow } from "electron";

export type ScreenCaptureResult = {
  path: string;
  width: number;
  height: number;
};

export async function captureDisplayScreenshot(mainWindow: BrowserWindow | null): Promise<ScreenCaptureResult> {
  try {
    return await captureViaDesktopCapturer(mainWindow);
  } catch (desktopError) {
    if (process.platform === "darwin") {
      try {
        return await captureViaMacScreencapture();
      } catch {
        // Fall through to the desktopCapturer error message.
      }
    }
    throw new Error(formatScreenCaptureError(desktopError));
  }
}

async function captureViaDesktopCapturer(mainWindow: BrowserWindow | null): Promise<ScreenCaptureResult> {
  const targetDisplay =
    mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : screen.getPrimaryDisplay();
  const scale = targetDisplay.scaleFactor;
  const thumbnailSize = {
    width: Math.min(2560, Math.max(640, Math.round(targetDisplay.size.width * scale))),
    height: Math.min(1440, Math.max(480, Math.round(targetDisplay.size.height * scale)))
  };

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
      fetchWindowIcons: false
    });
  } catch (error) {
    throw new Error(formatScreenCaptureError(error));
  }

  const displayId = String(targetDisplay.id);
  const source =
    sources.find((entry) => String(entry.display_id) === displayId && !entry.thumbnail.isEmpty()) ??
    sources.find((entry) => !entry.thumbnail.isEmpty());
  if (!source) {
    throw new Error(formatScreenCaptureError(new Error("No screen source was available to capture.")));
  }

  const image = source.thumbnail;
  const size = image.getSize();
  const filePath = path.join(app.getPath("temp"), `pythos-screen-${Date.now()}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return { path: filePath, width: size.width, height: size.height };
}

async function captureViaMacScreencapture(): Promise<ScreenCaptureResult> {
  const filePath = path.join(app.getPath("temp"), `pythos-screen-${Date.now()}.png`);
  await runCommand("screencapture", ["-x", "-t", "png", filePath]);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 64) {
    throw new Error("screencapture produced an empty image.");
  }
  const image = nativeImage.createFromPath(filePath);
  const size = image.getSize();
  return { path: filePath, width: size.width, height: size.height };
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

export function formatScreenCaptureError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/failed to get sources|permission|denied|not authorized|could not capture|screen recording/i.test(detail)) {
    const appName =
      process.platform === "darwin" ? (process.defaultApp ? "Electron" : "Pythos") : "Pythos";
    return (
      `I couldn't capture your screen. On macOS, turn on Screen Recording for ${appName} in ` +
      "System Settings > Privacy & Security > Screen Recording, then quit and reopen Pythos."
    );
  }
  if (/no screen source/i.test(detail)) {
    return `${detail} Enable Screen Recording permission for this app and try again.`;
  }
  return detail.startsWith("I couldn't capture") ? detail : `I couldn't capture your screen: ${detail}`;
}
