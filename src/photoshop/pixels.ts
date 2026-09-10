/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type HostModalLease } from "../host-modal";
import { boundsFrom } from "./geometry";
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
  const cropW = bounds.right - bounds.left;
  const cropH = bounds.bottom - bounds.top;
  const longest = Math.max(cropW, cropH);
  // Masked reads stay full-size so pixel and coverage coordinates align.
  const targetSize =
    !withMask && maxEdge && longest > maxEdge
      ? cropW >= cropH
        ? { width: maxEdge }
        : { height: maxEdge }
      : undefined;
  return await runModal(
    "read region",
    async () => {
      const { data, components, width: imageW, height: imageH } = await copyPixels({
        documentID: docId, sourceBounds: bounds, targetSize,
      });

      let debug = `crop ${cropW}x${cropH}`;
      if (imageW !== cropW || imageH !== cropH) debug += ` -> request ${imageW}x${imageH}`;
      debug += ` c${components}`;
      let mask: Uint8Array | undefined;

      if (withMask) {
        try {
          mask = await readSelectionMask(docId, bounds);
          let covered = 0;
          for (let i = 0; i < mask.length; i++) if (mask[i] > 127) covered++;
          const pct = Math.round((100 * covered) / mask.length);
          debug += ` | selection cover ${pct}%`;
        } catch (e: any) {
          mask = undefined;
          debug += ` | getSelection FAILED: ${e?.message || e}`;
        }
      }

      return { image: { data, width: imageW, height: imageH, components }, mask, debug };
    },
    lease
  );
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
