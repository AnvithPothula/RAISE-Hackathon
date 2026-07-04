import fs from "node:fs";
import path from "node:path";
import { appRoot } from "./config.js";

export type UserMemoryCategory = "profile" | "preference" | "location" | "work" | "tool" | "other";

export type UserMemoryItem = {
  id: string;
  text: string;
  category: UserMemoryCategory;
  createdAt: string;
  updatedAt: string;
  source?: string;
};

type UserMemoryFile = {
  version: 1;
  items: UserMemoryItem[];
};

export type UserMemoryService = {
  remember: (input: { text: string; category?: string | null; source?: string | null }) => UserMemoryItem;
  forget: (input: { id?: string | null; text?: string | null }) => UserMemoryItem | null;
  list: () => UserMemoryItem[];
  summary: () => string;
};

const defaultMemoryPath = path.join(appRoot, ".pythos-memory.json");

export class UserMemoryStore implements UserMemoryService {
  constructor(private readonly filePath = defaultMemoryPath) {}

  remember(input: { text: string; category?: string | null; source?: string | null }): UserMemoryItem {
    const text = normalizeMemoryText(input.text);
    if (!text) {
      throw new Error("Missing memory text.");
    }

    const file = this.readFile();
    const category = normalizeCategory(input.category);
    const now = new Date().toISOString();
    const existing = findSimilarMemory(file.items, text);
    if (existing) {
      existing.text = text;
      existing.category = category;
      existing.updatedAt = now;
      existing.source = input.source?.trim() || existing.source;
      this.writeFile(file);
      return existing;
    }

    const item: UserMemoryItem = {
      id: `mem-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`,
      text,
      category,
      createdAt: now,
      updatedAt: now,
      source: input.source?.trim() || undefined
    };
    file.items.push(item);
    file.items = file.items.slice(-80);
    this.writeFile(file);
    return item;
  }

  forget(input: { id?: string | null; text?: string | null }): UserMemoryItem | null {
    const file = this.readFile();
    const text = normalizeMemoryText(input.text ?? "");
    const index = file.items.findIndex(
      (item) => item.id === input.id || (text.length > 0 && item.text.toLowerCase() === text.toLowerCase())
    );
    if (index < 0) {
      return null;
    }
    const [removed] = file.items.splice(index, 1);
    this.writeFile(file);
    return removed ?? null;
  }

  list(): UserMemoryItem[] {
    return [...this.readFile().items];
  }

  summary(): string {
    const items = this.list();
    if (!items.length) {
      return "";
    }
    return items.map((item) => `- ${item.category}: ${item.text}`).join("\n");
  }

  private readFile(): UserMemoryFile {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, items: [] };
    }
    const payload = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<UserMemoryFile>;
    const items = Array.isArray(payload.items) ? payload.items.filter(isMemoryItem) : [];
    return { version: 1, items };
  }

  private writeFile(file: UserMemoryFile): void {
    fs.writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  }
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeCategory(value: string | null | undefined): UserMemoryCategory {
  const normalized = String(value ?? "other").toLowerCase();
  if (["profile", "preference", "location", "work", "tool", "other"].includes(normalized)) {
    return normalized as UserMemoryCategory;
  }
  return "other";
}

function findSimilarMemory(items: UserMemoryItem[], text: string): UserMemoryItem | null {
  const normalized = text.toLowerCase();
  return items.find((item) => item.text.toLowerCase() === normalized) ?? null;
}

function isMemoryItem(value: unknown): value is UserMemoryItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      "text" in value &&
      typeof value.id === "string" &&
      typeof value.text === "string"
  );
}
