/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { providerRegistry } from "../providers/registry";
export { DEFAULT_OPENAI_DESCRIPTION_MODEL } from "../providers/openai/description-models";
export { DEFAULT_GEMINI_DESCRIPTION_MODEL } from "../providers/gemini/description-models";
export const DESCRIPTION_MODELS = providerRegistry.descriptionModels;
export function descriptionModelSpec(id: string) {
  return DESCRIPTION_MODELS.find((model) => model.id === id) || null;
}
