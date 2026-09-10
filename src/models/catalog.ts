/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { SUPPORTED_ASPECT_RATIOS } from "./aspect-ratios";
import { type ModelSpec } from "./types";

export const GPT_IMAGE_2_QUALITY_FACTORS: Record<"low" | "medium" | "high", number> = {
  low: 16,
  medium: 48,
  high: 96,
};

export const GPT_IMAGE_25_QUALITY_FACTORS = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };

export const GEMINI_RATIOS = SUPPORTED_ASPECT_RATIOS.map((r) => r.label);

export const OPENAI_FIXED = [
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
