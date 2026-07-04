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

/**
 * Human-readable failure text for a macOS `open -a` attempt. Exported for
 * tests; used by the mac open path below when the launch command fails.
 */
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
          detail: appNotFoundMessage(target, "Mac")
        });
        return;
      }

      const child = spawn("open", ["-a", target], { stdio: "pipe" });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      child.on("error", (error) => {
        resolve({ opened: false, detail: appNotFoundMessage(target, "Mac", error.message) });
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve({ opened: true, detail: `Opened ${target}.` });
          return;
        }
        resolve({ opened: false, detail: formatMacOpenFailure(target, stderr) });
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
        resolve({ opened: false, detail: appNotFoundMessage(target, "Linux") });
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

function appNotFoundMessage(target: string, platform: "Mac" | "Windows" | "Linux", reason?: string): string {
  const normalized = String(reason ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (
    normalized.includes("cannot find the file") ||
    normalized.includes("unable to find application") ||
    normalized.includes("not found") ||
    normalized.includes("does not exist")
  ) {
    return `I couldn't find ${target} on your ${platform} computer. Check the name or install it first.`;
  }
  if (reason?.trim()) {
    return `I couldn't open ${target} on your ${platform} computer: ${reason.trim()}`;
  }
  return `I couldn't find ${target} on your ${platform} computer. Check the name or install it first.`;
}

function openLocalAppOnWindows(target: string): Promise<AppOpenOutcome> {
  return new Promise((resolve, reject) => {
    const escaped = target.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$target = '${escaped}'`,
      "function Resolve-StartApp {",
      "  param([string]$Name)",
      "  $apps = @(Get-StartApps)",
      "  $exact = $apps | Where-Object { $_.Name -eq $Name } | Select-Object -First 1",
      "  if ($exact) { return $exact }",
      "  $ci = $apps | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1",
      "  if ($ci) { return $ci }",
      "  return $apps | Where-Object { $_.Name -like \"*$Name*\" } | Sort-Object { $_.Name.Length } | Select-Object -First 1",
      "}",
      "if ($target -notmatch '\\.exe$') {",
      "  $startApp = Resolve-StartApp $target",
      "  if ($startApp) {",
      "    Start-Process explorer.exe \"shell:AppsFolder\\$($startApp.AppID)\" | Out-Null",
      "    Write-Output ('OK:' + $startApp.Name)",
      "    exit 0",
      "  }",
      "}",
      "try {",
      "  $proc = Start-Process -FilePath $target -PassThru",
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
        resolve({ opened: false, detail: appNotFoundMessage(target, "Windows", reason) });
        return;
      }
      if (!output && !target.match(/\.exe$/i)) {
        resolve({ opened: false, detail: appNotFoundMessage(target, "Windows") });
        return;
      }
      resolve({
        opened: false,
        detail: appNotFoundMessage(target, "Windows", stderr.trim() || undefined)
      });
    });
  });
}
