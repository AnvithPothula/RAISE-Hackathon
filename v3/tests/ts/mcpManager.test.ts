import { describe, expect, it } from "vitest";
import { buildMcpToolName, sanitizeJsonSchema } from "../../src/main/mcpManager";

describe("buildMcpToolName", () => {
  it("namespaces the tool under the server with an mcp prefix", () => {
    expect(buildMcpToolName("filesystem", "read_file")).toBe("mcp_filesystem_read_file");
  });

  it("normalizes non-alphanumeric characters to single underscores", () => {
    expect(buildMcpToolName("My Server!", "list-dir.contents")).toBe("mcp_my_server_list_dir_contents");
  });

  it("stays within the 64 character Gemini function-name limit", () => {
    const name = buildMcpToolName("a-very-long-server-name-here", "an-equally-long-tool-name-value-goes-here-too");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("mcp_")).toBe(true);
  });

  it("falls back to a safe name when parts are empty", () => {
    expect(buildMcpToolName("", "")).toBe("mcp_tool");
  });
});

describe("sanitizeJsonSchema", () => {
  it("keeps supported keywords and drops unsupported ones", () => {
    const cleaned = sanitizeJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "A path" },
        depth: { type: "integer" }
      },
      required: ["path"]
    });

    expect(cleaned).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "A path" },
        depth: { type: "integer" }
      },
      required: ["path"]
    });
  });

  it("collapses a union type array to a single non-null type", () => {
    const cleaned = sanitizeJsonSchema({ type: ["string", "null"] });
    expect(cleaned).toEqual({ type: "string" });
  });

  it("defaults to an empty object schema when no type is present", () => {
    expect(sanitizeJsonSchema({})).toEqual({ type: "object", properties: {} });
  });

  it("returns undefined for non-object schemas", () => {
    expect(sanitizeJsonSchema(null)).toBeUndefined();
    expect(sanitizeJsonSchema("string")).toBeUndefined();
  });

  it("recursively cleans array item schemas", () => {
    const cleaned = sanitizeJsonSchema({
      type: "array",
      items: { type: "object", additionalProperties: true, properties: { id: { type: "string" } } }
    });
    expect(cleaned).toEqual({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } } }
    });
  });
});
