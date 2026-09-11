/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescriptionModelSpec, type DescriptionUsage } from "../providers/description-types";

import { rates as openaiRates } from "../providers/openai/description-models";
import { rates as geminiRates } from "../providers/gemini/description-models";
import { validCost } from "./pricing";
export const DESCRIPTION_TOKEN_RATES = { ...openaiRates, ...geminiRates };

export function estimatedDescriptionUSD(model: DescriptionModelSpec, imageCount: number): number | null {
  const estimate = validCost(model.estimatedUSD);
  return estimate === null ? null : estimate * Math.max(1, imageCount);
}

export function descriptionUsageUSD(
  model: DescriptionModelSpec,
  usage: DescriptionUsage,
  at = new Date()
): number | null {
  return validCost(model.actualCost?.(usage, at));
}
