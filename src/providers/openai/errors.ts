/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { apiError } from "../../errors";

export function checkOpenAIOutput(json: any): void {
  if (json?.error) throw apiError("OpenAI", json.error);
  if (["failed", "incomplete", "cancelled", "queued", "in_progress"].includes(json?.status)) {
    throw apiError("OpenAI", { code: json.incomplete_details?.reason || json.status });
  }
}
