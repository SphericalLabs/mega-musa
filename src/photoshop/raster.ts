/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { resampleRGBA } from "../images/resample";
import { SRGB_PROFILE } from "./document-state";
import { coverBounds } from "./geometry";
import { bringResultToDocumentFront, renameActiveLayer } from "./layers";
import { applyPlacementMask } from "./masks";
import { activateDocumentById, app, batchPlay, imaging } from "./runtime";
import { scaleViaPhotoshopInModal } from "./scaling";
import { type Bounds, type PlacementClip, type SelectionSnapshot } from "./types";

export async function placeRasterFallback(
  docId: number,
  bounds: Bounds,
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  layerName: string,
  selection: SelectionSnapshot | null
): Promise<{ layer: any; clip: PlacementClip }> {
  // Keep the complete scaled image, including pixels beyond the selection/canvas.
  // Only the editable mask limits which part of that image is visible.
  const fitted = coverBounds(sourceWidth, sourceHeight, bounds);
  const width = fitted.right - fitted.left;
  const height = fitted.bottom - fitted.top;
  let rgba: Uint8Array;
  if (sourceWidth === width && sourceHeight === height) {
    rgba = sourceRgba.slice();
  } else {
    try {
      rgba = await scaleViaPhotoshopInModal(sourceRgba, sourceWidth, sourceHeight, width, height);
    } catch (e: any) {
      console.log("[Mega Musa] Photoshop raster fallback scaling failed; using JS resample:", e?.message || e);
      rgba = resampleRGBA(sourceRgba, sourceWidth, sourceHeight, width, height);
    }
  }

  // A failed scratch operation must never redirect the fallback into another document.
  await activateDocumentById(docId);
  await batchPlay(
    [{ _obj: "make", _target: [{ _ref: "layer" }], _options: { dialogOptions: "dontDisplay" } }],
    {}
  );
  const layer = app.activeDocument.activeLayers[0];
  await renameActiveLayer(layerName);
  await bringResultToDocumentFront(layer);

  const imageData = await imaging.createImageDataFromBuffer(rgba, {
    width,
    height,
    components: 4,
    componentSize: 8,
    colorSpace: "RGB",
    colorProfile: SRGB_PROFILE,
    chunky: true,
  });
  try {
    await imaging.putPixels({
      documentID: docId,
      layerID: layer.id,
      targetBounds: fitted,
      imageData,
    });
  } finally {
    imageData.dispose();
  }
  // Mask errors propagate so history rolls back and Retry Placement keeps the source.
  const clip = await applyPlacementMask(docId, layer.id, fitted, bounds, selection);
  return { layer, clip };
}
