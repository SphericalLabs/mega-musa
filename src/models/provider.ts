/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { modelSpec } from "./catalog";
import { providerRegistry } from "../providers/registry";
export { OPENAI_MODEL_PREFIX } from "../providers/openai/images";
export function isOpenAIModel(model: string): boolean { return modelSpec(model).provider === "openai"; }
export function modelProviderLabel(model: string): string { return providerRegistry.provider(modelSpec(model).provider).label; }
