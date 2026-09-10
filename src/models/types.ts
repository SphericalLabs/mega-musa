/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ImageQuality } from "../providers/types";

export type ExplicitQuality = Exclude<ImageQuality, "auto">;

export type QualityPrices = Partial<Record<ExplicitQuality, Record<string, number>>>;

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
