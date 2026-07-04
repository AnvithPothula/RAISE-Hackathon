#!/usr/bin/env node
// pythos-system: a small MCP server shipped with Pythos, built during RAISE 2026.
// Exposes on-device system capabilities (clipboard, system stats, file search,
// running apps, quick notes) to the local Gemma brain over stdio. Everything
// here runs locally; nothing touches the network.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const NOTES_PATH = path.join(os.homedir(), ".pythos-notes.json");
const SANDBOX_ROOT = path.resolve(process.env.PYTHOS_MCP_SANDBOX || os.homedir());

function resolveSandboxPath(inputPath) {
  const resolved = path.resolve(SANDBOX_ROOT, String(inputPath ?? "").replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!resolved.startsWith(SANDBOX_ROOT)) {
    throw new Error("Path escapes the MCP sandbox.");
  }
  return resolved;
}

const server = new McpServer({ name: "pythos-system", version: "1.0.0" });

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

async function run(command, args, timeoutMs = 8000) {
  const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return String(stdout ?? "").trim();
}

server.registerTool(
  "clipboard_read",
  { description: "Read the current text content of the system clipboard." },
  async () => {
    if (process.platform === "darwin") {
      return textResult((await run("pbpaste", [])) || "(clipboard is empty)");
    }
    if (process.platform === "win32") {
      return textResult((await run("powershell", ["-NoProfile", "-Command", "Get-Clipboard"])) || "(clipboard is empty)");
    }
    return textResult((await run("xclip", ["-selection", "clipboard", "-o"])) || "(clipboard is empty)");
  }
);

server.registerTool(
  "clipboard_write",
  {
    description: "Write text to the system clipboard so the user can paste it anywhere.",
    inputSchema: { text: z.string().describe("Text to place on the clipboard.") }
  },
  async ({ text }) => {
    const write = (command, args) =>
      new Promise((resolve, reject) => {
        const child = execFile(command, args, { timeout: 8000 }, (error) => (error ? reject(error) : resolve()));
        child.stdin?.end(text);
      });
    if (process.platform === "darwin") {
      await write("pbcopy", []);
    } else if (process.platform === "win32") {
      await write("clip", []);
    } else {
      await write("xclip", ["-selection", "clipboard"]);
    }
    return textResult(`Copied ${text.length} characters to the clipboard.`);
  }
);

server.registerTool(
  "system_stats",
  { description: "Get live system stats: CPU load, memory use, uptime, battery level, and disk space." },
  async () => {
    const load = os.loadavg().map((value) => value.toFixed(2)).join(" / ");
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
    const uptimeHours = (os.uptime() / 3600).toFixed(1);
    const lines = [
      `Host: ${os.hostname()} (${process.platform} ${os.arch()}, ${os.cpus().length} cores)`,
      `CPU load (1/5/15 min): ${load}`,
      `Memory: ${gb(usedMem)} GB used of ${gb(totalMem)} GB`,
      `Uptime: ${uptimeHours} hours`
    ];
    if (process.platform === "darwin") {
      try {
        const battery = await run("pmset", ["-g", "batt"]);
        const match = battery.match(/(\d+)%.*?(charging|discharging|charged|AC attached)/i);
        if (match) {
          lines.push(`Battery: ${match[1]}% (${match[2]})`);
        }
      } catch {
        // Battery info is optional (desktops).
      }
      try {
        const disk = await run("df", ["-h", "/"]);
        const row = disk.split("\n").at(-1)?.split(/\s+/) ?? [];
        if (row.length >= 5) {
          lines.push(`Disk: ${row[2]} used of ${row[1]} (${row[4]} full)`);
        }
      } catch {
        // Disk info is optional.
      }
    }
    return textResult(lines.join("\n"));
  }
);

server.registerTool(
  "list_running_apps",
  { description: "List the applications currently running on the user's machine (visible apps only)." },
  async () => {
    if (process.platform === "darwin") {
      const script = 'tell application "System Events" to get name of (processes where background only is false)';
      const out = await run("osascript", ["-e", script]);
      return textResult(`Running apps: ${out}`);
    }
    const out = await run("ps", ["-eo", "comm"], 8000);
    const names = [...new Set(out.split("\n").map((line) => path.basename(line.trim())).filter(Boolean))];
    return textResult(`Running processes (sample): ${names.slice(0, 40).join(", ")}`);
  }
);

server.registerTool(
  "search_files",
  {
    description:
      "Find files on the user's machine by name. Searches the home directory tree (Documents, Desktop, Downloads) and returns matching paths.",
    inputSchema: {
      name: z.string().describe("Part of the file name to search for, e.g. 'resume' or 'report.pdf'."),
      limit: z.number().optional().describe("Maximum results, default 10.")
    }
  },
  async ({ name, limit }) => {
    const max = Math.min(Math.max(Number(limit) || 10, 1), 25);
    if (process.platform === "darwin") {
      try {
        const out = await run("mdfind", ["-name", name, "-onlyin", os.homedir()], 10000);
        const hits = out.split("\n").filter(Boolean).slice(0, max);
        return textResult(hits.length ? `Found ${hits.length} file(s):\n${hits.join("\n")}` : `No files matching "${name}".`);
      } catch {
        // Spotlight may be disabled; fall through to manual walk.
      }
    }
    const roots = ["Documents", "Desktop", "Downloads"].map((dir) => path.join(os.homedir(), dir));
    const hits = [];
    const needle = name.toLowerCase();
    const walk = (dir, depth) => {
      if (depth > 4 || hits.length >= max) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= max) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.toLowerCase().includes(needle)) {
          hits.push(full);
        }
      }
    };
    for (const root of roots) walk(root, 0);
    return textResult(hits.length ? `Found ${hits.length} file(s):\n${hits.join("\n")}` : `No files matching "${name}".`);
  }
);

function loadNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTES_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

server.registerTool(
  "save_note",
  {
    description: "Save a quick local note for the user (persisted on-device, survives restarts).",
    inputSchema: { text: z.string().describe("The note text to save.") }
  },
  async ({ text }) => {
    const notes = loadNotes();
    notes.push({ id: `note-${Date.now()}`, text, at: new Date().toISOString() });
    fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2), "utf-8");
    return textResult(`Saved note ${notes.length}: "${text.slice(0, 80)}"`);
  }
);

server.registerTool(
  "list_notes",
  { description: "List the user's saved local notes, newest first." },
  async () => {
    const notes = loadNotes().slice(-15).reverse();
    if (!notes.length) {
      return textResult("No notes saved yet.");
    }
    return textResult(notes.map((note, i) => `${i + 1}. [${note.at.slice(0, 16)}] ${note.text}`).join("\n"));
  }
);

server.registerTool(
  "list_directory",
  {
    description: "List files and folders in a directory under the user's home sandbox.",
    inputSchema: {
      path: z.string().describe("Directory path, default home directory."),
      limit: z.number().optional().describe("Max entries, default 30.")
    }
  },
  async ({ path: dirPath, limit }) => {
    const resolved = resolveSandboxPath(dirPath || ".");
    const max = Math.min(Math.max(Number(limit) || 30, 5), 100);
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).slice(0, max);
    const lines = entries.map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`);
    return textResult(lines.length ? lines.join("\n") : "(empty directory)");
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
