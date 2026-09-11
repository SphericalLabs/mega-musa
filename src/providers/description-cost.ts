/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescriptionUsage } from "./description-types";

export function tokenDescriptionCost(rates: { input: number; output: number }, usage: DescriptionUsage, multiplier = 1): number | null {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const writes = usage.cacheWriteInputTokens ?? 0;
  if (![inputTokens, outputTokens, cached, writes].every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (cached + writes > inputTokens) return null;
  // Cache pricing: https://developers.openai.com/api/docs/guides/prompt-caching
  const input = inputTokens - cached - writes + cached * 0.1 + writes * 1.25;
  const tier = usage.serviceTier;
  const tierMultiplier = tier === "fast" || tier === "priority" ? 2 : tier === "flex" ? 0.5 : 1;

  return ((input * rates.input + outputTokens * rates.output) / 1000000) * tierMultiplier * multiplier;
}
