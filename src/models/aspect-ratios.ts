/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

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
