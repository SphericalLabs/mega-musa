/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { SUPPORTED_ASPECT_RATIOS, aspectRatioInfo, nearestSupportedAspectRatio } from "./models/aspect-ratios";
export { IMAGE_QUALITY_OPTIONS, imageQualityLabel, normalizeImageQuality } from "./models/quality";
export { generateEdit } from "./providers/gemini/images";
export type { GenerateOptions, GenerateResult, ImageQuality, ImageUsage, RefImage } from "./providers/types";
