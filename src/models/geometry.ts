/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export { gptImage2RepresentativeSize } from "../providers/openai/image-size";
import { type ModelSpec, type OutputFrame } from "./types";

export const TIER_ORDER = ["512px", "1K", "2K", "4K"];

export function fixedOutputSize(spec: ModelSpec, ratio: string): string | null {
  const match = spec.fixedSizes?.find((size) => size.label === ratio);
  return match?.size || spec.fixedSizes?.[0]?.size || null;
}

export function outputSizeFor(spec: ModelSpec, token: string, ratio: string): string | null {
  if (spec.resolveFrame) {
    const [w, h] = ratio.split(":").map(Number);
    const frame = spec.resolveFrame(spec, token, w || 1, h || 1);
    return frame.width && frame.height ? `${frame.width}x${frame.height}` : null;
  }
  return fixedOutputSize(spec, ratio);
}

// Log distance treats reciprocal changes equally: 2:1 is midway between 1:1 and 4:1.
export function nearestRatioLabel(want: string, options: string[]): string {
  if (!options.length) return "1:1";
  if (options.includes(want)) return want;
  const [ww, wh] = want.split(":").map(Number);
  if (!ww || !wh) return options[0];
  const target = Math.log(ww / wh);
  let best = options[0];
  let bestDist = Infinity;
  for (const opt of options) {
    const [ow, oh] = opt.split(":").map(Number);
    if (!ow || !oh) continue;
    const dist = Math.abs(Math.log(ow / oh) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = opt;
    }
  }
  return best;
}

// Resolve provider framing and its nearest picker label together.
export function outputFrame(
  spec: ModelSpec,
  tier: string,
  width: number,
  height: number
): OutputFrame {
  if (!spec.aspectRatios.length) {
    throw new Error(`${spec.label} has no aspect ratios in the model table.`);
  }

  const safeW = width > 0 ? width : 1;
  const safeH = height > 0 ? height : 1;

  if (spec.resolveFrame) return spec.resolveFrame(spec, tier, safeW, safeH);

  if (spec.fixedSizes?.length) {
    const cropRatio = safeW / safeH;
    const best = spec.fixedSizes.reduce((a, b) =>
      Math.abs(Math.log(b.ratio) - Math.log(cropRatio)) <
        Math.abs(Math.log(a.ratio) - Math.log(cropRatio))
        ? b
        : a
    );
    const label = nearestRatioLabel(best.label, spec.aspectRatios);
    const [width, height] = best.size.split("x").map(Number);
    return { label, ratio: best.ratio, width, height, openaiSize: best.size };
  }

  const label = nearestRatioLabel(`${safeW}:${safeH}`, spec.aspectRatios);
  const [ratioW, ratioH] = label.split(":").map(Number);
  return { label, ratio: ratioW / ratioH, geminiAspect: label };
}

// Snap known tiers by TIER_ORDER; unknown tokens or tierless models use Auto.
export function nearestImageSize(want: string, spec: ModelSpec): string {
  if (want === "auto" || !spec.imageSizes.length) return "auto";
  if (spec.imageSizes.includes(want)) return want;
  const wanted = TIER_ORDER.indexOf(want);
  if (wanted < 0) return "auto";
  let best = spec.imageSizes[0];
  let bestDist = Infinity;
  for (const size of spec.imageSizes) {
    const dist = Math.abs(TIER_ORDER.indexOf(size) - wanted);
    if (dist < bestDist) {
      bestDist = dist;
      best = size;
    }
  }
  return best;
}
