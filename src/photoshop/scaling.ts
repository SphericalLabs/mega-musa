/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type HostModalLease } from "../host-modal";
import { SRGB_PROFILE } from "./document-state";
import { readRegionInModal } from "./pixels";
import { activateDocumentById, app, batchPlay, closeScratchDocument, createScratchDocument, imaging, runModal } from "./runtime";

// Resize the complete image to the proportional dimensions computed by the caller.
// Propagate failures so raster placement can use the JavaScript resize fallback.
export async function scaleViaPhotoshopInModal(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Promise<Uint8Array> {
  const previousDocId = app.activeDocument?.id;
  const scratch = await createScratchDocument({
    width: srcW,
    height: srcH,
    resolution: 72,
    fill: "transparent",
    name: "mm-scale",
    profile: SRGB_PROFILE,
  });
  try {
    await activateDocumentById(scratch.id);
    const layerId = scratch.layers[0].id;
    const srcData = await imaging.createImageDataFromBuffer(rgba, {
      width: srcW,
      height: srcH,
      components: 4,
      componentSize: 8,
      colorSpace: "RGB",
      colorProfile: SRGB_PROFILE,
      chunky: true,
    });
    try {
      await imaging.putPixels({
        documentID: scratch.id,
        layerID: layerId,
        targetBounds: { left: 0, top: 0, right: srcW, bottom: srcH },
        imageData: srcData,
      });
    } finally {
      srcData.dispose();
    }

    const scale = Math.max(dstW / srcW, dstH / srcH);
    if (dstW !== srcW || dstH !== srcH) {
      const method = scale < 1 ? "bicubicSharper" : scale > 1 ? "bicubicSmoother" : "bicubic";
      await batchPlay(
        [
          {
            _obj: "imageSize",
            width: { _unit: "pixelsUnit", _value: dstW },
            height: { _unit: "pixelsUnit", _value: dstH },
            constrainProportions: true,
            interpolation: { _enum: "interpolationType", _value: method },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
    }

    const resizedW = Math.round(scratch.width);
    const resizedH = Math.round(scratch.height);
    if (resizedW !== dstW || resizedH !== dstH) {
      throw new Error("Photoshop's constrained resize did not match the requested full-image dimensions.");
    }

    const { image: { data: raw, width: outputW, height: outputH, components: comps } } = await readRegionInModal(
      scratch.id, { left: 0, top: 0, right: dstW, bottom: dstH }, false
    );
    if (outputW !== dstW || outputH !== dstH) {
      throw new Error("Photoshop returned the wrong full-image dimensions.");
    }

    if (comps === 4) return new Uint8Array(raw);
    // Use opaque alpha when absent. Selection coverage belongs only in the layer mask.
    const px = dstW * dstH;
    const rgbaOut = new Uint8Array(px * 4);
    for (let i = 0; i < px; i++) {
      rgbaOut[i * 4] = raw[i * comps];
      rgbaOut[i * 4 + 1] = raw[i * comps + 1];
      rgbaOut[i * 4 + 2] = raw[i * comps + 2];
      rgbaOut[i * 4 + 3] = 255;
    }
    return rgbaOut;
  } finally {
    try {
      await closeScratchDocument(scratch.id);
    } catch (error) {
      console.log("[Mega Musa] could not close the scaling document:", error);
    }
    if (previousDocId !== undefined) await activateDocumentById(previousDocId);
  }
}

export async function scaleViaPhotoshop(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  lease?: HostModalLease
): Promise<Uint8Array> {
  // Scratch document creation and cleanup also require modal scope.
  return await runModal(
    "scale result",
    () => scaleViaPhotoshopInModal(rgba, srcW, srcH, dstW, dstH),
    lease
  );
}
