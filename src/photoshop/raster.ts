/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { applyAlphaMask } from "../images/pixels";
import { coverResampleRGBA } from "../images/resample";
import { SRGB_PROFILE } from "./document-state";
import { bringResultToDocumentFront, renameActiveLayer } from "./layers";
import { makeLayerMaskFromSnapshot } from "./masks";
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
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  let rgba: Uint8Array;
  if (sourceWidth === width && sourceHeight === height) {
    rgba = sourceRgba.slice();
  } else {
    try {
      rgba = await scaleViaPhotoshopInModal(sourceRgba, sourceWidth, sourceHeight, width, height);
    } catch (e: any) {
      console.log("[Mega Musa] Photoshop raster fallback scaling failed; using JS resample:", e?.message || e);
      rgba = coverResampleRGBA(sourceRgba, sourceWidth, sourceHeight, width, height);
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

  let clip: PlacementClip = "none";
  let masked = false;
  if (selection) {
    try {
      await makeLayerMaskFromSnapshot(docId, layer.id, selection);
      masked = true;
      clip = "mask";
    } catch (e: any) {
      console.log("[Mega Musa] could not rebuild the editable selection mask; using layer alpha:", e?.message || e);
    }
  }

  if (selection && !masked) {
    if (
      selection.bounds.left !== bounds.left ||
      selection.bounds.top !== bounds.top ||
      selection.bounds.right !== bounds.right ||
      selection.bounds.bottom !== bounds.bottom ||
      selection.data.length !== width * height
    ) {
      throw new Error("The captured selection does not match the result region.");
    }
    applyAlphaMask(rgba, selection.data);
    clip = "alpha";
  }

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
      targetBounds: bounds,
      imageData,
    });
  } finally {
    imageData.dispose();
  }
  return { layer, clip };
}
