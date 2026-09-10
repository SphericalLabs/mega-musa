/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export type DescriptionProvider = "openai" | "gemini";

export type OpenAIReasoningEffort = "none" | "high";

export type GeminiThinkingLevel = "minimal" | "low" | "high";

export interface DescriptionModelSpec {
  id: string;
  label: string;
  provider: DescriptionProvider;
  model: string;
  effort: OpenAIReasoningEffort | GeminiThinkingLevel;
  // Midpoint of the single-image menu estimate, used when usage is unavailable.
  estimatedUSD: number;
  estimateRangeUSD: [number, number];
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
  model: DescriptionModelSpec;
  images: DescriptionImage[];
  signal?: AbortSignal;
  // Called for an accepted response before parsing text, which can still fail.
  onUsage?: (usage: DescriptionUsage | undefined) => void;
}
