/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ModelSpec } from "../../models/types";
import { SUPPORTED_ASPECT_RATIOS } from "../../models/aspect-ratios";
import { OPENAI_TOKEN_RATES } from "./pricing";
import { flexibleFrame } from "./geometry";

const RATIOS = SUPPORTED_ASPECT_RATIOS.map((r) => r.label);
export const GPT_IMAGE_2_QUALITY_FACTORS: Record<"low" | "medium" | "high", number> = {
  low: 16,
  medium: 48,
  high: 96,
};

export const GPT_IMAGE_25_QUALITY_FACTORS = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };

export const OPENAI_FIXED = [
  { ratio: 1, size: "1024x1024", label: "1:1" },
  { ratio: 3 / 2, size: "1536x1024", label: "3:2" },
  { ratio: 2 / 3, size: "1024x1536", label: "2:3" },
];

const definitions: (Omit<ModelSpec, "provider" | "defaults" | "inputs" | "qualities"> & { qualities?: string[] })[] = [
  ...[
    { id: "openai:gpt-image-2.5-sunburst", apiModel: "gpt-image-2.5-sunburst", label: "OpenAI Sunburst (2026)" },
    { id: "openai:gpt-image-2.5-flare", apiModel: "gpt-image-2.5-flare", label: "OpenAI Flare (2026)" },
  ].map((model) => ({
    ...model,
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: RATIOS,
    outputQualityFactors: GPT_IMAGE_25_QUALITY_FACTORS,
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    resolveFrame: flexibleFrame,
  })),
  {
    id: "openai:gpt-image-2", apiModel: "gpt-image-2",
    outputQualityFactors: GPT_IMAGE_2_QUALITY_FACTORS,
    resolveFrame: flexibleFrame,
    label: "OpenAI GPT Image 2 (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: RATIOS,
  },
  {
    id: "openai:gpt-image-1.5", apiModel: "gpt-image-1.5",
    visible: false,
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
    id: "openai:gpt-image-1", apiModel: "gpt-image-1",
    visible: false,
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
    id: "openai:gpt-image-1-mini", apiModel: "gpt-image-1-mini",
    visible: false,
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
export const models: ModelSpec[] = definitions.map((model) => ({
  qualities: ["auto", "low", "medium", "high"], ...model,
  tokenRates: OPENAI_TOKEN_RATES[model.id],
  provider: "openai",
  settings: [{
    key: "transparent", label: "Transparent background", type: "boolean", default: false,
    description: "Also request transparency in your prompt. Results may vary.",
  }],
  defaults: { resolution: "2K", ratio: "1:1", quality: "low" },
  inputs: { canvas: true, references: 10, maxEdge: 4096 },
}));
