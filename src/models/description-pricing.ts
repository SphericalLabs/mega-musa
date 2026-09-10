/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescriptionModelSpec, type DescriptionUsage } from "../providers/description-types";

// USD per million tokens; rate snapshot from 2026-08-28.
// https://developers.openai.com/api/docs/pricing
// https://ai.google.dev/gemini-api/docs/pricing
export const DESCRIPTION_TOKEN_RATES: Record<string, { input: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
};

export function estimatedDescriptionUSD(model: DescriptionModelSpec, imageCount: number): number {
  return model.estimatedUSD * Math.max(1, imageCount);
}

export function descriptionUsageUSD(
  model: DescriptionModelSpec,
  usage: DescriptionUsage,
  at = new Date()
): number | null {
  const rates = DESCRIPTION_TOKEN_RATES[model.model];
  const { inputTokens, outputTokens } = usage;
  if (!rates || inputTokens === undefined || outputTokens === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const writes = usage.cacheWriteInputTokens ?? 0;
  if (![inputTokens, outputTokens, cached, writes].every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (cached + writes > inputTokens) return null;
  // Cache pricing: https://developers.openai.com/api/docs/guides/prompt-caching
  const input = inputTokens - cached - writes + cached * 0.1 + writes * 1.25;
  const tier = usage.serviceTier;
  const tierMultiplier = tier === "fast" || tier === "priority" ? 2 : tier === "flex" ? 0.5 : 1;
  // The configured Gemini Flash promotion expires on January 1, 2027.
  const promotionMultiplier = model.model === "gemini-3.7-flash" && at.getTime() >= Date.UTC(2027, 0, 1) ? 2 : 1;
  return ((input * rates.input + outputTokens * rates.output) / 1000000) * tierMultiplier * promotionMultiplier;
}
