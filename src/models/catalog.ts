/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { providerRegistry } from "../providers/registry";
export { GPT_IMAGE_2_QUALITY_FACTORS, GPT_IMAGE_25_QUALITY_FACTORS, OPENAI_FIXED } from "../providers/openai/models";
export const DEFAULT_MODEL = "gemini-3-pro-image";
export const MODELS = providerRegistry.models;
export function modelSpec(id: string) { return providerRegistry.model(id); }
