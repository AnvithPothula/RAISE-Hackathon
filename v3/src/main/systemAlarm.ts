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

export type SystemCalendarEventRequest = {
  title: string;
  startAt: number;
  allDay?: boolean;
};

export type SystemCalendarEventResult = {
  calendarOpened: boolean;
  eventCreated: boolean;
  detail: string;
};

export type SystemCalendarListRequest = {
  startAt: number;
  endAt: number;
};

export type SystemCalendarListResult = {
  calendarOpened: boolean;
  events: Array<{ title: string; startAt: number; allDay: boolean }>;
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
  openCalendar?: (target: string) => Promise<{ opened?: boolean; detail?: string }>;
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

const APPLESCRIPT_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;

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
 * Modern macOS Clock does not expose a scriptable alarm class ("make new alarm"
 * fails), so create a real Calendar event with a sound alarm at the due time.
 */
export function buildMacAlarmScript(dueAt: number, label: string): string {
  const date = new Date(dueAt);
  const safeLabel = escapeAppleScriptString(label.trim() || "Pythos Alarm");
  const month = APPLESCRIPT_MONTHS[date.getMonth()];
  return [
    "set alarmDate to current date",
    `set year of alarmDate to ${date.getFullYear()}`,
    `set month of alarmDate to ${month}`,
    `set day of alarmDate to ${date.getDate()}`,
    `set hours of alarmDate to ${date.getHours()}`,
    `set minutes of alarmDate to ${date.getMinutes()}`,
    `set seconds of alarmDate to ${date.getSeconds()}`,
    'tell application "Calendar"',
    "  set targetCalendar to first calendar",
    "  try",
    "    repeat with candidateCalendar in calendars",
    "      if writable of candidateCalendar is true then",
    "        set targetCalendar to candidateCalendar",
    "        exit repeat",
    "      end if",
    "    end repeat",
    "  end try",
    "  tell targetCalendar",
    `    set newEvent to make new event at end with properties {summary:"${safeLabel}", start date:alarmDate, end date:(alarmDate + 60), allday event:false}`,
    "  end tell",
    "  tell newEvent",
    '    make new sound alarm at end of sound alarms with properties {trigger interval:0, sound name:"Sosumi"}',
    "  end tell",
    "end tell",
    'return "OK:CALENDAR"'
  ].join("\n");
}

export function buildMacCalendarEventScript(request: SystemCalendarEventRequest): string {
  const date = new Date(request.startAt);
  const safeTitle = escapeAppleScriptString(request.title.trim() || "Calendar event");
  const month = APPLESCRIPT_MONTHS[date.getMonth()];
  const duration = request.allDay ? "1 * days" : "1 * hours";
  return [
    "set eventDate to current date",
    `set year of eventDate to ${date.getFullYear()}`,
    `set month of eventDate to ${month}`,
    `set day of eventDate to ${date.getDate()}`,
    `set hours of eventDate to ${request.allDay ? 0 : date.getHours()}`,
    `set minutes of eventDate to ${request.allDay ? 0 : date.getMinutes()}`,
    `set seconds of eventDate to ${request.allDay ? 0 : date.getSeconds()}`,
    'tell application "Calendar"',
    "  activate",
    "  set targetCalendar to first calendar",
    "  try",
    "    repeat with candidateCalendar in calendars",
    "      if writable of candidateCalendar is true then",
    "        set targetCalendar to candidateCalendar",
    "        exit repeat",
    "      end if",
    "    end repeat",
    "  end try",
    "  tell targetCalendar",
    `    make new event at end with properties {summary:"${safeTitle}", start date:eventDate, end date:(eventDate + (${duration})), allday event:${request.allDay ? "true" : "false"}}`,
    "  end tell",
    "end tell",
    'return "OK:CALENDAR_EVENT"'
  ].join("\n");
}

function buildAppleScriptDate(variableName: string, timestamp: number): string[] {
  const date = new Date(timestamp);
  const month = APPLESCRIPT_MONTHS[date.getMonth()];
  return [
    `set ${variableName} to current date`,
    `set year of ${variableName} to ${date.getFullYear()}`,
    `set month of ${variableName} to ${month}`,
    `set day of ${variableName} to ${date.getDate()}`,
    `set hours of ${variableName} to ${date.getHours()}`,
    `set minutes of ${variableName} to ${date.getMinutes()}`,
    `set seconds of ${variableName} to ${date.getSeconds()}`
  ];
}

export function buildMacCalendarListScript(request: SystemCalendarListRequest): string {
  return [
    ...buildAppleScriptDate("rangeStart", request.startAt),
    ...buildAppleScriptDate("rangeEnd", request.endAt),
    "set outputLines to {}",
    'tell application "Calendar"',
    "  repeat with candidateCalendar in calendars",
    "    repeat with calendarEvent in (events of candidateCalendar whose start date is greater than or equal to rangeStart and start date is less than rangeEnd)",
    "      set eventSummary to summary of calendarEvent",
    "      set eventStart to start date of calendarEvent",
    "      set eventAllDay to allday event of calendarEvent",
    '      set end of outputLines to (eventSummary & tab & ((eventStart - (date "Thursday, January 1, 1970 at 12:00:00 AM")) as integer) & tab & eventAllDay)',
    "    end repeat",
    "  end repeat",
    "end tell",
    'set AppleScript\'s text item delimiters to "\\n"',
    "set outputText to outputLines as text",
    'return "OK:CALENDAR_LIST\\n" & outputText'
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

export async function openSystemCalendarApp(services: SystemAlarmServices = {}): Promise<boolean> {
  const openCalendar = services.openCalendar ?? openLocalApp;
  const outcome = await openCalendar("Calendar");
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
  if (/OK:CALENDAR/i.test(output)) {
    return { set: true, detail: "Added a Calendar sound alarm." };
  }
  const reason = output.replace(/^FAIL:/i, "").trim() || result.stderr.trim();
  return {
    set: false,
    detail: reason ? `Mac Clock alarm was not saved: ${reason}` : ""
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

export async function setSystemCalendarEvent(
  request: SystemCalendarEventRequest,
  services: SystemAlarmServices = {}
): Promise<SystemCalendarEventResult> {
  const calendarOpened = process.platform === "darwin" ? true : await openSystemCalendarApp(services);

  if (process.platform !== "darwin") {
    return {
      calendarOpened,
      eventCreated: false,
      detail: "Calendar event creation is currently supported on Mac only."
    };
  }

  const runCommand = services.runCommand ?? defaultRunCommand;
  const script = buildMacCalendarEventScript(request);
  const result = await runCommand("osascript", ["-e", script], COMMAND_TIMEOUT_MS);
  const output = `${result.stdout}`.trim();
  if (/OK:CALENDAR_EVENT/i.test(output)) {
    return {
      calendarOpened: true,
      eventCreated: true,
      detail: "Added it to Calendar."
    };
  }
  const reason = output.replace(/^FAIL:/i, "").trim() || result.stderr.trim();
  return {
    calendarOpened: true,
    eventCreated: false,
    detail: reason ? `Calendar event was not created: ${reason}` : "Calendar event was not created."
  };
}

export async function listSystemCalendarEvents(
  request: SystemCalendarListRequest,
  services: SystemAlarmServices = {}
): Promise<SystemCalendarListResult> {
  const calendarOpened = process.platform === "darwin" ? true : await openSystemCalendarApp(services);
  if (process.platform !== "darwin") {
    return { calendarOpened, events: [], detail: "Calendar reading is currently supported on Mac only." };
  }

  const runCommand = services.runCommand ?? defaultRunCommand;
  const script = buildMacCalendarListScript(request);
  const result = await runCommand("osascript", ["-e", script], COMMAND_TIMEOUT_MS);
  const output = `${result.stdout}`.trim();
  if (!/^OK:CALENDAR_LIST/i.test(output)) {
    const reason = output.replace(/^FAIL:/i, "").trim() || result.stderr.trim();
    return { calendarOpened: true, events: [], detail: reason ? `Calendar events were not read: ${reason}` : "Calendar events were not read." };
  }

  const events = output
    .replace(/^OK:CALENDAR_LIST\s*/i, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title = "", epochSeconds = "0", allDay = "false"] = line.split(/\t/);
      return { title, startAt: Number(epochSeconds) * 1000, allDay: /^true$/i.test(allDay) };
    })
    .filter((event) => event.title && Number.isFinite(event.startAt));

  return { calendarOpened: true, events, detail: events.length ? "Read Calendar events." : "No Calendar events found." };
}
