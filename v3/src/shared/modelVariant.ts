import type { AppConfig, EngineVariant } from "./types.js";

/**
 * Engine-variant abstraction for the local Gemma runtime (plan P2 #18).
 *
 * Ollama publishes MLX-converted builds of the Gemma 4 weights (e.g.
 * `gemma4:12b-mlx`) that run through Apple's MLX framework for noticeably
 * higher decode throughput on Apple Silicon. This module keeps that concern
 * in one pure, testable place:
 *
 * - `applyEngineVariant` maps a base tag to its variant tag.
 * - `isMlxCapableHost` gates the variant to hosts that can actually run it.
 * - `resolveVariantModel` combines both with the user's setting.
 * - `orderModelCandidates` produces the graceful-degradation order the
 *   runtime walks when picking an actually-pulled model, so enabling the
 *   toggle without having pulled the MLX tag can never break inference
 *   (zero-setup rule: the app must work with only the base model pulled).
 */

const MLX_SUFFIX = "-mlx";

export type HostInfo = {
  platform: string;
  arch: string;
};

/** MLX runs on Apple Silicon only. */
export function isMlxCapableHost(host: HostInfo): boolean {
  return host.platform === "darwin" && host.arch === "arm64";
}

/** Append the variant suffix to an Ollama tag (idempotent, empty-safe). */
export function applyEngineVariant(model: string, variant: EngineVariant | undefined): string {
  if (variant !== "mlx") {
    return model;
  }
  const trimmed = model.trim();
  if (!trimmed || trimmed.endsWith(MLX_SUFFIX)) {
    return trimmed;
  }
  return `${trimmed}${MLX_SUFFIX}`;
}

/** Strip the variant suffix, recovering the base tag. */
export function stripEngineVariant(model: string): string {
  return model.endsWith(MLX_SUFFIX) ? model.slice(0, -MLX_SUFFIX.length) : model;
}

/**
 * The model tag the user's settings request, honoring the MLX toggle only on
 * hosts that can run it.
 */
export function resolveVariantModel(
  baseModel: string,
  variant: EngineVariant | undefined,
  host: HostInfo
): string {
  if (variant === "mlx" && isMlxCapableHost(host)) {
    return applyEngineVariant(baseModel, "mlx");
  }
  return baseModel;
}

/**
 * Preference-ordered model candidates for the runtime to try against the
 * list of actually-pulled tags:
 *
 * 1. the preferred model with the engine variant applied (when eligible),
 * 2. the preferred model's standard build,
 * 3. the configured full model (covers low-resource mode pointing at a
 *    model that was never pulled),
 * 4. the configured full model's variant build (an MLX-only pull still works).
 */
export function orderModelCandidates(
  config: Pick<AppConfig, "ollama" | "python"> | undefined,
  host: HostInfo,
  fallbackModel: string
): string[] {
  const variant = config?.ollama?.engineVariant;
  const fullModel = config?.ollama?.model || fallbackModel;
  const lowResource = Boolean(config?.python?.lowResourceMode) && Boolean(config?.ollama?.lowResourceModel);
  const preferredBase = lowResource ? String(config?.ollama?.lowResourceModel) : fullModel;

  const candidates = [
    resolveVariantModel(preferredBase, variant, host),
    preferredBase,
    fullModel,
    resolveVariantModel(fullModel, variant, host)
  ];
  return [...new Set(candidates.filter(Boolean))];
}
