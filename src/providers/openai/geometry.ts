/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { gptImage2Size } from "./image-size";
import { nearestRatioLabel } from "../../models/geometry";
import { type ModelSpec, type OutputFrame } from "../../models/types";

export function flexibleFrame(spec: ModelSpec, tier: string, width: number, height: number): OutputFrame {
  const size = gptImage2Size(width, height, tier === "auto" ? undefined : tier);
  const [w, h] = size.split("x").map(Number);
  return { width: w, height: h, ratio: w / h, label: nearestRatioLabel(`${w}:${h}`, spec.aspectRatios), openaiSize: size };
}
