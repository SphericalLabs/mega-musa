/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DescribeImagesOptions, type DescriptionResult } from "./description-types";
import { providerRegistry } from "./registry";

export async function describeImages(opts: DescribeImagesOptions, registry = providerRegistry): Promise<DescriptionResult> {
  if (!opts.images.length) throw new Error("Provide at least one image to describe.");
  const provider = registry.provider(opts.model.provider);
  if (!provider.describe) throw new Error(`${provider.label} does not support descriptions.`);
  const model = provider.descriptionModels?.find((model) => model.id === opts.model.id);
  if (!model) throw new Error(`Description model unavailable: ${opts.model.id}`);
  const credentials = opts.credentials || { apiKey: opts.apiKey };
  for (const field of provider.credentials) {
    if (field.required && !credentials[field.id]?.trim()) throw new Error(`Enter and save ${field.label}.`);
  }
  return provider.describe({ ...opts, model, credentials });
}
