import { describe, expect, it } from "vitest";
import {
  applyEngineVariant,
  isMlxCapableHost,
  orderModelCandidates,
  resolveVariantModel,
  stripEngineVariant
} from "../../src/shared/modelVariant.js";
import type { AppConfig } from "../../src/shared/types.js";

const APPLE_SILICON = { platform: "darwin", arch: "arm64" };
const WINDOWS_X64 = { platform: "win32", arch: "x64" };

function config(overrides: {
  model?: string;
  lowResourceModel?: string;
  lowResourceMode?: boolean;
  engineVariant?: "standard" | "mlx";
}): Pick<AppConfig, "ollama" | "python"> {
  return {
    ollama: {
      model: overrides.model ?? "gemma4:12b",
      lowResourceModel: overrides.lowResourceModel ?? "gemma4:e2b",
      engineVariant: overrides.engineVariant
    },
    python: { workerModule: "pythos.worker", lowResourceMode: overrides.lowResourceMode ?? false }
  };
}

describe("applyEngineVariant", () => {
  it("appends the -mlx suffix for the mlx variant", () => {
    expect(applyEngineVariant("gemma4:12b", "mlx")).toBe("gemma4:12b-mlx");
  });

  it("is idempotent for tags that already carry the suffix", () => {
    expect(applyEngineVariant("gemma4:12b-mlx", "mlx")).toBe("gemma4:12b-mlx");
  });

  it("returns the tag unchanged for the standard variant", () => {
    expect(applyEngineVariant("gemma4:12b", "standard")).toBe("gemma4:12b");
    expect(applyEngineVariant("gemma4:12b", undefined)).toBe("gemma4:12b");
  });

  it("round-trips with stripEngineVariant", () => {
    expect(stripEngineVariant(applyEngineVariant("gemma4:e2b", "mlx"))).toBe("gemma4:e2b");
    expect(stripEngineVariant("gemma4:e2b")).toBe("gemma4:e2b");
  });
});

describe("isMlxCapableHost", () => {
  it("accepts Apple Silicon and rejects everything else", () => {
    expect(isMlxCapableHost(APPLE_SILICON)).toBe(true);
    expect(isMlxCapableHost(WINDOWS_X64)).toBe(false);
    expect(isMlxCapableHost({ platform: "darwin", arch: "x64" })).toBe(false);
    expect(isMlxCapableHost({ platform: "linux", arch: "arm64" })).toBe(false);
  });
});

describe("resolveVariantModel", () => {
  it("serves the MLX tag on Apple Silicon when requested", () => {
    expect(resolveVariantModel("gemma4:12b", "mlx", APPLE_SILICON)).toBe("gemma4:12b-mlx");
  });

  it("silently keeps the standard tag on non-Apple-Silicon hosts", () => {
    expect(resolveVariantModel("gemma4:12b", "mlx", WINDOWS_X64)).toBe("gemma4:12b");
  });
});

describe("orderModelCandidates", () => {
  it("prefers the MLX build, then degrades to standard, on Apple Silicon", () => {
    const candidates = orderModelCandidates(
      config({ engineVariant: "mlx" }),
      APPLE_SILICON,
      "gemma4:12b"
    );
    expect(candidates).toEqual(["gemma4:12b-mlx", "gemma4:12b"]);
  });

  it("covers low-resource mode with MLX: variant, base, full model, full variant", () => {
    const candidates = orderModelCandidates(
      config({ engineVariant: "mlx", lowResourceMode: true }),
      APPLE_SILICON,
      "gemma4:12b"
    );
    expect(candidates).toEqual(["gemma4:e2b-mlx", "gemma4:e2b", "gemma4:12b", "gemma4:12b-mlx"]);
  });

  it("never proposes MLX tags on hosts that cannot run them", () => {
    const candidates = orderModelCandidates(
      config({ engineVariant: "mlx", lowResourceMode: true }),
      WINDOWS_X64,
      "gemma4:12b"
    );
    expect(candidates).toEqual(["gemma4:e2b", "gemma4:12b"]);
  });

  it("keeps the plain low-resource ordering without a variant", () => {
    const candidates = orderModelCandidates(
      config({ lowResourceMode: true }),
      APPLE_SILICON,
      "gemma4:12b"
    );
    expect(candidates).toEqual(["gemma4:e2b", "gemma4:12b"]);
  });

  it("falls back to the built-in default when config is missing", () => {
    expect(orderModelCandidates(undefined, APPLE_SILICON, "gemma4:12b")).toEqual(["gemma4:12b"]);
  });
});
