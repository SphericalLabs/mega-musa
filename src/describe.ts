/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export {
  DEFAULT_GEMINI_DESCRIPTION_MODEL,
  DEFAULT_OPENAI_DESCRIPTION_MODEL,
  DESCRIPTION_MODELS,
  descriptionModelSpec,
} from "./models/description-catalog";
export { descriptionUsageUSD, estimatedDescriptionUSD } from "./models/description-pricing";
export type {
  DescribeImagesOptions,
  DescriptionImage,
  DescriptionModelSpec,
  DescriptionProvider,
  DescriptionResult,
  DescriptionUsage,
  GeminiThinkingLevel,
  OpenAIReasoningEffort,
} from "./providers/description-types";
export { describeImages } from "./providers/descriptions";
