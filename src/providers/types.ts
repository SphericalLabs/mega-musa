/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export interface RefImage {
  mimeType: string;
  base64: string;
}

export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageUsage {
  quality?: ImageQuality;
  inputTokens?: number;
  inputImageTokens?: number;
  inputTextTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  prompt: string;
  baseImagePng?: Uint8Array;
  references: RefImage[];
  aspectRatio?: string; // Omitted values use the provider default.
  imageSize?: string;
  signal?: AbortSignal;
}

export interface GenerateResult {
  mimeType: string;
  bytes: Uint8Array;
  usage?: ImageUsage;
}
