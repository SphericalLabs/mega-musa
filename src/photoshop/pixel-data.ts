/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { SRGB_PROFILE } from "./document-state";
import { imaging } from "./runtime";
import { type Bounds, type ImageBuffer } from "./types";

interface PixelRead {
  documentID: number;
  layerID?: number;
  sourceBounds: Bounds;
  targetSize?: { width?: number; height?: number };
}

// Copy host-owned pixels before disposing the image data, including failed reads.
export async function copyPixels(options: PixelRead): Promise<ImageBuffer> {
  const { imageData } = await imaging.getPixels({
    ...options, colorSpace: "RGB", colorProfile: SRGB_PROFILE, componentSize: 8, applyAlpha: false,
  });
  try {
    return {
      data: new Uint8Array(await imageData.getData({ chunky: true })),
      width: imageData.width,
      height: imageData.height,
      components: imageData.components || 4,
    };
  } finally {
    imageData.dispose();
  }
}
