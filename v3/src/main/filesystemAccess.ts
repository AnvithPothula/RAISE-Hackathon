import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpManager, McpToolResult } from "./mcpManager.js";

const FILESYSTEM_SERVER = "filesystem";
const SYSTEM_SERVER = "system";

const HOME_FOLDER_ALIASES: Record<string, string> = {
  downloads: "Downloads",
  download: "Downloads",
  desktop: "Desktop",
  documents: "Documents",
  document: "Documents",
  pictures: "Pictures",
  photos: "Pictures",
  music: "Music",
  movies: "Movies",
  home: "."
};

const SPECIAL_FOLDER_PATHS: Record<string, string> = {
  icloud: path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs"),
  "icloud drive": path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs")
};

const KNOWN_HOME_FOLDER_KEYS = new Set([
  ...Object.keys(HOME_FOLDER_ALIASES),
  ...Object.keys(SPECIAL_FOLDER_PATHS)
]);

export type FolderResolveResult = { ok: true; path: string } | { ok: false; message: string };

export type FolderListingResult =
  | { ok: true; path: string; lines: string[]; truncated: boolean }
  | { ok: false; message: string };

export type FilesystemAccess = {
  resolveFolder: (input: string) => Promise<FolderResolveResult>;
  listFolderEntries: (input: string, limit?: number) => Promise<FolderListingResult>;
};

export function createFilesystemAccess(mcp: McpManager): FilesystemAccess {
  let allowedDirectoriesCache: string[] | null = null;

  async function getAllowedDirectories(): Promise<string[]> {
    if (allowedDirectoriesCache) {
      return allowedDirectoriesCache;
    }
    if (mcp.isServerConnected(FILESYSTEM_SERVER)) {
      try {
        const result = await mcp.callServerTool(FILESYSTEM_SERVER, "list_allowed_directories", {});
        if (!result.isError) {
          allowedDirectoriesCache = parseAllowedDirectories(result.text);
        }
      } catch {
        // Fall back to the home directory below.
      }
    }
    if (!allowedDirectoriesCache?.length) {
      allowedDirectoriesCache = [os.homedir()];
    }
    return allowedDirectoriesCache;
  }

  async function verifyDirectory(folderPath: string, allowedRoots: string[]): Promise<boolean> {
    const resolvedPath = path.resolve(folderPath);
    const withinAllowed = isPathWithinAllowedRoots(resolvedPath, allowedRoots);
    const existsLocally = localDirectoryExists(resolvedPath);

    if (mcp.isServerConnected(FILESYSTEM_SERVER)) {
      try {
        const result = await mcp.callServerTool(FILESYSTEM_SERVER, "get_file_info", { path: resolvedPath });
        if (!result.isError && parseIsDirectory(result)) {
          return true;
        }
        try {
          const listed = await mcp.callServerTool(FILESYSTEM_SERVER, "list_directory", { path: resolvedPath });
          if (!listed.isError) {
            return true;
          }
        } catch {
          // Fall through to local verification.
        }
      } catch {
        // Fall through to local verification.
      }
    } else if (mcp.isServerConnected(SYSTEM_SERVER)) {
      try {
        const result = await mcp.callServerTool(SYSTEM_SERVER, "list_directory", {
          path: resolvedPath,
          limit: 1
        });
        if (!result.isError) {
          return true;
        }
      } catch {
        // Fall through to local verification.
      }
    }

    return existsLocally && withinAllowed;
  }

  async function resolveFolder(input: string): Promise<FolderResolveResult> {
    const trimmed = String(input ?? "").trim();
    if (!trimmed) {
      return { ok: false, message: "Missing folder name." };
    }

    const allowed = await getAllowedDirectories();
    const candidates = buildFolderCandidates(trimmed, allowed);
    for (const candidate of candidates) {
      if (await verifyDirectory(candidate, allowed)) {
        return { ok: true, path: path.resolve(candidate) };
      }
    }

    return {
      ok: false,
      message: `I couldn't find "${trimmed}" in the folders I can access. Try a name like Downloads or an absolute path inside your home directory.`
    };
  }

  async function listFolderEntries(input: string, limit = 30): Promise<FolderListingResult> {
    const resolved = await resolveFolder(input);
    if (!resolved.ok) {
      return resolved;
    }

    const max = Math.min(Math.max(limit, 5), 100);
    if (mcp.isServerConnected(FILESYSTEM_SERVER)) {
      try {
        const result = await mcp.callServerTool(FILESYSTEM_SERVER, "list_directory", { path: resolved.path });
        if (!result.isError) {
          const lines = parseDirectoryListing(result.text).slice(0, max);
          return {
            ok: true,
            path: resolved.path,
            lines,
            truncated: lines.length >= max
          };
        }
      } catch {
        // Fall through to local listing.
      }
    }

    if (mcp.isServerConnected(SYSTEM_SERVER)) {
      try {
        const result = await mcp.callServerTool(SYSTEM_SERVER, "list_directory", {
          path: resolved.path,
          limit: max
        });
        if (!result.isError) {
          const lines = parseDirectoryListing(result.text).slice(0, max);
          return {
            ok: true,
            path: resolved.path,
            lines,
            truncated: lines.length >= max
          };
        }
      } catch {
        // Fall through to local listing.
      }
    }

    try {
      const entries = fs.readdirSync(resolved.path, { withFileTypes: true }).slice(0, max);
      const lines = entries.map((entry) => `${entry.isDirectory() ? "folder" : "file"}: ${entry.name}`);
      return {
        ok: true,
        path: resolved.path,
        lines,
        truncated: entries.length >= max
      };
    } catch (error) {
      return { ok: false, message: `I couldn't read that folder: ${String(error)}` };
    }
  }

  return { resolveFolder, listFolderEntries };
}

export function buildFolderCandidates(input: string, allowedRoots: string[]): string[] {
  const candidates = new Set<string>();
  for (const spec of parseFolderTarget(input)) {
    if (path.isAbsolute(spec)) {
      candidates.add(path.resolve(spec));
      continue;
    }
    for (const root of allowedRoots) {
      const resolvedRoot = path.resolve(expandUserPath(root));
      candidates.add(path.join(resolvedRoot, spec));
    }
    candidates.add(path.join(os.homedir(), spec));
  }

  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase().replace(/\s+(folder|directory|further)$/i, "").trim();
  const aliasSegment = HOME_FOLDER_ALIASES[normalized] ?? HOME_FOLDER_ALIASES[trimmed.toLowerCase()];
  const expanded = expandUserPath(aliasSegment ?? trimmed);

  if (path.isAbsolute(expanded)) {
    candidates.add(path.resolve(expanded));
  }

  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(expandUserPath(root));
    candidates.add(path.join(resolvedRoot, expanded));
    candidates.add(path.join(resolvedRoot, trimmed));
    if (aliasSegment) {
      candidates.add(aliasSegment === "." ? resolvedRoot : path.join(resolvedRoot, aliasSegment));
    }
  }

  candidates.add(path.join(os.homedir(), expanded));
  candidates.add(path.join(os.homedir(), trimmed));
  if (aliasSegment && aliasSegment !== ".") {
    candidates.add(path.join(os.homedir(), aliasSegment));
  }

  return [...candidates]
    .map((value) => path.resolve(value))
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function parseFolderTarget(raw: string): string[] {
  let text = String(raw ?? "")
    .trim()
    .replace(/^(?:the|my|a|an)\s+/i, "")
    .replace(/\s+(?:folder|directory|further)$/i, "")
    .trim();
  if (!text) {
    return [];
  }

  const special = SPECIAL_FOLDER_PATHS[text.toLowerCase()];
  if (special) {
    return [special];
  }

  const whichIn = text.match(/^(.+?)(?:\s+folder)?,?\s*(?:which is )?in (?:my )?(.+)$/i);
  if (whichIn) {
    const child = cleanFolderSegment(whichIn[1]);
    const parent = resolveFolderAlias(whichIn[2]);
    return [`${parent}/${child}`];
  }

  const inMatch = text.match(/^(.+?)(?:\s+folder)?\s+in (?:my )?(.+)$/i);
  if (inMatch) {
    const child = cleanFolderSegment(inMatch[1]);
    const parent = resolveFolderAlias(inMatch[2]);
    return [`${parent}/${child}`];
  }

  const alias = resolveFolderAlias(text);
  return [alias];
}

export function looksLikeFolderOpenRequest(cleanPrompt: string, raw: string): boolean {
  if (/\b(?:desktop|application)\s+app\b/i.test(cleanPrompt)) {
    return false;
  }
  if (/\b(folder|directory|drive|further)\b/i.test(cleanPrompt)) {
    return true;
  }
  const key = raw.toLowerCase().replace(/\s+(folder|directory|further)$/i, "").trim();
  if (KNOWN_HOME_FOLDER_KEYS.has(key)) {
    return true;
  }
  if (looksLikeFolderPath(raw)) {
    return true;
  }
  if (/\bin (?:my )?(documents|downloads|desktop|pictures|photos|music|movies|home)\b/i.test(raw)) {
    return true;
  }
  if (/\bwhich is in\b/i.test(raw)) {
    return true;
  }
  if (/^(?:my )?(documents|downloads|desktop|pictures|photos|music|movies)(?:\s+folder)?$/i.test(key)) {
    return true;
  }
  return false;
}

function cleanFolderSegment(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^(?:the|my|a|an)\s+/i, "")
    .replace(/\s+(?:folder|directory|further)$/i, "")
    .trim();
}

function resolveFolderAlias(text: string): string {
  const key = text.toLowerCase().replace(/\s+(folder|directory|further)$/i, "").trim();
  const special = SPECIAL_FOLDER_PATHS[key];
  if (special) {
    return special;
  }
  const alias = HOME_FOLDER_ALIASES[key];
  if (alias) {
    return alias;
  }
  return cleanFolderSegment(text);
}

function localDirectoryExists(folderPath: string): boolean {
  try {
    return fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

function isPathWithinAllowedRoots(folderPath: string, roots: string[]): boolean {
  const resolved = path.resolve(folderPath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(expandUserPath(root));
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

function parseIsDirectory(result: McpToolResult): boolean {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    const info = result.structuredContent as Record<string, unknown>;
    if (info.isDirectory === true || info.type === "directory") {
      return true;
    }
  }

  const text = result.text ?? "";
  if (/type:\s*directory/i.test(text)) {
    return true;
  }
  if (/"isDirectory"\s*:\s*true/i.test(text) || /"type"\s*:\s*"directory"/i.test(text)) {
    return true;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.isDirectory === true || parsed.type === "directory") {
      return true;
    }
  } catch {
    // Not JSON.
  }

  return false;
}

function expandUserPath(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  return trimmed;
}

function parseAllowedDirectories(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      }
      if (parsed && typeof parsed === "object") {
        const directories = (parsed as { directories?: unknown }).directories;
        if (Array.isArray(directories)) {
          return directories.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
        }
      }
    } catch {
      // Fall through to line parsing.
    }
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .map((line) => line.replace(/^allowed directories:\s*/i, "").trim())
    .filter((line) => line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line));
}

function parseDirectoryListing(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^\[dir\]/i.test(line)) {
        return `folder: ${line.replace(/^\[dir\]\s*/i, "")}`;
      }
      if (/^\[file\]/i.test(line)) {
        return `file: ${line.replace(/^\[file\]\s*/i, "")}`;
      }
      return line;
    });
}

export function looksLikeFolderPath(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.startsWith("~/") ||
    trimmed === "~" ||
    path.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  );
}
