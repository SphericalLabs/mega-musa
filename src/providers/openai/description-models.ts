/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescriptionModelSpec } from "../description-types";
export const DEFAULT_OPENAI_DESCRIPTION_MODEL = "openai:gpt-5.6-luna:high";
import { tokenDescriptionCost } from "../description-cost";
import { type DescriptionUsage } from "../description-types";
export const rates: Record<string, { input: number; output: number }> = {"gpt-5.6-luna": { input: 0.2, output: 1.2 }, "gpt-5.6-sol": { input: 4, output: 20 }};
const definitions: DescriptionModelSpec[] = [
  {
    id: "openai:gpt-5.6-luna:none",
    label: "OpenAI Luna — Reasoning: None",
    estimateRangeUSD: [0.001234110823151919, 0.002468221646303838],
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "none",
    estimatedUSD: 0.0018511662347278786,
  },
  {
    id: DEFAULT_OPENAI_DESCRIPTION_MODEL,
    label: "OpenAI Luna — Reasoning: High",
    estimateRangeUSD: [0.002468221646303838, 0.012341108231519191],
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "high",
    estimatedUSD: 0.0074046649389115145,
  },
  {
    id: "openai:gpt-5.6-sol:none",
    label: "OpenAI Sol — Reasoning: None",
    estimateRangeUSD: [0.012341108231519191, 0.03702332469455757],
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "none",
    estimatedUSD: 0.024682216463038382,
  },
  {
    id: "openai:gpt-5.6-sol:high",
    label: "OpenAI Sol — Reasoning: High",
    estimateRangeUSD: [0.03702332469455757, 0.18511662347278784],
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
    estimatedUSD: 0.11106997408367271,
  },

];
export const descriptionModels: DescriptionModelSpec[] = definitions.map((model) => ({ ...model,
  actualCost: (usage: DescriptionUsage) => tokenDescriptionCost(rates[model.model], usage),
}));
