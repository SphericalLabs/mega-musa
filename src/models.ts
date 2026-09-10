/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

import { SUPPORTED_ASPECT_RATIOS, ImageQuality, ImageUsage } from "./gemini";
import { gptImage2Size } from "./openai";
import { formatMoney, formatMoneyRange } from "./currency";

type ExplicitQuality = Exclude<ImageQuality, "auto">;
type QualityPrices = Partial<Record<ExplicitQuality, Record<string, number>>>;

// The model table drives both picker options and provider request framing.

export interface ModelSpec {
  id: string; // The "openai:" prefix selects the OpenAI client.
  label: string;
  // Ascending resolution tokens; empty means aspect ratio controls size.
  imageSizes: string[];
  aspectRatios: string[];
  fixedSizes?: { ratio: number; size: string; label: string }[];
  // USD output-only ranges by resolution token; input costs are added separately.
  // Missing tiers have no estimate.
  prices?: Record<string, [number, number]>;
  // USD output prices by quality and pixel size for fixed-size models.
  qualityPrices?: QualityPrices;
  // Output-token factors for models with flexible sizes.
  outputQualityFactors?: Partial<Record<ExplicitQuality, number>>;
}

export interface OutputFrame {
  // Nearest picker label, which may approximate a flexible output's exact ratio.
  label: string;
  ratio: number;
  geminiAspect?: string;
  openaiSize?: string;
}

// Flexible-size output estimates use the quality factors below and this USD token rate.
const GPT_IMAGE_2_OUTPUT_USD_PER_MILLION = 30;
const OPENAI_TOKEN_RATES: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  "openai:gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "openai:gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
};
const GPT_IMAGE_2_QUALITY_FACTORS: Record<"low" | "medium" | "high", number> = {
  low: 16,
  medium: 48,
  high: 96,
};

const GPT_IMAGE_25_QUALITY_FACTORS = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };

const GEMINI_RATIOS = SUPPORTED_ASPECT_RATIOS.map((r) => r.label);

const OPENAI_FIXED = [
  { ratio: 1, size: "1024x1024", label: "1:1" },
  { ratio: 3 / 2, size: "1536x1024", label: "3:2" },
  { ratio: 2 / 3, size: "1024x1536", label: "2:3" },
];

export const DEFAULT_MODEL = "gemini-3-pro-image";

export const MODELS: ModelSpec[] = [
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro (2025)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // 1K and 2K share the same output price; Auto is estimated at the 1K default.
    prices: {
      auto: [0.134, 0.134],
      "1K": [0.134, 0.134],
      "2K": [0.134, 0.134],
      "4K": [0.24, 0.24],
    },
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2 (2026)",
    imageSizes: ["512px", "1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    prices: {
      auto: [0.067, 0.067],
      "512px": [0.045, 0.045],
      "1K": [0.067, 0.067],
      "2K": [0.101, 0.101],
      "4K": [0.151, 0.151],
    },
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Nano Banana (2025)",
    imageSizes: ["1K"],
    aspectRatios: GEMINI_RATIOS,
    prices: { auto: [0.039, 0.039], "1K": [0.039, 0.039] },
  },
  ...[
    { id: "openai:gpt-image-2.5-sunburst", label: "OpenAI Sunburst (2026)" },
    { id: "openai:gpt-image-2.5-flare", label: "OpenAI Flare (2026)" },
  ].map((model) => ({
    ...model,
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    outputQualityFactors: GPT_IMAGE_25_QUALITY_FACTORS,
  })),
  {
    id: "openai:gpt-image-2",
    outputQualityFactors: GPT_IMAGE_2_QUALITY_FACTORS,
    label: "OpenAI GPT Image 2 (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
  },
  {
    id: "openai:gpt-image-1.5",
    label: "OpenAI GPT Image 1.5 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
    qualityPrices: {
      low: { "1024x1024": 0.009, "1536x1024": 0.013, "1024x1536": 0.013 },
      medium: { "1024x1024": 0.034, "1536x1024": 0.05, "1024x1536": 0.05 },
      high: { "1024x1024": 0.133, "1536x1024": 0.2, "1024x1536": 0.2 },
    },
    prices: { auto: [0.133, 0.2] },
  },
  {
    id: "openai:gpt-image-1",
    label: "OpenAI GPT Image 1 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
    qualityPrices: {
      low: { "1024x1024": 0.011, "1536x1024": 0.016, "1024x1536": 0.016 },
      medium: { "1024x1024": 0.042, "1536x1024": 0.063, "1024x1536": 0.063 },
      high: { "1024x1024": 0.167, "1536x1024": 0.25, "1024x1536": 0.25 },
    },
    prices: { auto: [0.167, 0.25] },
  },
  {
    id: "openai:gpt-image-1-mini",
    label: "OpenAI GPT Image 1 mini (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
    qualityPrices: {
      low: { "1024x1024": 0.005, "1536x1024": 0.006, "1024x1536": 0.006 },
      medium: { "1024x1024": 0.011, "1536x1024": 0.015, "1024x1536": 0.015 },
      high: { "1024x1024": 0.036, "1536x1024": 0.052, "1024x1536": 0.052 },
    },
    prices: { auto: [0.036, 0.052] },
  },
];

export function modelSpec(id: string): ModelSpec {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL)!;
}

const TIER_ORDER = ["512px", "1K", "2K", "4K"];

export function resolutionLabel(token: string): string {
  if (token === "auto") return "Auto";
  // Keep the API/storage token as 512px; display it as part of the K-tier scale.
  if (token === "512px") return "0.5K";
  return token;
}

function imageOutputTokens(size: string, qualityFactor: number): number | null {
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

function imageOutputUSD(size: string, qualityFactor: number): number | null {
  const tokens = imageOutputTokens(size, qualityFactor);
  return tokens === null ? null : (tokens * GPT_IMAGE_2_OUTPUT_USD_PER_MILLION) / 1000000;
}

function gptImage2RepresentativeSize(token: string, ratio: string): string | null {
  if (token !== "1K" && token !== "2K" && token !== "4K") return null;
  const [rw, rh] = ratio.split(":").map(Number);
  if (!rw || !rh) return gptImage2Size(1000, 1000, token);
  return gptImage2Size(rw * 1000, rh * 1000, token);
}

function fixedOutputSize(spec: ModelSpec, ratio: string): string | null {
  const match = spec.fixedSizes?.find((size) => size.label === ratio);
  return match?.size || spec.fixedSizes?.[0]?.size || null;
}

function outputSizeFor(spec: ModelSpec, token: string, ratio: string): string | null {
  if (spec.outputQualityFactors) return gptImage2RepresentativeSize(token, ratio);
  return fixedOutputSize(spec, ratio);
}

function qualityPriceUSD(spec: ModelSpec, outputSize: string | null, quality: ExplicitQuality): number | null {
  if (!outputSize) return null;
  const factor = spec.outputQualityFactors?.[quality];
  if (factor !== undefined) return imageOutputUSD(outputSize, factor);
  return spec.qualityPrices?.[quality]?.[outputSize] ?? null;
}

function outputPriceRangeUSD(
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
const INPUT_OVERHEAD_USD = 0.01;

export function estimatedTotalUSD(
  spec: ModelSpec,
  token: string,
  outputSize: string | undefined,
  quality: ImageQuality
): number | null {
  const output = estimatedUSD(spec, token, outputSize, quality);
  return output === null ? null : output + INPUT_OVERHEAD_USD;
}

function priceLabel(spec: ModelSpec, token: string, ratio: string, quality: ImageQuality): string {
  const allowance = INPUT_OVERHEAD_USD;
  const size = outputSizeFor(spec, token, ratio);
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, size, quality);
    if (exact !== null) return formatMoney(exact + allowance);
  }
  const range = outputPriceRangeUSD(spec, token, size, ratio);
  if (!range) return "";
  const low = range[0] + allowance;
  const high = range[1] + allowance;
  return formatMoneyRange(low, high);
}

export function resolutionMenuLabel(
  token: string,
  spec: ModelSpec,
  ratio = "1:1",
  quality: ImageQuality = "auto"
): string {
  const label = resolutionLabel(token);
  // Show an Auto price only when there are no explicit resolution tiers. Budget
  // estimates still use Auto prices.
  if (token === "auto" && spec.imageSizes.length) return label;
  const price = priceLabel(spec, token, ratio, quality);
  return price ? `${label} / ${price}` : label;
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

// Log distance treats reciprocal changes equally: 2:1 is midway between 1:1 and 4:1.
export function nearestRatioLabel(want: string, options: string[]): string {
  if (!options.length) return "1:1";
  if (options.includes(want)) return want;
  const [ww, wh] = want.split(":").map(Number);
  if (!ww || !wh) return options[0];
  const target = Math.log(ww / wh);
  let best = options[0];
  let bestDist = Infinity;
  for (const opt of options) {
    const [ow, oh] = opt.split(":").map(Number);
    if (!ow || !oh) continue;
    const dist = Math.abs(Math.log(ow / oh) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = opt;
    }
  }
  return best;
}

// Resolve provider framing and its nearest picker label together.
export function outputFrame(
  spec: ModelSpec,
  tier: string,
  width: number,
  height: number
): OutputFrame {
  if (!spec.aspectRatios.length) {
    throw new Error(`${spec.label} has no aspect ratios in the model table.`);
  }

  const safeW = width > 0 ? width : 1;
  const safeH = height > 0 ? height : 1;

  if (spec.outputQualityFactors) {
    const openaiSize = gptImage2Size(safeW, safeH, tier === "auto" ? undefined : tier);
    const [outputW, outputH] = openaiSize.split("x").map(Number);
    const ratio = outputW / outputH;
    const label = nearestRatioLabel(`${outputW}:${outputH}`, spec.aspectRatios);
    return { label, ratio, openaiSize };
  }

  if (spec.fixedSizes?.length) {
    const cropRatio = safeW / safeH;
    const best = spec.fixedSizes.reduce((a, b) =>
      Math.abs(Math.log(b.ratio) - Math.log(cropRatio)) <
      Math.abs(Math.log(a.ratio) - Math.log(cropRatio))
        ? b
        : a
    );
    const label = nearestRatioLabel(best.label, spec.aspectRatios);
    return { label, ratio: best.ratio, openaiSize: best.size };
  }

  const label = nearestRatioLabel(`${safeW}:${safeH}`, spec.aspectRatios);
  const [ratioW, ratioH] = label.split(":").map(Number);
  return { label, ratio: ratioW / ratioH, geminiAspect: label };
}

// Snap known tiers by TIER_ORDER; unknown tokens or tierless models use Auto.
export function nearestImageSize(want: string, spec: ModelSpec): string {
  if (want === "auto" || !spec.imageSizes.length) return "auto";
  if (spec.imageSizes.includes(want)) return want;
  const wanted = TIER_ORDER.indexOf(want);
  if (wanted < 0) return "auto";
  let best = spec.imageSizes[0];
  let bestDist = Infinity;
  for (const size of spec.imageSizes) {
    const dist = Math.abs(TIER_ORDER.indexOf(size) - wanted);
    if (dist < bestDist) {
      bestDist = dist;
      best = size;
    }
  }
  return best;
}
