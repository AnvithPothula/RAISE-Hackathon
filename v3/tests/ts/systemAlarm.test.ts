import { describe, expect, it, vi } from "vitest";
import {
  alarmTimeParts,
  buildMacAlarmScript,
  buildWindowsAlarmScript,
  openSystemClockApp,
  resolveClockAppTarget,
  setSystemClockAlarm,
  type SystemAlarmServices
} from "../../src/main/systemAlarm.js";

describe("systemAlarm", () => {
  it("resolves the Clock app target per platform", () => {
    if (process.platform === "win32") {
      expect(resolveClockAppTarget()).toBe("ms-clock:alarms");
    } else {
      expect(resolveClockAppTarget()).toBe("Clock");
    }
  });

  it("extracts local alarm time parts", () => {
    const dueAt = new Date(2026, 6, 4, 7, 30, 15).getTime();
    expect(alarmTimeParts(dueAt)).toEqual({ hours: 7, minutes: 30, seconds: 15 });
  });

  it("builds a Windows WinRT alarm script with escaped labels", () => {
    const dueAt = new Date(2026, 6, 4, 7, 30, 0).getTime();
    const script = buildWindowsAlarmScript(dueAt, "O'Brien wake-up");
    expect(script).toContain("New-TimeSpan -Hours 7 -Minutes 30 -Seconds 0");
    expect(script).toContain("O''Brien wake-up");
    expect(script).toContain("AddAlarmAsync");
  });

  it("builds a Mac Clock AppleScript with the alarm label and time", () => {
    const dueAt = new Date(2026, 6, 4, 6, 45, 0).getTime();
    const script = buildMacAlarmScript(dueAt, 'Morning "standup"');
    expect(script).toContain('tell application "Clock" to activate');
    expect(script).toContain('label:"Morning \\"standup\\""');
    expect(script).toContain("set hours of alarmTime to 6");
    expect(script).toContain("set minutes of alarmTime to 45");
  });

  it("opens the native Clock app through the injected launcher", async () => {
    const openClock = vi.fn(async () => ({ opened: true, detail: "Opened Clock." }));
    const opened = await openSystemClockApp({ openClock });
    expect(opened).toBe(true);
    expect(openClock).toHaveBeenCalledWith(resolveClockAppTarget());
  });

  it("registers a Windows system alarm when PowerShell succeeds", async () => {
    if (process.platform !== "win32") {
      const dueAt = new Date(2026, 6, 4, 8, 0, 0).getTime();
      expect(buildWindowsAlarmScript(dueAt, "Wake up")).toContain("ShowCreateAlarmPageAsync");
      return;
    }

    const services: SystemAlarmServices = {
      openClock: async () => ({ opened: true }),
      runCommand: async (command, args) => {
        expect(command).toBe("powershell.exe");
        expect(args.join(" ")).toContain("AddAlarmAsync");
        return { code: 0, stdout: "OK:SYSTEM", stderr: "" };
      }
    };

    const result = await setSystemClockAlarm({ dueAt: Date.now() + 60_000, label: "Test" }, services);
    expect(result.clockOpened).toBe(true);
    expect(result.systemAlarmSet).toBe(true);
    expect(result.detail).toContain("Windows Clock");
  });

  it("registers a Mac system alarm when AppleScript succeeds", async () => {
    if (process.platform !== "darwin") {
      const dueAt = new Date(2026, 6, 4, 8, 0, 0).getTime();
      expect(buildMacAlarmScript(dueAt, "Wake up")).toContain('make new alarm');
      return;
    }

    const services: SystemAlarmServices = {
      openClock: async () => ({ opened: true }),
      runCommand: async (command, args) => {
        expect(command).toBe("osascript");
        expect(args[0]).toBe("-e");
        expect(args[1]).toContain('tell application "Clock"');
        return { code: 0, stdout: "OK:SYSTEM", stderr: "" };
      }
    };

    const result = await setSystemClockAlarm({ dueAt: Date.now() + 60_000, label: "Test" }, services);
    expect(result.clockOpened).toBe(true);
    expect(result.systemAlarmSet).toBe(true);
    expect(result.detail).toContain("Mac Clock");
  });

  it("still opens Clock when the system alarm script fails", async () => {
    const services: SystemAlarmServices = {
      openClock: async () => ({ opened: true }),
      runCommand: async () => ({ code: 1, stdout: "FAIL:permission denied", stderr: "" })
    };

    const result = await setSystemClockAlarm({ dueAt: Date.now() + 60_000, label: "Test" }, services);
    expect(result.clockOpened).toBe(true);
    expect(result.systemAlarmSet).toBe(false);
    expect(result.detail.toLowerCase()).toContain("not saved");
  });
});
