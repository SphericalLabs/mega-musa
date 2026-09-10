/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export const OPENAI_MODEL_PREFIX = "openai:";

export function isOpenAIModel(model: string): boolean {
  return model.startsWith(OPENAI_MODEL_PREFIX);
}

export function modelProviderLabel(model: string): string {
  return isOpenAIModel(model) ? "OpenAI" : "Gemini";
}
