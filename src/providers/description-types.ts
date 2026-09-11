/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export type DescriptionProvider = string;

export type { OpenAIReasoningEffort } from "./openai/descriptions";

export type { GeminiThinkingLevel } from "./gemini/descriptions";

export interface DescriptionModelSpec {
  id: string;
  label: string;
  provider: DescriptionProvider;
  model: string;
  effort?: string;
  options?: Record<string, string | number | boolean>;
  actualCost?: (usage: DescriptionUsage, at: Date) => number | null;
  // Midpoint of the single-image menu estimate, used when usage is unavailable.
  estimatedUSD: number | null;
  estimateRangeUSD: [number, number] | null;
}

export interface DescriptionImage {
  mimeType: string;
  base64: string;
}

export interface DescriptionUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  // Includes reasoning tokens for both providers.
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  serviceTier?: string;
}

export interface DescriptionResult {
  descriptions: string[];
  usage?: DescriptionUsage;
}

export interface DescribeImagesOptions {
  apiKey: string;
  credentials?: Readonly<Record<string, string>>;
  onDispatch?: () => void;
  model: DescriptionModelSpec;
  images: DescriptionImage[];
  signal?: AbortSignal;
  // Called for an accepted response before parsing text, which can still fail.
  onUsage?: (usage: DescriptionUsage | undefined) => void;
}
