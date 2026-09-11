/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ModelSpec } from "../../models/types";
import { SUPPORTED_ASPECT_RATIOS } from "../../models/aspect-ratios";
const GEMINI_RATIOS = SUPPORTED_ASPECT_RATIOS.map((r) => r.label);

const definitions: (Omit<ModelSpec, "provider" | "defaults" | "inputs" | "qualities"> & { qualities?: string[] })[] = [
  {
    id: "gemini-3-pro-image", apiModel: "gemini-3-pro-image",
    label: "Nano Banana Pro (2025)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // 1K and 2K share the same output price; Auto is estimated at the 1K default.
    prices: {
      auto: [0.134, 0.134],
      "1K": [0.134, 0.134],
      "2K": [0.134, 0.134],
      "4K": [0.24, 0.24],
    },
  },
  {
    id: "gemini-3.1-flash-image", apiModel: "gemini-3.1-flash-image",
    label: "Nano Banana 2 (2026)",
    imageSizes: ["512px", "1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    prices: {
      auto: [0.067, 0.067],
      "512px": [0.045, 0.045],
      "1K": [0.067, 0.067],
      "2K": [0.101, 0.101],
      "4K": [0.151, 0.151],
    },
  },
  {
    id: "gemini-2.5-flash-image", apiModel: "gemini-2.5-flash-image",
    visible: false,
    label: "Nano Banana (2025)",
    imageSizes: ["1K"],
    aspectRatios: GEMINI_RATIOS,
    prices: { auto: [0.039, 0.039], "1K": [0.039, 0.039] },
  },
];
export const models: ModelSpec[] = definitions.map((model) => ({
  ...model, provider: "gemini", qualities: ["auto"],
  defaults: { resolution: "2K", ratio: "1:1", quality: "auto" },
  inputs: { canvas: true, references: 10, maxEdge: 4096 },
}));
