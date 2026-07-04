import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openLocalApp } from "./appLauncher.js";

const execFileAsync = promisify(execFile);

export type SystemAlarmRequest = {
  /** Absolute due time in epoch milliseconds (local timezone). */
  dueAt: number;
  label: string;
};

export type SystemAlarmResult = {
  clockOpened: boolean;
  systemAlarmSet: boolean;
  detail: string;
};

export type CommandOutcome = {
  code: number;
  stdout: string;
  stderr: string;
};

export type SystemAlarmServices = {
  runCommand?: (command: string, args: string[], timeoutMs?: number) => Promise<CommandOutcome>;
  openClock?: (target: string) => Promise<{ opened?: boolean; detail?: string }>;
};

const COMMAND_TIMEOUT_MS = 15000;

/** Resolved Clock app target per platform (also used by app aliases). */
export function resolveClockAppTarget(): string {
  if (process.platform === "win32") {
    return "ms-clock:alarms";
  }
  return "Clock";
}

/** Local hour/minute/second parts used by platform alarm scripts. */
export function alarmTimeParts(dueAt: number): { hours: number; minutes: number; seconds: number } {
  const date = new Date(dueAt);
  return {
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds()
  };
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * PowerShell that registers a one-time Windows Clock alarm through the WinRT
 * Alarm API. Falls back to opening the create-alarm page when AddAlarmAsync is
 * unavailable (older builds or restricted shells).
 */
export function buildWindowsAlarmScript(dueAt: number, label: string): string {
  const { hours, minutes, seconds } = alarmTimeParts(dueAt);
  const safeLabel = escapePowerShellSingleQuoted(label.trim() || "Alarm");
  return [
    "$ErrorActionPreference = 'Stop'",
    "function Await([object]$WinRTTask, [Type]$ResultType) {",
    "  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {",
    "    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and -not $_.IsGenericMethod",
    "  })[0].MakeGenericMethod($ResultType)",
    "  $netTask = $asTask.Invoke($null, @($WinRTTask))",
    "  $netTask.Wait(-1) | Out-Null",
    "  $netTask.Result",
    "}",
    "[Windows.ApplicationModel.AlarmApplicationManager, Windows.ApplicationModel, ContentType=WindowsRuntime] | Out-Null",
    "[Windows.ApplicationModel.Alarm, Windows.ApplicationModel, ContentType=WindowsRuntime] | Out-Null",
    `$label = '${safeLabel}'`,
    `$span = New-TimeSpan -Hours ${hours} -Minutes ${minutes} -Seconds ${seconds}`,
    "try {",
    "  $alarm = [Windows.ApplicationModel.Alarm]::new()",
    "  $alarm.Label = $label",
    "  $alarm.Duration = $span",
    "  $null = Await ($alarm.AddAlarmAsync()) ([Windows.ApplicationModel.Alarm])",
    "  Write-Output 'OK:SYSTEM'",
    "  exit 0",
    "} catch {",
    "  try {",
    "    $null = Await ([Windows.ApplicationModel.AlarmApplicationManager]::ShowCreateAlarmPageAsync($span)) ([bool])",
    "    Write-Output 'OK:UI'",
    "    exit 0",
    "  } catch {",
    "    Write-Output ('FAIL:' + $_.Exception.Message)",
    "    exit 1",
    "  }",
    "}"
  ].join("\n");
}

/**
 * AppleScript that opens Clock and attempts to create an alarm when the app
 * exposes a scriptable dictionary (macOS Ventura+). Errors are surfaced to the
 * caller so Pythos can still rely on its internal alarm timer.
 */
export function buildMacAlarmScript(dueAt: number, label: string): string {
  const { hours, minutes, seconds } = alarmTimeParts(dueAt);
  const safeLabel = escapeAppleScriptString(label.trim() || "Alarm");
  return [
    'tell application "Clock" to activate',
    "delay 0.4",
    "try",
    '  tell application "Clock"',
    "    set alarmTime to current date",
    `    set hours of alarmTime to ${hours}`,
    `    set minutes of alarmTime to ${minutes}`,
    `    set seconds of alarmTime to ${seconds}`,
    `    make new alarm with properties {label:"${safeLabel}", time:alarmTime, enabled:true}`,
    "  end tell",
    '  return "OK:SYSTEM"',
    "on error errMsg",
    '  return "FAIL:" & errMsg',
    "end try"
  ].join("\n");
}

async function defaultRunCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    const code = typeof failed.code === "number" ? failed.code : 1;
    return {
      code,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? failed.message ?? "")
    };
  }
}

export async function openSystemClockApp(services: SystemAlarmServices = {}): Promise<boolean> {
  const openClock = services.openClock ?? openLocalApp;
  const target = resolveClockAppTarget();
  const outcome = await openClock(target);
  return outcome.opened !== false;
}

async function setWindowsSystemAlarm(
  request: SystemAlarmRequest,
  services: SystemAlarmServices
): Promise<{ set: boolean; detail: string }> {
  const runCommand = services.runCommand ?? defaultRunCommand;
  const script = buildWindowsAlarmScript(request.dueAt, request.label);
  const result = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    COMMAND_TIMEOUT_MS
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (/OK:SYSTEM/i.test(output)) {
    return { set: true, detail: "Added the alarm to Windows Clock." };
  }
  if (/OK:UI/i.test(output)) {
    return { set: true, detail: "Opened Windows Clock with the alarm time ready to save." };
  }
  const reason = output.replace(/^FAIL:/i, "").trim();
  return {
    set: false,
    detail: reason ? `Windows Clock alarm was not saved: ${reason}` : "Windows Clock alarm was not saved."
  };
}

async function setMacSystemAlarm(
  request: SystemAlarmRequest,
  services: SystemAlarmServices
): Promise<{ set: boolean; detail: string }> {
  const runCommand = services.runCommand ?? defaultRunCommand;
  const script = buildMacAlarmScript(request.dueAt, request.label);
  const result = await runCommand("osascript", ["-e", script], COMMAND_TIMEOUT_MS);
  const output = `${result.stdout}`.trim();
  if (/OK:SYSTEM/i.test(output)) {
    return { set: true, detail: "Added the alarm to the Mac Clock app." };
  }
  const reason = output.replace(/^FAIL:/i, "").trim() || result.stderr.trim();
  return {
    set: false,
    detail: reason ? `Mac Clock alarm was not saved: ${reason}` : "Mac Clock alarm was not saved."
  };
}

/**
 * Open the native Clock app and attempt to register a matching system alarm.
 * Pythos still keeps its internal alarm timer as a reliable fallback.
 */
export async function setSystemClockAlarm(
  request: SystemAlarmRequest,
  services: SystemAlarmServices = {}
): Promise<SystemAlarmResult> {
  const clockOpened = await openSystemClockApp(services);

  if (process.platform === "win32") {
    const outcome = await setWindowsSystemAlarm(request, services);
    return {
      clockOpened,
      systemAlarmSet: outcome.set,
      detail: outcome.detail
    };
  }

  if (process.platform === "darwin") {
    const outcome = await setMacSystemAlarm(request, services);
    return {
      clockOpened,
      systemAlarmSet: outcome.set,
      detail: outcome.detail
    };
  }

  return {
    clockOpened,
    systemAlarmSet: false,
    detail: "System Clock alarms are supported on Mac and Windows only."
  };
}
