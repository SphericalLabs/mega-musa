/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export const OPENAI_TOKEN_RATES: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  "openai:gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "openai:gpt-image-1.5": { textInput: 5, imageInput: 8, imageOutput: 32 },
  "openai:gpt-image-1-mini": { textInput: 2, imageInput: 2.5, imageOutput: 8 },
};


// Flexible-size output estimates use the quality factors below and this USD token rate.
export const GPT_IMAGE_2_OUTPUT_USD_PER_MILLION = 30;

export function imageOutputTokens(size: string, qualityFactor: number): number | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (
    !width ||
    !height ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    pixels < 655360 ||
    pixels > 8294400 ||
    longEdge > 3840 ||
    longEdge > shortEdge * 3
  ) {
    return null;
  }

  // Match the pricing calculator: round exact half ties to the nearest even integer.
  const shortAxis = qualityFactor * shortEdge / longEdge;
  const floor = Math.floor(shortAxis);
  const shortAxisFactor = shortAxis - floor === 0.5 ? floor + floor % 2 : Math.round(shortAxis);
  const numerator = qualityFactor * shortAxisFactor * (2000000 + pixels);
  return Math.floor((numerator + 3999999) / 4000000);
}

export function imageOutputUSD(size: string, qualityFactor: number): number | null {
  const tokens = imageOutputTokens(size, qualityFactor);
  return tokens === null ? null : (tokens * GPT_IMAGE_2_OUTPUT_USD_PER_MILLION) / 1000000;
}

