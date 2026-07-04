import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { appRoot } from "./config.js";
import { JsonlBuffer } from "./jsonl.js";
import type { PiEvent, PiStatus } from "../shared/types.js";

type PiConfig = {
  enabled: boolean;
  command: string;
  args: string[];
  cwd: string;
};

export class PiRpcBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly buffer = new JsonlBuffer();
  private requestId = 0;
  private unavailableReason: string | null = null;

  constructor(private config: PiConfig) {
    super();
  }

  getStatus(): PiStatus {
    if (!this.config.enabled) {
      return {
        enabled: false,
        available: false,
        running: Boolean(this.child),
        command: null,
        args: [],
        reason: "Pi is disabled in settings."
      };
    }

    const launch = resolvePiLaunch(this.config);
    if (!launch) {
      return {
        enabled: true,
        available: false,
        running: Boolean(this.child),
        command: null,
        args: [],
        reason: "Pi CLI was not found. Install Pi or set PYTHOS_PI_COMMAND to the full command path."
      };
    }

    return {
      enabled: true,
      available: true,
      running: Boolean(this.child),
      command: launch.command,
      args: launch.args,
      reason: this.unavailableReason
    };
  }

  start(): boolean {
    if (!this.config.enabled || this.child) {
      return Boolean(this.child);
    }
    if (this.unavailableReason) {
      return false;
    }

    const cwd = path.resolve(appRoot, this.config.cwd || ".");
    const launch = resolvePiLaunch(this.config);
    if (!launch) {
      this.unavailableReason =
        "Pi CLI was not found. Install it or set PYTHOS_PI_COMMAND to the full pi command path.";
      this.emit("event", { type: "unavailable", payload: this.unavailableReason } satisfies PiEvent);
      return false;
    }

    debug(`starting Pi cwd=${cwd} command=${launch.command} args=${JSON.stringify(launch.args)}`);
    this.child = spawn(launch.command, launch.args, { cwd, env: process.env });

    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of this.buffer.push(chunk.toString("utf-8"))) {
          this.emit("event", { type: "pi", payload: value } satisfies PiEvent);
        }
      } catch (error) {
        this.emit("event", { type: "error", payload: String(error) } satisfies PiEvent);
      }
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      debug(`stderr ${text.trim()}`);
      this.emit("event", { type: "stderr", payload: text } satisfies PiEvent);
    });

    this.child.on("error", (error) => {
      debug(`error ${error.message}`);
      this.unavailableReason = error.message;
      this.emit("event", { type: "error", payload: error.message } satisfies PiEvent);
      this.child = null;
    });

    this.child.on("exit", (code) => {
      debug(`exit code=${String(code)}`);
      this.emit("event", { type: "exit", payload: { code } } satisfies PiEvent);
      this.child = null;
      this.emit("status", this.getStatus());
    });

    this.emit("status", this.getStatus());

    return true;
  }

  prompt(message: string): boolean {
    if (!this.start()) {
      return false;
    }
    return this.send({ id: this.nextId(), type: "prompt", message });
  }

  abort(): void {
    this.send({ id: this.nextId(), type: "abort" });
  }

  getCommands(): void {
    this.start();
    this.send({ id: this.nextId(), type: "get_commands" });
  }

  getLastAssistantText(): void {
    this.send({ id: this.nextId(), type: "get_last_assistant_text" });
  }

  stop(): void {
    if (this.child) {
      debug(`stop pid=${this.child.pid ?? "unknown"}`);
    }
    this.child?.kill();
    this.child = null;
    this.emit("status", this.getStatus());
  }

  updateConfig(config: PiConfig): void {
    debug(`updateConfig enabled=${config.enabled} args=${JSON.stringify(config.args)}`);
    this.config = config;
    this.unavailableReason = null;
    this.stop();
    this.emit("status", this.getStatus());
  }

  private send(command: Record<string, unknown>): boolean {
    if (!this.child) {
      return false;
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  private nextId(): string {
    this.requestId += 1;
    return `pythos-${this.requestId}`;
  }
}

function debug(message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.error(`[pythos-main ${timestamp}] piRpc ${message}`);
}

function resolvePiLaunch(config: PiConfig): { command: string; args: string[] } | null {
  if (path.isAbsolute(config.command) && fs.existsSync(config.command)) {
    return launchForPath(config.command, config.args);
  }

  const explicit = process.env.PYTHOS_PI_COMMAND;
  if (explicit && (path.isAbsolute(explicit) ? fs.existsSync(explicit) : true)) {
    return launchForPath(explicit, config.args);
  }

  const isWindows = process.platform === "win32";
  const commandCandidates = isWindows
    ? [
        path.join(os.homedir(), ".npm-global", "pi.ps1"),
        path.join(os.homedir(), ".npm-global", "pi.cmd")
      ]
    : npmGlobalBinDirs().map((dir) => path.join(dir, "pi"));
  for (const commandPath of commandCandidates) {
    if (fs.existsSync(commandPath)) {
      return launchForPath(commandPath, config.args);
    }
  }

  const nodeCommand = isWindows ? "node.exe" : "node";
  const packages = ["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"];
  for (const modulesRoot of npmGlobalModuleDirs()) {
    for (const pkg of packages) {
      const cliPath = path.join(modulesRoot, ...pkg.split("/"), "dist", "cli.js");
      if (fs.existsSync(cliPath)) {
        return { command: nodeCommand, args: [cliPath, ...config.args] };
      }
    }
  }

  // Fall back to resolving the command on PATH (e.g. a `pi` binary installed globally).
  return { command: config.command, args: config.args };
}

function npmGlobalBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".nvm", "current", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin"
  ];
}

function npmGlobalModuleDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".npm-global", "node_modules"),
    path.join(home, ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/usr/lib/node_modules"
  ];
}

function launchForPath(commandPath: string, args: string[]): { command: string; args: string[] } {
  if (commandPath.endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath, ...args]
    };
  }
  if (commandPath.endsWith(".cmd") || commandPath.endsWith(".bat")) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandPath, ...args]
    };
  }
  return { command: commandPath, args };
}
