/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type Bounds, type SelectionSnapshot } from "../photoshop/types";

// Provider sizes use pixel grids, so small ratio differences are normal.
export const RETURNED_RATIO_TOLERANCE = 0.02;

export function pixelSize(width: number, height: number): string {
  return `${width}×${height}`;
}

export function ratioDiffers(width: number, height: number, expected: number): boolean {
  return Math.abs(width / height / expected - 1) > RETURNED_RATIO_TOLERANCE;
}

export function placementCoversEntireTarget(
  region: Bounds,
  target: Bounds,
  selection: SelectionSnapshot | null
): boolean {
  if (
    region.left !== target.left ||
    region.top !== target.top ||
    region.right !== target.right ||
    region.bottom !== target.bottom
  ) {
    return false;
  }
  if (!selection) return true;
  // Matching bounds do not guarantee full coverage for shaped or feathered selections.
  for (let i = 0; i < selection.data.length; i += 1) {
    if (selection.data[i] !== 255) return false;
  }
  return true;
}

export const MAX_LAYER_NAME = 255;

export function modelNameWithoutYear(label: string): string {
  return label.replace(/\s*\(\d{4}\)\s*$/, "").replace(/^OpenAI GPT Image /, "GPT Image ");
}

// Reserve space for the settings suffix; truncate only the prompt.
export function resultLayerName(prompt: string, details: string[]): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  const suffix = details.length ? ` [${details.join(", ")}]` : "";
  const room = Math.max(1, MAX_LAYER_NAME - suffix.length);
  if (text.length <= room) return `${text}${suffix}`;
  const clipped = text.slice(0, room - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  // Avoid losing most of the prompt just to end at a word boundary.
  const cut = lastSpace > room * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut}…${suffix}`;
}
