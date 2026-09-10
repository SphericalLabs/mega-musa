/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

import { requestJson, checkGeminiOutput } from "./errors";

import { bytesToBase64, base64ToBytes } from "./image-codec";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Shared ratio choices exposed by the plugin; dimensions vary by model and resolution.
export const SUPPORTED_ASPECT_RATIOS: ReadonlyArray<{ label: string; ratio: number }> = [
  { label: "1:1", ratio: 1 },
  { label: "2:3", ratio: 2 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "4:5", ratio: 4 / 5 },
  { label: "5:4", ratio: 5 / 4 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "21:9", ratio: 21 / 9 },
];

// Log distance treats reciprocal ratio changes equally; zero means an exact match.
export function aspectRatioInfo(width: number, height: number): { label: string; logDistance: number } {
  const target = Math.log((width || 1) / (height || 1));
  let best = SUPPORTED_ASPECT_RATIOS[0];
  let bestDist = Infinity;
  for (const ar of SUPPORTED_ASPECT_RATIOS) {
    const d = Math.abs(Math.log(ar.ratio) - target);
    if (d < bestDist) {
      bestDist = d;
      best = ar;
    }
  }
  return { label: best.label, logDistance: bestDist };
}

export function nearestSupportedAspectRatio(width: number, height: number): string {
  return aspectRatioInfo(width, height).label;
}

export interface RefImage {
  mimeType: string;
  base64: string;
}

export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export const IMAGE_QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export function normalizeImageQuality(value: string): ImageQuality {
  return IMAGE_QUALITY_OPTIONS.find((option) => option.value === value)?.value || "auto";
}

export function imageQualityLabel(value: ImageQuality): string {
  return value[0].toUpperCase() + value.slice(1);
}

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

export async function generateEdit(opts: GenerateOptions): Promise<GenerateResult> {
  const parts: any[] = [{ text: opts.prompt }];
  if (opts.baseImagePng) {
    parts.push({ inlineData: { mimeType: "image/png", data: bytesToBase64(opts.baseImagePng) } });
  }
  for (const ref of opts.references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } });
  }

  const generationConfig: any = { responseModalities: ["IMAGE"] };
  if (opts.aspectRatio || opts.imageSize) {
    const imageConfig: any = {};
    if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
    if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
    generationConfig.imageConfig = imageConfig;
  }
  const body: any = { contents: [{ role: "user", parts }], generationConfig };

  // Omit absent signals: some UXP fetch implementations throw on signal: undefined.
  const requestInit: any = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": opts.apiKey,
    },
    body: JSON.stringify(body),
  };
  if (opts.signal) requestInit.signal = opts.signal;

  const json = await requestJson("Gemini", `${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`, requestInit);
  checkGeminiOutput(json);

  const candidates: any[] = json?.candidates || [];
  for (const cand of candidates) {
    const candParts: any[] = cand?.content?.parts || [];
    for (const part of candParts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        return {
          mimeType: inline.mimeType || inline.mime_type || "image/png",
          bytes: base64ToBytes(inline.data),
        };
      }
    }
  }

  let text = "";
  for (const cand of candidates) {
    for (const part of cand?.content?.parts || []) {
      if (part.text) text += part.text + " ";
    }
  }
  const block = json?.promptFeedback?.blockReason || candidates[0]?.finishReason;
  throw new Error(
    text.trim() || (block ? `No image returned (${block}).` : "No image returned by the model.")
  );
}
