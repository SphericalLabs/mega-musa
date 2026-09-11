/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescriptionModelSpec } from "../description-types";
export const DEFAULT_GEMINI_DESCRIPTION_MODEL = "gemini:gemini-3.7-flash:high";
import { tokenDescriptionCost } from "../description-cost";
import { type DescriptionUsage } from "../description-types";
export const rates: Record<string, { input: number; output: number }> = {"gemini-3.5-flash-lite": { input: 0.3, output: 2.5 }, "gemini-3.7-flash": { input: 0.75, output: 3.75 }};
const definitions: DescriptionModelSpec[] = [
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
export const descriptionModels: DescriptionModelSpec[] = definitions.map((model) => ({ ...model,
  actualCost: (usage: DescriptionUsage, at: Date) => tokenDescriptionCost(rates[model.model], usage, model.model === "gemini-3.7-flash" && at.getTime() >= Date.UTC(2027, 0, 1) ? 2 : 1),
}));
