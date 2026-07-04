import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { appRoot } from "./config.js";

const execFileAsync = promisify(execFile);
const MAX_SKILLS = 24;
const MAX_DESCRIPTION_LENGTH = 420;
const MAX_INSTRUCTIONS_LENGTH = 1400;
const MAX_OUTPUT_LENGTH = 4000;

export type DiscoveredSkill = {
  name: string;
  description: string;
  root: string;
  source: "app" | "user";
  scripts: string[];
  instructions: string;
};

export type SkillScriptArgs = {
  skillName?: string | null;
  script?: string | null;
  args?: unknown;
};

export type SkillScriptResult = {
  name: "skill_script";
  text: string;
  skillName?: string;
  script?: string;
};

export function buildDynamicSkillPrompt(): string {
  const skills = discoverSkills();
  if (!skills.length) {
    return "";
  }

  const lines = [
    "Dynamic skills and local script tools currently discovered:",
    ...skills.map((skill) => {
      const scriptText = skill.scripts.length ? ` Scripts: ${skill.scripts.join(", ")}.` : "";
      const instructions = skill.instructions ? ` Guidance: ${skill.instructions}` : "";
      return `- ${skill.name}: ${skill.description}${scriptText}${instructions}`;
    }),
    "When a user request matches a discovered skill with a script, decide the intended operation from the user's meaning, then call run_skill_script with the skill name, script path, and explicit command arguments. Do not pass the user's raw sentence when a command is available.",
    "This catalog is rebuilt at request time, so newly added skills become available without editing this prompt."
  ];
  return lines.join("\n");
}

export function discoverSkills(): DiscoveredSkill[] {
  const roots: Array<{ dir: string; source: DiscoveredSkill["source"] }> = [
    { dir: path.join(appRoot, ".pi", "skills"), source: "app" },
    { dir: path.join(os.homedir(), ".codex", "skills"), source: "user" }
  ];
  const seen = new Set<string>();
  const skills: DiscoveredSkill[] = [];

  for (const root of roots) {
    for (const skillDir of listDirectories(root.dir)) {
      const skill = readSkill(skillDir, root.source);
      if (!skill || seen.has(skill.name)) {
        continue;
      }
      seen.add(skill.name);
      skills.push(skill);
      if (skills.length >= MAX_SKILLS) {
        return skills;
      }
    }
  }

  return skills;
}

export async function runSkillScript(args: SkillScriptArgs): Promise<SkillScriptResult> {
  const skillName = cleanSkillName(args.skillName ?? "");
  const script = cleanScriptPath(args.script ?? "");
  const scriptArgs = cleanScriptArgs(args.args);
  if (!skillName || !script) {
    throw new Error("run_skill_script requires skillName and script.");
  }

  const skill = discoverSkills().find((candidate) => candidate.name === skillName);
  if (!skill) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  if (!skill.scripts.includes(script)) {
    throw new Error(`Script ${script} is not listed for skill ${skillName}.`);
  }

  const scriptPath = path.resolve(skill.root, script);
  const skillRoot = path.resolve(skill.root);
  if (!scriptPath.startsWith(`${skillRoot}${path.sep}`)) {
    throw new Error("Refusing to run a script outside the skill folder.");
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Skill script does not exist: ${script}`);
  }

  const executable = scriptPath.toLowerCase().endsWith(".py") ? "python" : scriptPath;
  const execArgs = scriptPath.toLowerCase().endsWith(".py") ? [scriptPath, ...scriptArgs] : scriptArgs;
  const result = await execSkillFile(executable, execArgs, skill.root);
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(0, MAX_OUTPUT_LENGTH);
  return {
    name: "skill_script",
    skillName,
    script,
    text: text || "Skill script completed."
  };
}

async function execSkillFile(
  executable: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(executable, args, {
      cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = bufferToText(failure.stdout);
    const stderr = bufferToText(failure.stderr);
    if (stdout || stderr) {
      return { stdout, stderr };
    }
    throw error;
  }
}

function bufferToText(value: string | Buffer | undefined): string {
  if (!value) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString("utf-8") : value;
}

function readSkill(skillDir: string, source: DiscoveredSkill["source"]): DiscoveredSkill | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return null;
  }
  const raw = fs.readFileSync(skillFile, "utf-8");
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    return null;
  }
  const metadata = parseSimpleYaml(frontmatter[1]);
  const name = cleanSkillName(metadata.name ?? path.basename(skillDir));
  const description = cleanDescription(metadata.description ?? "");
  if (!name || !description) {
    return null;
  }
  return {
    name,
    description,
    root: skillDir,
    source,
    scripts: listScripts(path.join(skillDir, "scripts")),
    instructions: extractInstructions(raw)
  };
}

function parseSimpleYaml(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return values;
}

function listDirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function listScripts(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(py|js|mjs|cjs|cmd|bat|ps1)$/i.test(entry.name))
      .map((entry) => path.posix.join("scripts", entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function cleanSkillName(value: string): string {
  const name = String(value).trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : "";
}

function cleanScriptPath(value: string): string {
  const script = String(value).replaceAll("\\", "/").trim();
  if (!script || path.isAbsolute(script) || script.includes("..")) {
    return "";
  }
  return script;
}

function cleanScriptArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, 24)
    .map((item) => String(item))
    .filter((item) => item.length > 0 && item.length < 500);
}

function cleanDescription(value: string): string {
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

function extractInstructions(raw: string): string {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (line.startsWith("#")) {
        return false;
      }
      return /scripts\/|status|play|pause|resume|skip|volume|device|command|intent|tool|python/i.test(line);
    })
    .map((line) => line.replace(/^[-*]\s*/, ""));
  const priority = lines.filter((line) => /status|current|read-only|intent|command|pause|resume|skip|volume|device/i.test(line));
  const examples = lines.filter((line) => !priority.includes(line));
  const usefulLines = [...priority, ...examples].join(" ");
  return usefulLines.replace(/\s+/g, " ").trim().slice(0, MAX_INSTRUCTIONS_LENGTH);
}
