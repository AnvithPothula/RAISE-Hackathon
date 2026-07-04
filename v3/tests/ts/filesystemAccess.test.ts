import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFolderCandidates, createFilesystemAccess, parseFolderTarget } from "../../src/main/filesystemAccess.js";
import type { McpManager } from "../../src/main/mcpManager.js";

function mockMcp(overrides: Partial<McpManager> = {}): McpManager {
  return {
    isServerConnected: () => false,
    callServerTool: async () => ({ text: "", isError: true }),
    ...overrides
  } as McpManager;
}

describe("parseFolderTarget", () => {
  it("parses nested folder descriptions", () => {
    expect(parseFolderTarget("GitHub folder, which is in my documents")).toEqual(["Documents/GitHub"]);
  });

  it("maps icloud drive to the macOS cloud docs path", () => {
    const [resolved] = parseFolderTarget("iCloud Drive");
    expect(resolved).toContain("com~apple~CloudDocs");
  });
});
describe("buildFolderCandidates", () => {
  it("maps downloads to the allowed home root", () => {
    const home = os.homedir();
    const candidates = buildFolderCandidates("downloads", [home]);
    expect(candidates).toContain(path.join(home, "Downloads"));
  });
});

describe("createFilesystemAccess", () => {
  it("resolves folders through filesystem MCP get_file_info", async () => {
    const home = os.homedir();
    const target = path.join(home, "Downloads");
    const access = createFilesystemAccess(
      mockMcp({
        isServerConnected: (server) => server === "filesystem",
        callServerTool: async (_server, tool, args) => {
          if (tool === "list_allowed_directories") {
            return { text: home, isError: false };
          }
          if (tool === "get_file_info" && args.path === target) {
            return { text: "type: directory", isError: false };
          }
          return { text: "not found", isError: true };
        }
      })
    );

    const resolved = await access.resolveFolder("downloads");
    expect(resolved).toEqual({ ok: true, path: target });
  });

  it("reports missing folders honestly", async () => {
    const home = os.homedir();
    const access = createFilesystemAccess(
      mockMcp({
        isServerConnected: (server) => server === "filesystem",
        callServerTool: async (_server, tool) => {
          if (tool === "list_allowed_directories") {
            return { text: home, isError: false };
          }
          return { text: "ENOENT", isError: true };
        }
      })
    );

    const resolved = await access.resolveFolder("definitely-not-a-real-folder-name");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.message).toContain("couldn't find");
    }
  });

  it("falls back to local disk when MCP get_file_info fails", async () => {
    const home = os.homedir();
    const target = path.join(home, "Downloads");
    if (!fs.existsSync(target)) {
      return;
    }

    const access = createFilesystemAccess(
      mockMcp({
        isServerConnected: (server) => server === "filesystem",
        callServerTool: async (_server, tool) => {
          if (tool === "list_allowed_directories") {
            return { text: home, isError: false };
          }
          return { text: "ENOENT", isError: true };
        }
      })
    );

    const resolved = await access.resolveFolder("downloads");
    expect(resolved).toEqual({ ok: true, path: target });
  });
});
