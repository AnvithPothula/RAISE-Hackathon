import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { EventEmitter } from "node:events";
import { appRoot, caBundleEnv, resolveWorkerPython } from "./config.js";
import { JsonlBuffer } from "./jsonl.js";
import type { WorkerEvent } from "../shared/types.js";

type WorkerCommand =
  | { type: "start_listening" }
  | { type: "start_wakeword" }
  | { type: "stop_listening" }
  | { type: "speak"; text: string; lengthScale?: number }
  | { type: "stop_speaking" }
  | { type: "shutdown" };

export class PythonWorkerBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly buffer = new JsonlBuffer();
  private readonly intentionalStops = new WeakSet<ChildProcessWithoutNullStreams>();

  start(): void {
    if (this.child) {
      debug("start ignored because worker already exists");
      return;
    }

    const python = resolveWorkerPython();
    debug(`starting python worker executable=${python}`);
    const env = {
      ...process.env,
      ...caBundleEnv(),
      PYTHOS_DEBUG: process.env.PYTHOS_DEBUG ?? "1",
      PYTHONPATH: path.join(appRoot, "src"),
      PYTHOS_CONFIG: path.join(appRoot, "config.json")
    };

    const child = spawn(
      python,
      ["-m", "pythos.worker", "--config", path.join(appRoot, "config.json")],
      { cwd: appRoot, env }
    );
    this.child = child;
    debug(`python worker spawned pid=${child.pid ?? "unknown"}`);

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of this.buffer.push(chunk.toString("utf-8"))) {
          if (!isAudioLevelEvent(value)) {
            debug(`worker event ${JSON.stringify(value)}`);
          }
          this.emit("event", value as WorkerEvent);
        }
      } catch (error) {
        debug(`worker JSONL parse error ${String(error)}`);
        this.emit("event", {
          type: "error",
          payload: { source: "python-jsonl", message: String(error) }
        } satisfies WorkerEvent);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const stderrText = chunk.toString("utf-8");
      const nonDebugLines: string[] = [];
      for (const line of stderrText.split(/\r?\n/)) {
        if (line.trim()) {
          debug(`stderr ${line}`);
          if (!line.startsWith("[pythos-worker ")) {
            nonDebugLines.push(line);
          }
        }
      }
      if (nonDebugLines.length > 0) {
        this.emit("event", {
          type: "error",
          payload: { source: "python-stderr", message: nonDebugLines.join("\n") }
        } satisfies WorkerEvent);
      }
    });

    child.on("exit", (code) => {
      debug(`python worker exit code=${String(code)} intentional=${this.intentionalStops.has(child)}`);
      if (this.child === child) {
        this.child = null;
      }
      if (this.intentionalStops.has(child)) {
        return;
      }
      this.emit("event", {
        type: "state",
        payload: { value: code === 0 ? "shutdown" : "error" }
      } satisfies WorkerEvent);
    });
  }

  send(command: WorkerCommand): void {
    this.start();
    debug(`send ${JSON.stringify(command)} child=${this.child ? "yes" : "no"}`);
    this.child?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  stop(): void {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.intentionalStops.add(child);
    debug(`stop requested pid=${child.pid ?? "unknown"}`);
    child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`, () => {
      child.kill();
    });
  }

  restart(): void {
    if (this.child) {
      debug(`restart killing pid=${this.child.pid ?? "unknown"}`);
      this.intentionalStops.add(this.child);
      this.child.kill();
      this.child = null;
    }
    this.start();
  }
}

function debug(message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.error(`[pythos-main ${timestamp}] pythonWorker ${message}`);
}

function isAudioLevelEvent(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      (value as { type?: unknown }).type === "audio_level"
  );
}
