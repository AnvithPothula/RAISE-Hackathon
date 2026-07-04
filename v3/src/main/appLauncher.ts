import { spawn } from "node:child_process";
import { shell } from "electron";
import type { AppOpenOutcome } from "./localTools.js";

type CommandResult = {
  code: number | null;
  stderr: string;
};

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

export function formatMacOpenFailure(target: string, stderr: string): string {
  const cleaned = stderr.trim();
  if (/unable to find application/i.test(cleaned)) {
    return `${target} is not installed or not available on this Mac. I couldn't open it.`;
  }
  if (cleaned) {
    return `I couldn't open ${target}: ${cleaned}`;
  }
  return `${target} is unavailable on this Mac. I couldn't open it.`;
}

async function openLocalAppOnMac(target: string): Promise<AppOpenOutcome> {
  try {
    const result = await runCommand("open", ["-a", target]);
    if (result.code === 0) {
      return { opened: true, detail: `Opened ${target}.` };
    }
    return { opened: false, detail: formatMacOpenFailure(target, result.stderr) };
  } catch (error) {
    return {
      opened: false,
      detail: `${target} is unavailable on this Mac. ${String(error)}`
    };
  }
}

async function openLocalAppOnLinux(target: string): Promise<AppOpenOutcome> {
  try {
    const direct = await runCommand(target, []);
    if (direct.code === 0) {
      return { opened: true, detail: `Opened ${target}.` };
    }
    const browser = await runCommand("xdg-open", [target]);
    if (browser.code === 0) {
      return { opened: true, detail: `Opened ${target}.` };
    }
    const reason = browser.stderr || direct.stderr;
    return {
      opened: false,
      detail: reason ? `I couldn't open ${target}: ${reason}` : `${target} is unavailable on this device. I couldn't open it.`
    };
  } catch (error) {
    return {
      opened: false,
      detail: `${target} is unavailable on this device. ${String(error)}`
    };
  }
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stderr: stderr.trim() });
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
        resolve({
          opened: false,
          detail: `${target} is unavailable on this device. ${reason || "App not found."}`
        });
        return;
      }
      resolve({
        opened: false,
        detail: `I couldn't confirm ${target} opened${stderr.trim() ? `: ${stderr.trim()}` : "."}`
      });
    });
  });
}
