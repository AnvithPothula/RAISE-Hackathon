export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class JsonlBuffer {
  private buffer = "";

  push(chunk: string): JsonValue[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    const values: JsonValue[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      values.push(JSON.parse(trimmed) as JsonValue);
    }
    return values;
  }
}
