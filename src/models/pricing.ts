/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ImageQuality, type ImageUsage } from "../providers/types";
import { outputSizeFor } from "./geometry";
import { type ExplicitQuality, type ModelSpec } from "./types";

// Flexible-size output estimates use the quality factors below and this USD token rate.
export const GPT_IMAGE_2_OUTPUT_USD_PER_MILLION = 30;

export const OPENAI_TOKEN_RATES: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  "openai:gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "openai:gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
};

export function imageOutputTokens(size: string, qualityFactor: number): number | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (
    !width ||
    !height ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    pixels < 655360 ||
    pixels > 8294400 ||
    longEdge > 3840 ||
    longEdge > shortEdge * 3
  ) {
    return null;
  }

  // Match the pricing calculator: round exact half ties to the nearest even integer.
  const shortAxis = qualityFactor * shortEdge / longEdge;
  const floor = Math.floor(shortAxis);
  const shortAxisFactor = shortAxis - floor === 0.5 ? floor + floor % 2 : Math.round(shortAxis);
  const numerator = qualityFactor * shortAxisFactor * (2000000 + pixels);
  return Math.floor((numerator + 3999999) / 4000000);
}

export function imageOutputUSD(size: string, qualityFactor: number): number | null {
  const tokens = imageOutputTokens(size, qualityFactor);
  return tokens === null ? null : (tokens * GPT_IMAGE_2_OUTPUT_USD_PER_MILLION) / 1000000;
}

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
  quality: ImageQuality
): number | null {
  const output = estimatedUSD(spec, token, outputSize, quality);
  return output === null ? null : output + INPUT_OVERHEAD_USD;
}

// Use response token counts when enough usage data and model rates are available.
export function actualUsageUSD(spec: ModelSpec, usage: ImageUsage): number | null {
  const rates = OPENAI_TOKEN_RATES[spec.id];
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
  return usd;
}
