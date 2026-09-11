/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ModelSpec, type ModelSettings, type OutputFrame } from "../models/types";
import { type DescribeImagesOptions, type DescriptionModelSpec, type DescriptionResult } from "./description-types";
import { type GenerateResult, type RefImage } from "./types";

export interface ProviderRequest {
  apiKey: string;
  credentials: Readonly<Record<string, string>>;
  model: ModelSpec;
  settings: ModelSettings;
  prompt: string;
  baseImagePng?: Uint8Array;
  references: RefImage[];
  frame: OutputFrame;
  signal?: AbortSignal;
  // Call immediately before the first potentially billable network dispatch.
  onDispatch?: () => void;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  domains: string[];
  credentials: { id: string; label: string; secret: boolean; required?: boolean; fieldId?: string; buttonId?: string }[];
  models: ModelSpec[];
  descriptionModels?: DescriptionModelSpec[];
  defaultDescriptionModel?: string;
  generate?: (request: ProviderRequest) => Promise<GenerateResult>;
  describe?: (request: DescribeImagesOptions) => Promise<DescriptionResult>;
}
