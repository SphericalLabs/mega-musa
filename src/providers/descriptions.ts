/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescribeImagesOptions, type DescriptionResult } from "./description-types";
import { describeWithGemini } from "./gemini-descriptions";
import { describeWithOpenAI } from "./openai-descriptions";

export async function describeImages(opts: DescribeImagesOptions): Promise<DescriptionResult> {
  if (!opts.images.length) throw new Error("Provide at least one image to describe.");
  return opts.model.provider === "openai" ? describeWithOpenAI(opts) : describeWithGemini(opts);
}
