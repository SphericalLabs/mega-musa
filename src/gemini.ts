/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
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

import { bytesToBase64, base64ToBytes } from "./image-codec";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Official Gemini image aspect ratios (ai.google.dev/gemini-api image
// generation → "Aspect ratios and image size"). The model only frames to one of
// these; we snap the request to the nearest of them.
//   1K / 2K / 4K example pixel sizes per ratio (width×height):
//   1:1  1024² / 2048² / 4096²      2:3  848×1264  / 1696×2528 / 3392×5056
//   3:2  1264×848 / 2528×1696 ...   3:4  896×1200  / 1792×2400 / 3584×4800
//   4:3  1200×896 / ...             4:5  928×1152  / 1856×2304 / 3712×4608
//   5:4  1152×928 / ...             9:16 768×1376  / 1536×2752 / 3072×5504
//   16:9 1376×768 / ...             21:9 1584×672  / 3168×1344 / 6336×2688
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

// Nearest supported aspect ratio to a width/height, with the log-space distance
// (so e.g. 2:1 is equidistant from 1:1 and 4:1). logDistance ~0 means the shape
// already matches an official ratio.
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

export type ImageQuality = "auto" | "low" | "medium" | "high";

export const IMAGE_QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function normalizeImageQuality(value: string): ImageQuality {
  return value === "low" || value === "medium" || value === "high" ? value : "auto";
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
  baseImagePng?: Uint8Array; // omitted => generate from the prompt (+ references) alone
  references: RefImage[];
  aspectRatio?: string; // undefined => let the model match the input
  imageSize?: string; // undefined => let the model match the input
  signal?: AbortSignal;
}

export interface GenerateResult {
  mimeType: string;
  bytes: Uint8Array;
  usage?: ImageUsage;
}

// Calls the Gemini generateContent REST endpoint with an image-in / image-out
// request. Mirrors the request shape validated in generate_images.py, using the
// JSON (camelCase) field names the REST API expects. With no base image and no
// references the same endpoint is a plain text-to-image call.
export async function generateEdit(opts: GenerateOptions): Promise<GenerateResult> {
  const parts: any[] = [{ text: opts.prompt }];
  if (opts.baseImagePng) {
    parts.push({ inlineData: { mimeType: "image/png", data: bytesToBase64(opts.baseImagePng) } });
  }
  for (const ref of opts.references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } });
  }

  const body: any = { contents: [{ role: "user", parts }] };
  if (opts.aspectRatio || opts.imageSize) {
    const imageConfig: any = {};
    if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
    if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
    body.generationConfig = { imageConfig };
  }

  // Build the request init without a `signal` key unless one is provided —
  // UXP's fetch throws on `signal: undefined` (it calls addEventListener on it).
  const requestInit: any = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": opts.apiKey,
    },
    body: JSON.stringify(body),
  };
  if (opts.signal) requestInit.signal = opts.signal;

  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`, requestInit);

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

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

  // No image came back — surface any text or block reason the model returned.
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
