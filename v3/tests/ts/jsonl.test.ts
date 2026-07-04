import { describe, expect, it } from "vitest";
import { JsonlBuffer } from "../../src/main/jsonl";

describe("JsonlBuffer", () => {
  it("parses complete json lines", () => {
    const buffer = new JsonlBuffer();

    expect(buffer.push('{"type":"one"}\n{"type":"two"}\n')).toEqual([
      { type: "one" },
      { type: "two" }
    ]);
  });

  it("keeps partial lines until completed", () => {
    const buffer = new JsonlBuffer();

    expect(buffer.push('{"type":"one"')).toEqual([]);
    expect(buffer.push("}\n")).toEqual([{ type: "one" }]);
  });
});
