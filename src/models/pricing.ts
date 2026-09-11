/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ImageQuality, type ImageUsage } from "../providers/types";
import { outputSizeFor } from "./geometry";
import { type ExplicitQuality, type ModelSpec, type ModelSettings } from "./types";

import { imageOutputUSD } from "../providers/openai/pricing";
// Compatibility exports; implementation belongs to the provider.
export { OPENAI_TOKEN_RATES, GPT_IMAGE_2_OUTPUT_USD_PER_MILLION, imageOutputTokens, imageOutputUSD } from "../providers/openai/pricing";

export function qualityPriceUSD(spec: ModelSpec, outputSize: string | null, quality: ExplicitQuality): number | null {
  if (!outputSize) return null;
  const factor = spec.outputQualityFactors?.[quality];
  if (factor !== undefined) return imageOutputUSD(outputSize, factor);
  return spec.qualityPrices?.[quality]?.[outputSize] ?? null;
}

export function outputPriceRangeUSD(
  spec: ModelSpec,
  token: string,
  outputSize: string | null,
  ratio = "1:1"
): [number, number] | null {
  const size = outputSize || outputSizeFor(spec, token, ratio);
  const low = qualityPriceUSD(spec, size, "low");
  const high = qualityPriceUSD(spec, size, spec.outputQualityFactors?.max ? "max" : "high");
  if (low !== null && high !== null) return [low, high];
  return spec.prices?.[token] || null;
}

// Use a priced explicit quality or fall back to the output price range midpoint.
export function estimatedUSD(
  spec: ModelSpec,
  token: string,
  outputSize?: string,
  quality: ImageQuality = "auto"
): number | null {
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, outputSize || outputSizeFor(spec, token, "1:1"), quality);
    if (exact !== null) return exact;
  }
  const range = outputPriceRangeUSD(spec, token, outputSize || null);
  if (!range) return null;
  return (range[0] + range[1]) / 2;
}

// One flat USD overhead per generation request for all text and image inputs.
export const INPUT_OVERHEAD_USD = 0.01;

export function estimatedTotalUSD(
  spec: ModelSpec,
  token: string,
  outputSize: string | undefined,
  quality: ImageQuality,
  settings?: ModelSettings
): number | null {
  if (spec.estimateCost) return validCost(spec.estimateCost(settings || { version: spec.settingsVersion ?? 1, resolution: token, quality, ratio: "1:1", options: {} }, outputSize));
  const output = estimatedUSD(spec, token, outputSize, quality);
  return output === null ? null : output + INPUT_OVERHEAD_USD;
}

// Use response token counts when enough usage data and model rates are available.
export function actualUsageUSD(spec: ModelSpec, usage: ImageUsage): number | null {
  if (spec.actualCost) return validCost(spec.actualCost(usage));
  const rates = spec.tokenRates;
  if (!rates) return null;
  const outputTokens = usage.outputTokens;
  if (outputTokens === undefined) return null;
  const inputImageTokens = usage.inputImageTokens ?? 0;
  const inputTextTokens =
    usage.inputTextTokens ??
    (usage.inputTokens === undefined ? undefined : Math.max(0, usage.inputTokens - inputImageTokens));
  if (inputTextTokens === undefined) return null;
  const usd =
    (inputTextTokens * rates.textInput + inputImageTokens * rates.imageInput + outputTokens * rates.imageOutput) /
    1000000;
  return validCost(usd);
}

export function validCost(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
