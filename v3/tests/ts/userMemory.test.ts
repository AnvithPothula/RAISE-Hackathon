import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { UserMemoryStore } from "../../src/main/userMemory";

describe("UserMemoryStore", () => {
  it("stores durable user facts and returns prompt summary text", () => {
    const store = new UserMemoryStore(path.join(os.tmpdir(), `test-memory-${Date.now()}-${Math.random()}.json`));

    const item = store.remember({
      text: "The user is an engineer.",
      category: "profile",
      source: "user statement"
    });

    expect(item.category).toBe("profile");
    expect(store.summary()).toContain("profile: The user is an engineer.");
  });

  it("forgets memories by id", () => {
    const store = new UserMemoryStore(path.join(os.tmpdir(), `test-memory-${Date.now()}-${Math.random()}.json`));
    const item = store.remember({ text: "The user prefers short answers.", category: "preference" });

    expect(store.forget({ id: item.id })?.text).toBe("The user prefers short answers.");
    expect(store.list()).toEqual([]);
  });
});
