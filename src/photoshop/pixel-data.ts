/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { SRGB_PROFILE } from "./document-state";
import { preciseBoundsFrom } from "./geometry";
import { imaging } from "./runtime";
import { type Bounds, type ImageBuffer } from "./types";

interface PixelRead {
  documentID: number;
  layerID?: number;
  sourceBounds: Bounds;
  targetSize?: { width?: number; height?: number };
}

// Copy host-owned pixels before disposing the image data, including failed reads.
export async function copyPixels(options: PixelRead): Promise<ImageBuffer & { sourceBounds: Bounds }> {
  const result = await imaging.getPixels({
    ...options, colorSpace: "RGB", colorProfile: SRGB_PROFILE, componentSize: 8, applyAlpha: false,
  });
  const { imageData } = result;
  const actualBounds = preciseBoundsFrom(result.sourceBounds);
  // Photoshop reports sourceBounds in cache-level coordinates when using a pyramid.
  const factor = 2 ** (Number(result.level) || 0);
  const sourceBounds = actualBounds ? {
    left: actualBounds.left * factor, top: actualBounds.top * factor,
    right: actualBounds.right * factor, bottom: actualBounds.bottom * factor,
  } : options.sourceBounds;
  if (!imageData) return { data: new Uint8Array(), width: 0, height: 0, components: 4, sourceBounds };
  try {
    return {
      data: new Uint8Array(await imageData.getData({ chunky: true })),
      width: imageData.width,
      height: imageData.height,
      components: imageData.components || 4,
      sourceBounds,
    };
  } finally {
    imageData.dispose();
  }
}
