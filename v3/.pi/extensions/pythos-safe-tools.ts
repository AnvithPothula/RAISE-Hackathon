import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs/promises";
import path from "node:path";

const NOTE_FILE = ".pythos-notes.json";

type Note = {
  text: string;
  createdAt: string;
};

export default function pythosSafeTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pythos_time",
    label: "Time",
    description: "Return the current local date and time.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return textResult(new Date().toString());
    }
  });

  pi.registerTool({
    name: "pythos_calculator",
    label: "Calculator",
    description: "Evaluate a simple arithmetic expression using only numbers and arithmetic operators.",
    parameters: Type.Object({
      expression: Type.String({ description: "Arithmetic expression, for example 12 * (4 + 2)." })
    }),
    async execute(_toolCallId, params) {
      const expression = String(params.expression ?? "");
      const result = calculate(expression);
      return textResult(`${expression} = ${result}`);
    }
  });

  pi.registerTool({
    name: "pythos_app_status",
    label: "App Status",
    description: "Return the known Pythos v3 local runtime status and safety boundaries.",
    parameters: Type.Object({}),
    async execute() {
      return textResult(
        [
          "Pythos v3 is running through the Electron bridge.",
          "Audio, ASR, and TTS are handled by the Python worker.",
          "Safe tools are enabled. Broad shell and computer-control tools are intentionally not exposed here."
        ].join("\n")
      );
    }
  });

  pi.registerTool({
    name: "pythos_note",
    label: "Note",
    description: "Append or read short local assistant memory notes for the current project.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list")]),
      text: Type.Optional(Type.String({ description: "Note text when action is add." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const notesPath = path.join(ctx.cwd, NOTE_FILE);
      const notes = await readNotes(notesPath);
      if (params.action === "add") {
        const noteText = String(params.text ?? "").trim();
        if (!noteText) {
          return textResult("No note text was provided.");
        }
        notes.push({ text: noteText, createdAt: new Date().toISOString() });
        await fs.writeFile(notesPath, JSON.stringify(notes, null, 2), "utf-8");
        return textResult("Note saved.");
      }

      if (notes.length === 0) {
        return textResult("No notes saved yet.");
      }
      return textResult(notes.map((note, index) => `${index + 1}. ${note.text}`).join("\n"));
    }
  });

  pi.registerTool({
    name: "pythos_web_search",
    label: "Web Search",
    description:
      "Search the web through Ollama Cloud web_search when PYTHOS_WEB_SEARCH_KEY is configured.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Maximum results, default 3." }))
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.PYTHOS_WEB_SEARCH_KEY;
      if (!apiKey) {
        return textResult("Web search is not configured. Set PYTHOS_WEB_SEARCH_KEY to enable it.");
      }

      const response = await fetch("https://ollama.com/api/web_search", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          query: String(params.query ?? ""),
          recency: 365,
          domains: null
        })
      });

      if (!response.ok) {
        return textResult(`Search failed with HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const maxResults = Math.max(1, Math.min(Number(params.maxResults ?? 3), 5));
      const results = (payload.results ?? []).slice(0, maxResults);
      if (results.length === 0) {
        return textResult("No search results found.");
      }

      return textResult(
        results
          .map((result, index) => {
            const content = (result.content ?? "").split(".")[0];
            return `${index + 1}. ${result.title ?? "Untitled"}\n${result.url ?? ""}\n${content}`;
          })
          .join("\n\n")
      );
    }
  });
}

function textResult(text: string) {
  return {
    content: [{ type: "text", text }],
    details: {}
  };
}

function calculate(expression: string): number {
  const clean = expression.trim();
  if (!/^[\d\s.+\-*/()%]+$/.test(clean)) {
    throw new Error("Only numbers, spaces, parentheses, decimals, and arithmetic operators are allowed.");
  }
  const value = Function(`"use strict"; return (${clean});`)() as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expression did not produce a finite number.");
  }
  return value;
}

async function readNotes(notesPath: string): Promise<Note[]> {
  try {
    const raw = await fs.readFile(notesPath, "utf-8");
    const parsed = JSON.parse(raw) as Note[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
