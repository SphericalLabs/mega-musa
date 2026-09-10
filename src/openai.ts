/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { gptImage2Size } from "./models/image-size";
export { OPENAI_MODEL_PREFIX, generateOpenAIImage, isGptImage2 } from "./providers/openai-images";
export type { OpenAIGenerateOptions } from "./providers/openai-images";
