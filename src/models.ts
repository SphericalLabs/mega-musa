/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { DEFAULT_MODEL, MODELS, modelSpec } from "./models/catalog";
export { nearestImageSize, nearestRatioLabel, outputFrame } from "./models/geometry";
export { resolutionLabel, resolutionMenuLabel } from "./models/labels";
export { actualUsageUSD, estimatedTotalUSD, estimatedUSD } from "./models/pricing";
export type { ModelSpec, OutputFrame } from "./models/types";
