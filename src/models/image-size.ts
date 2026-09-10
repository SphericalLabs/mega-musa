/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Flexible output limits; dimensions also use a 16px grid and at most a 3:1 ratio.
export const G2_MAX_EDGE = 3840;

export const G2_MIN_PX = 655360;

export const G2_MAX_PX = 8294400;

export function floor16(n: number): number {
  return Math.max(16, Math.floor(n / 16) * 16);
}

export function ceil16(n: number): number {
  return Math.max(16, Math.ceil(n / 16) * 16);
}

// Approximate the crop ratio within the size limits and 16px grid. An omitted tier uses
// the crop pixel count, clamped to those limits.
export function gptImage2Size(cropW: number, cropH: number, tier?: string): string {
  const ratio = Math.min(3, Math.max(1 / 3, cropW / cropH));
  let targetPx: number;
  if (tier === "4K") targetPx = G2_MAX_PX;
  else if (tier === "2K") targetPx = 4194304;
  else if (tier === "1K") targetPx = 1048576;
  else targetPx = Math.min(G2_MAX_PX, Math.max(G2_MIN_PX, cropW * cropH));

  let w = Math.sqrt(targetPx * ratio);
  let h = Math.sqrt(targetPx / ratio);
  const longest = Math.max(w, h);
  if (longest > G2_MAX_EDGE) {
    const k = G2_MAX_EDGE / longest;
    w *= k;
    h *= k;
  }
  // Round down to avoid exceeding the edge and pixel ceilings.
  w = floor16(w);
  h = floor16(h);
  if (w / h > 3) w = floor16(h * 3);
  if (h / w > 3) h = floor16(w * 3);
  // Rounding down may require restoring the minimum pixel area.
  if (w * h < G2_MIN_PX) {
    const k = Math.sqrt(G2_MIN_PX / (w * h));
    w = Math.min(G2_MAX_EDGE, ceil16(w * k));
    h = Math.min(G2_MAX_EDGE, ceil16(h * k));
  }
  return `${w}x${h}`;
}
