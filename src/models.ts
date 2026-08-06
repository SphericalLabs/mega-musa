/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
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

type ExplicitQuality = Exclude<ImageQuality, "auto">;
type QualityPrices = Partial<Record<ExplicitQuality, Record<string, number>>>;

// Single source of truth for what each model can actually do. Both the UI (which
// menu items exist) and the request builder (what gets sent) read this table, so
// a picker can never offer something the API would reject. Adding a model is one
// entry here — nothing in index.html, nothing in the request code.

export interface ModelSpec {
  id: string; // the picker value; "openai:" prefix routes to the OpenAI client
  label: string; // what the dropdown shows
  // imageSize tokens the model accepts, coarsest-last. Empty = the model has no
  // resolution control at all (its size falls out of the chosen ratio instead).
  imageSizes: string[];
  // Ratios the model can frame to, as "w:h" labels.
  aspectRatios: string[];
  // OpenAI models with a fixed menu of output sizes: the ratio picks the size.
  fixedSizes?: { ratio: number; size: string; label: string }[];
  // USD for one OUTPUT image, keyed by imageSize token — the prompt and any input
  // images (the canvas crop, reference photos) are billed on top of this. A
  // [min, max] pair because for the OpenAI models the published price also
  // depends on things the resolution menu does not pick. Omit a key to show no
  // price for that tier; "auto" is only listed where the default is documented.
  prices?: Record<string, [number, number]>;
  // Exact USD output prices for explicit OpenAI quality choices, keyed by the
  // actual output size. GPT Image 2 is calculated from output tokens instead.
  qualityPrices?: QualityPrices;
}

export interface OutputFrame {
  // Always one of the current model's picker options.
  label: string;
  // The exact requested ratio. Returned pixels are verified after decoding.
  ratio: number;
  geminiAspect?: string;
  openaiSize?: string;
}

// Published prices are USD. Mid-market reference rate on 2026-08-04.
// The francs in the menu are estimates, so bump this if the rate drifts far
// enough to matter.
const USD_CHF = 0.8103;

// GPT Image 2 charges output image tokens rather than a fixed per-image amount.
// OpenAI's calculator uses these quality factors and an output rate of $30/M.
const GPT_IMAGE_2_ID = "openai:gpt-image-2";
const GPT_IMAGE_2_OUTPUT_USD_PER_MILLION = 30;
const OPENAI_TOKEN_RATES: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  "openai:gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "openai:gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
};
const GPT_IMAGE_2_QUALITY_FACTORS: Record<"low" | "medium" | "high", number> = {
  low: 16,
  medium: 48,
  high: 96,
};

// Every Gemini image model frames to the same ten ratios — that part does not
// vary by model, only the resolution tiers do.
const GEMINI_RATIOS = SUPPORTED_ASPECT_RATIOS.map((r) => r.label);

// gpt-image-1 / 1.5 / mini only ever return these three.
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
    // 1120 output tokens for both 1K and 2K, 2000 for 4K, at $120/1M — so 2K is
    // free extra resolution here. Gemini defaults to 1K when no size is sent.
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
    // The only model with the 512px tier.
    imageSizes: ["512px", "1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // 747 / 1120 / 1680 / 2520 output tokens at $60/1M.
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
    // 1290 output tokens at $30/1M.
    prices: { auto: [0.039, 0.039], "1K": [0.039, 0.039] },
  },
  {
    id: "openai:gpt-image-2",
    // Takes any width/height on a 16px grid, so the tier just sets a pixel
    // budget (see gptImage2Size) and the crop's own ratio is used as-is.
    label: "OpenAI GPT Image 2 (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // Prices are calculated from the exact output dimensions at menu-build time.
    // The API's quality:auto choice means the UI shows the low-to-high range.
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

// Smallest-to-largest, for snapping a tier the newly-picked model cannot do to
// the closest one it can.
const TIER_ORDER = ["512px", "1K", "2K", "4K"];

export function resolutionLabel(token: string): string {
  if (token === "auto") return "Auto";
  // Shown as 0.5K so it reads as one more step in the 1K / 2K / 4K ladder. The
  // token itself stays "512px" — that is what the API and the saved setting use.
  if (token === "512px") return "0.5K";
  return token;
}

function gptImage2OutputTokens(size: string, quality: keyof typeof GPT_IMAGE_2_QUALITY_FACTORS): number | null {
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

  const qualityFactor = GPT_IMAGE_2_QUALITY_FACTORS[quality];
  // Round the aspect-adjusted short axis half-up, using integer arithmetic.
  const shortAxisFactor = Math.floor((2 * qualityFactor * shortEdge + longEdge) / (2 * longEdge));
  const numerator = qualityFactor * shortAxisFactor * (2000000 + pixels);
  return Math.floor((numerator + 3999999) / 4000000);
}

function gptImage2OutputUSD(size: string, quality: ExplicitQuality): number | null {
  const tokens = gptImage2OutputTokens(size, quality);
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
  if (spec.id === GPT_IMAGE_2_ID) return gptImage2RepresentativeSize(token, ratio);
  return fixedOutputSize(spec, ratio);
}

function qualityPriceUSD(spec: ModelSpec, outputSize: string | null, quality: ExplicitQuality): number | null {
  if (!outputSize) return null;
  if (spec.id === GPT_IMAGE_2_ID) return gptImage2OutputUSD(outputSize, quality);
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
  const high = qualityPriceUSD(spec, size, "high");
  if (low !== null && high !== null) return [low, high];
  return spec.prices?.[token] || null;
}

// CHF for one output image. Where the published price spans a range this menu
// cannot pick between — for the OpenAI models the aspect ratio, plus the quality
// tier they choose themselves — take the middle of it and mark it "ca.".
export function estimatedCHF(
  spec: ModelSpec,
  token: string,
  outputSize?: string,
  quality: ImageQuality = "auto"
): number | null {
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, outputSize || outputSizeFor(spec, token, "1:1"), quality);
    if (exact !== null) return exact * USD_CHF;
  }
  const range = outputPriceRangeUSD(spec, token, outputSize || null);
  if (!range) return null;
  return ((range[0] + range[1]) / 2) * USD_CHF;
}

export function formatCHF(value: number): string {
  return value < 0.01 ? value.toFixed(3) : value.toFixed(2);
}

function priceLabel(spec: ModelSpec, token: string, ratio: string, quality: ImageQuality): string {
  const size = outputSizeFor(spec, token, ratio);
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, size, quality);
    if (exact !== null) return `CHF ${formatCHF(exact * USD_CHF)}`;
  }
  const range = outputPriceRangeUSD(spec, token, size, ratio);
  if (!range) return "";
  const low = range[0] * USD_CHF;
  const high = range[1] * USD_CHF;
  if (low === high) return `CHF ${formatCHF(low)}`;
  return `ca. CHF ${formatCHF(low)}–${formatCHF(high)}`;
}

// What the resolution picker shows: the tier plus what one output image costs, so
// the price is visible at the moment you pick the resolution.
export function resolutionMenuLabel(
  token: string,
  spec: ModelSpec,
  ratio = "1:1",
  quality: ImageQuality = "auto"
): string {
  const label = resolutionLabel(token);
  // Auto hands the choice to the model, so a figure beside it would read as a
  // promise. Price it only where Auto is the entire menu (the fixed-size OpenAI
  // models) and no tier row is there to carry the number. The table still knows
  // what Auto costs — the budget counter uses it.
  if (token === "auto" && spec.imageSizes.length) return label;
  const price = priceLabel(spec, token, ratio, quality);
  return price ? `${label} / ${price}` : label;
}

// Exact token-based cost is available when the completed event includes the
// input/output token breakdown and the model has published token rates.
export function actualUsageCHF(spec: ModelSpec, usage: ImageUsage): number | null {
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
  return usd * USD_CHF;
}

// Closest ratio in `options` to `want`, compared in log space so e.g. 2:1 sits
// midway between 1:1 and 4:1 rather than being pulled toward the wide end.
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

// Resolve the picker label and provider request framing together. This is the
// only place that translates a crop's dimensions into a model output shape, so
// the menu, crop fitting, request and price estimate cannot disagree.
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

  if (spec.id === GPT_IMAGE_2_ID) {
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

// Closest tier `model` supports to `want`. "auto" always survives; an unknown or
// unsupported token lands on the nearest neighbour in TIER_ORDER.
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
