/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { apiError, providerError } from "../../errors";

export function checkOpenAIOutput(json: any, apiKey?: string): void {
  if (json?.error) throw apiError("OpenAI", json.error, undefined, apiKey);
  if (["failed", "incomplete", "cancelled", "queued", "in_progress"].includes(json?.status)) {
    if (json.incomplete_details?.reason === "content_filter") {
      throw providerError("OpenAI", "Generated output blocked by a safety check. The server provided no specific reason.", "CONTENT_FILTER");
    }
    throw apiError("OpenAI", { code: json.incomplete_details?.reason || json.status }, undefined, apiKey);
  }
}
