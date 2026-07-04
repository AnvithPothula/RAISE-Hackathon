import { spawn } from "node:child_process";
import { shell } from "electron";
import type { AppOpenOutcome } from "./localTools.js";

export async function openLocalApp(target: string): Promise<AppOpenOutcome> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    await shell.openExternal(target);
    return { opened: true, detail: `Opened ${target}.` };
  }
  if (process.platform === "darwin") {
    return openLocalAppOnMac(target);
  }
  if (process.platform !== "win32") {
    return openLocalAppOnLinux(target);
  }
  return openLocalAppOnWindows(target);
}

function macAppInstalled(appName: string): Promise<boolean> {
  const escaped = appName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", `id of application "${escaped}"`], { stdio: "pipe" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function openLocalAppOnMac(target: string): Promise<AppOpenOutcome> {
  return new Promise((resolve) => {
    void (async () => {
      const installed = await macAppInstalled(target);
      if (!installed) {
        resolve({
          opened: false,
          detail: `I couldn't find ${target} on your Mac. Check the name or install it first.`
        });
        return;
      }

      const child = spawn("open", ["-a", target], { stdio: "pipe" });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      child.on("error", (error) => {
        resolve({ opened: false, detail: `Could not open ${target}: ${error.message}` });
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve({ opened: true, detail: `Opened ${target}.` });
          return;
        }
        const reason = stderr.trim();
        resolve({
          opened: false,
          detail: reason.includes("Unable to find application")
            ? `I couldn't find ${target} on your Mac. Check the name or install it first.`
            : reason || `Could not open ${target}.`
        });
      });
    })();
  });
}

function openLocalAppOnLinux(target: string): Promise<AppOpenOutcome> {
  return new Promise((resolve) => {
    const child = spawn(target, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      const fallback = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
      fallback.on("error", () => {
        resolve({ opened: false, detail: `I couldn't find or launch ${target} on this system.` });
      });
      fallback.on("spawn", () => {
        fallback.unref();
        resolve({ opened: true, detail: `Opened ${target}.` });
      });
    });
    child.on("spawn", () => {
      child.unref();
      resolve({ opened: true, detail: `Opened ${target}.` });
    });
  });
}

function openLocalAppOnWindows(target: string): Promise<AppOpenOutcome> {
  return new Promise((resolve, reject) => {
    const escaped = target.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      `  $proc = Start-Process -FilePath '${escaped}' -PassThru`,
      "} catch {",
      "  Write-Output ('FAIL:' + $_.Exception.Message)",
      "  exit 0",
      "}",
      "if ($null -eq $proc) { Write-Output 'HANDOFF'; exit 0 }",
      "Start-Sleep -Milliseconds 400",
      "$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue",
      "if ($alive) { Write-Output ('OK:' + $alive.ProcessName) } else { Write-Output 'HANDOFF' }",
      "exit 0"
    ].join("; ");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: "pipe" }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", () => {
      const output = stdout.trim();
      if (output.startsWith("OK:")) {
        const processName = output.slice(3).trim();
        resolve({ opened: true, detail: `Opened ${processName || target}.` });
        return;
      }
      if (output === "HANDOFF") {
        resolve({ opened: true, detail: `Opened ${target}.` });
        return;
      }
      if (output.startsWith("FAIL:")) {
        const reason = output.slice(5).trim();
        resolve({ opened: false, detail: `Could not open ${target}: ${reason || "app not found"}.` });
        return;
      }
      resolve({
        opened: false,
        detail: `Could not confirm ${target} opened${stderr.trim() ? `: ${stderr.trim()}` : "."}`
      });
    });
  });
}
