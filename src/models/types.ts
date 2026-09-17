/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ImageQuality, type ImageUsage } from "../providers/types";

export type SettingValue = string | number | boolean;
export type ModelOptions = Record<string, SettingValue>;
export type SettingDefinition = { key: string; label: string; description?: string } & (
  | { type: "select"; default: string; options: { value: string; label: string }[] }
  | { type: "number"; default: number; min?: number; max?: number; step?: number }
  | { type: "boolean"; default: boolean }
  | { type: "text"; default: string; maxLength?: number }
);
export interface ModelSettings {
  version: number;
  resolution: string;
  ratio: string;
  quality: ImageQuality;
  options: ModelOptions;
}

export type ExplicitQuality = Exclude<ImageQuality, "auto">;

export type QualityPrices = Partial<Record<ExplicitQuality, Record<string, number>>>;

// The model table drives both picker options and provider request framing.

export interface ModelSpec {
  id: string;
  provider: string;
  apiModel: string;
  label: string;
  visible?: boolean;
  qualities: ImageQuality[];
  defaults: { resolution: string; ratio: string; quality: ImageQuality };
  inputs: { canvas: boolean; references: number; maxEdge: number; maxImages?: number };
  settingsVersion?: number;
  settings?: SettingDefinition[];
  migrateSettings?: (saved: ModelSettings) => Partial<ModelSettings>;
  validateSettings?: (settings: ModelSettings) => string | null;
  resolveFrame?: (spec: ModelSpec, tier: string, width: number, height: number) => OutputFrame;
  estimateCost?: (settings: ModelSettings, size?: string) => number | null;
  tokenRates?: { textInput: number; imageInput: number; imageOutput: number };
  actualCost?: (usage: ImageUsage) => number | null;
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
  width?: number;
  height?: number;
  // Compatibility fields for older callers. Shared workflows use width/height.
  geminiAspect?: string;
  openaiSize?: string;
}
