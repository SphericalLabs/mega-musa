/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type HostModalLease } from "../host-modal";
import { toRGBA } from "../images/pixels";
import { resampleRGBA } from "../images/resample";
import { boundsFrom, intersectBounds } from "./geometry";
import { copyPixels } from "./pixel-data";
import { runModal } from "./runtime";
import { readSelectionMask } from "./selection";
import { type Bounds, type ImageBuffer, type RegionRead } from "./types";

// Read the composite and optional selection coverage in modal scope.
export async function readRegion(
  docId: number,
  bounds: Bounds,
  withMask: boolean,
  maxEdge?: number,
  lease?: HostModalLease
): Promise<RegionRead> {
  return runModal("read region", () => readRegionInModal(docId, bounds, withMask, maxEdge), lease);
}

// Retain the entire requested coordinate frame even when Photoshop trims empty
// margins or reads a smaller cache level. clipBounds excludes other artboards.
export async function readRegionInModal(
  docId: number,
  bounds: Bounds,
  withMask: boolean,
  maxEdge?: number,
  clipBounds?: Bounds
): Promise<RegionRead> {
  const cropW = bounds.right - bounds.left;
  const cropH = bounds.bottom - bounds.top;
  const longest = Math.max(cropW, cropH);
  const scale = !withMask && maxEdge ? Math.min(1, maxEdge / longest) : 1;
  const width = Math.max(1, Math.round(cropW * scale));
  const height = Math.max(1, Math.round(cropH * scale));
  const data = new Uint8Array(width * height * 4);
  const readBounds = clipBounds ? intersectBounds(bounds, clipBounds) : bounds;
  if (readBounds) {
    const read = await copyPixels({
      documentID: docId, sourceBounds: readBounds,
      targetSize: scale < 1 ? {
        width: Math.max(1, Math.round((readBounds.right - readBounds.left) * scale)),
        height: Math.max(1, Math.round((readBounds.bottom - readBounds.top) * scale)),
      } : undefined,
    });
    const left = Math.round((read.sourceBounds.left - bounds.left) * width / cropW);
    const top = Math.round((read.sourceBounds.top - bounds.top) * height / cropH);
    const right = Math.round((read.sourceBounds.right - bounds.left) * width / cropW);
    const bottom = Math.round((read.sourceBounds.bottom - bounds.top) * height / cropH);
    const readW = right - left;
    const readH = bottom - top;
    if (read.width > 0 && read.height > 0 && readW > 0 && readH > 0) {
      const pixels = resampleRGBA(toRGBA(read.data, read.width, read.height, read.components), read.width, read.height, readW, readH);
      const startX = Math.max(0, left);
      const endX = Math.min(width, right);
      if (endX > startX) for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
        const start = ((y - top) * readW + startX - left) * 4;
        data.set(pixels.subarray(start, start + (endX - startX) * 4), (y * width + startX) * 4);
      }
    }
  }

  let debug = `crop ${cropW}x${cropH} -> request ${width}x${height} c4`;
  let mask: Uint8Array | undefined;
  if (withMask) {
    try {
      mask = await readSelectionMask(docId, bounds);
    } catch (e: any) {
      debug += ` | getSelection FAILED: ${e?.message || e}`;
    }
  }
  return { image: { data, width, height, components: 4 }, mask, debug };
}

// Use layerID to isolate the preview and targetSize to cap the pixel read.
export async function readLayerThumbnail(
  docId: number,
  layer: any,
  maxEdge: number,
  lease?: HostModalLease
): Promise<ImageBuffer> {
  const layerId = layer?.id;
  const bounds = boundsFrom(layer?.boundsNoEffects) || boundsFrom(layer?.bounds);
  if (!Number.isFinite(layerId) || !bounds) throw new Error("The selected layer has no previewable pixels.");

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const longest = Math.max(width, height);
  const safeMaxEdge = Math.max(1, Math.round(maxEdge));
  const targetSize =
    longest > safeMaxEdge
      ? width >= height
        ? { width: safeMaxEdge }
        : { height: safeMaxEdge }
      : undefined;

  return await runModal(
    "preview generated layer",
    async () => {
      return copyPixels({ documentID: docId, layerID: layerId, sourceBounds: bounds, targetSize });
    },
    lease
  );
}
