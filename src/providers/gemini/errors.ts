/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { apiError } from "../../errors";

export function checkGeminiOutput(json: any): void {
  const block = json?.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
    throw apiError("Gemini", { code: block });
  }
  for (const candidate of json?.candidates || []) {
    const code = candidate?.finishReason;
    if (code && code !== "STOP" && code !== "FINISH_REASON_UNSPECIFIED") {
      throw apiError("Gemini", { code, message: candidate.finishMessage });
    }
  }
}

