/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type OutputFrame, type ModelSettings } from "../models/types";
import { freezeModelSettings, normalizeModelSettings, validateModelInput } from "../models/settings";
import { providerRegistry } from "./registry";
import { type GenerateResult, type ImageQuality, type RefImage } from "./types";

export interface ImageRequest {
  apiKey: string;
  credentials?: Readonly<Record<string, string>>;
  model: string;
  prompt: string;
  baseImagePng?: Uint8Array;
  references: RefImage[];
  frame: OutputFrame;
  resolution: string;
  quality: ImageQuality;
  settings?: ModelSettings;
  signal?: AbortSignal;
  onDispatch?: () => void;
}
export interface ImageProvider { generate(request: ImageRequest): Promise<GenerateResult> }

export async function generateImage(request: ImageRequest, registry = providerRegistry): Promise<GenerateResult> {
  const model = registry.model(request.model);
  const provider = registry.provider(model.provider);
  if (!provider.generate) throw new Error(`${provider.label} does not support image generation.`);
  const settings = freezeModelSettings(normalizeModelSettings(model, request.settings || {
    resolution: request.resolution, quality: request.quality,
  }).settings);
  validateModelInput(model, settings, !!request.baseImagePng, request.references.length);
  const credentials = request.credentials || { apiKey: request.apiKey };
  for (const field of provider.credentials) {
    if (field.required && !credentials[field.id]?.trim()) throw new Error(`Enter and save ${field.label}.`);
  }
  return provider.generate({ ...request, credentials, model, settings });
}
