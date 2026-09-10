/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescriptionModelSpec } from "../providers/description-types";

export const DEFAULT_OPENAI_DESCRIPTION_MODEL = "openai:gpt-5.6-luna:high";

export const DEFAULT_GEMINI_DESCRIPTION_MODEL = "gemini:gemini-3.7-flash:high";

// Fallback CHF estimates converted to USD at the historical 0.8103 CHF/USD rate.
export const DESCRIPTION_MODELS: ReadonlyArray<DescriptionModelSpec> = [
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
  {
    id: "gemini:gemini-3.5-flash-lite:minimal",
    label: "Gemini Flash-Lite — Thinking: Minimal",
    estimateRangeUSD: [0.001234110823151919, 0.002468221646303838],
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    effort: "minimal",
    estimatedUSD: 0.0018511662347278786,
  },
  {
    id: "gemini:gemini-3.5-flash-lite:high",
    label: "Gemini Flash-Lite — Thinking: High",
    estimateRangeUSD: [0.0037023324694557573, 0.024682216463038382],
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    effort: "high",
    estimatedUSD: 0.014192274466247068,
  },
  {
    id: "gemini:gemini-3.7-flash:low",
    label: "Gemini 3.7 Flash — Thinking: Low",
    estimateRangeUSD: [0.002468221646303838, 0.009872886585215353],
    provider: "gemini",
    model: "gemini-3.7-flash",
    effort: "low",
    estimatedUSD: 0.0061705541157595955,
  },
  {
    id: DEFAULT_GEMINI_DESCRIPTION_MODEL,
    label: "Gemini 3.7 Flash — Thinking: High",
    estimateRangeUSD: [0.0061705541157595955, 0.03702332469455757],
    provider: "gemini",
    model: "gemini-3.7-flash",
    effort: "high",
    estimatedUSD: 0.021596939405158586,
  },
];

export function descriptionModelSpec(id: string): DescriptionModelSpec | null {
  return DESCRIPTION_MODELS.find((model) => model.id === id) || null;
}
